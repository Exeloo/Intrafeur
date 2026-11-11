// Intrastek, isolated world: the two editors, mounted by the planning board's
// side panel and (the single-event one) by the event modal's popup. DOM API
// only, no innerHTML; every string from the page or the API goes through
// textContent.
import { armable, button, captureEscape, el, errorText, setBusy, spinner, toast } from './shared/ui';
import { t } from '../i18n/intrastek';
import {
  api,
  canWrite,
  cachedState,
  fetchStatus,
  formatEventDate,
  groupName,
  groupView,
  IntrastekError,
  personName,
  proposalSummary,
  resultMessage,
  runWrite,
  runWrites,
  type GroupView,
} from './intrastek-client';
import type { IntrastekEventState, IntrastekMe, IntrastekProposal, IntrastekWriteResult } from '../types';

const POPUP_BACKDROP_CLASS = 'epitools-ik-backdrop';
export const CONFIRM_MS = 3000;
export const MAX_AERS = 999;

export interface EventInfo {
  id: number;
  title: string;
  start: string | null;
  end: string | null;
}

// "", "-1", "1.5", "abc" -> null; "0".."999" -> number.
export function parseAers(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= 0 && n <= MAX_AERS ? n : null;
}

export function prefillAers(view: GroupView): string {
  if (view.proposal && view.proposal.nbUserAsk !== null) return String(view.proposal.nbUserAsk);
  return view.nbUserAsk !== null ? String(view.nbUserAsk) : '';
}

function kindLabel(p: IntrastekProposal): string {
  return p.kind === 'INIT' ? t('kindInit') : p.kind === 'UPDATE' ? t('kindUpdate') : t('kindRemove');
}

export function aersInputEl(): HTMLInputElement {
  const input = el('input', 'epitools-ik-number');
  input.type = 'number';
  input.min = '0';
  input.max = String(MAX_AERS);
  input.step = '1';
  input.inputMode = 'numeric';
  return input;
}

function groupSelectEl(me: IntrastekMe, value: string | null): HTMLSelectElement {
  const select = el('select', 'epitools-ik-select');
  for (const group of me.groups) {
    const own = group.id === me.defaultGroupId;
    const opt = el('option', undefined, own ? t('myGroup', { name: group.name }) : group.name);
    opt.value = group.id;
    select.appendChild(opt);
  }
  if (value) select.value = value;
  return select;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const row = el('label', 'epitools-ik-field');
  row.append(el('span', 'epitools-ik-field-label', label), control);
  return row;
}

// --- Single-event editor ---

/**
 * State of one event in every group + the actions the key allows on the
 * chosen group. Fetches a fresh status itself. Returns the destroyer.
 */
export function mountEventEditor(
  container: HTMLElement,
  event: EventInfo,
  me: IntrastekMe,
  defaultGroupId: string | null,
  opts: { onClose?: () => void; autofocus?: boolean } = {},
): () => void {
  let state: IntrastekEventState | null = cachedState(event.id);
  let groupId = defaultGroupId;
  let edited = false;
  let busy = false;
  let alive = true;
  // Which write the API refused with a 409 (AERs assigned), offered again with force.
  let forceOffered: 'remove' | 'approve' | null = null;
  const writable = canWrite(me);

  const root = el('div', 'epitools-ik-editor');
  const groupSelect = groupSelectEl(me, groupId);
  const stateBox = el('div', 'epitools-ik-state');
  const aersInput = aersInputEl();
  const message = el('p', 'epitools-ik-message');
  const actions = el('div', 'epitools-ik-actions');
  if (me.groups.length) root.appendChild(field(t('group'), groupSelect));
  else root.appendChild(el('p', 'epitools-ik-message epitools-ik-message--error', t('noGroupToTarget')));
  root.append(stateBox, field(t('aersNeeded'), aersInput), message, actions);
  container.appendChild(root);

  function setMessage(text: string, kind: 'error' | 'info' = 'error'): void {
    message.textContent = text;
    message.className = `epitools-ik-message epitools-ik-message--${kind}`;
    message.hidden = !text;
  }
  setMessage('');

  function currentView(): GroupView | null {
    return state && groupId ? groupView(state, groupId) : null;
  }

  function renderState(): void {
    stateBox.replaceChildren();
    if (!state) {
      stateBox.appendChild(spinner());
      return;
    }
    const groupIds = Array.from(new Set([...state.activities.map((a) => a.groupId), ...state.proposals.map((p) => p.groupId)]));
    if (!groupIds.length) {
      stateBox.appendChild(el('div', 'epitools-ik-muted', t('stateEmpty')));
      return;
    }
    for (const gid of groupIds) {
      const view = groupView(state, gid);
      const line = el('div', 'epitools-ik-state-line');
      line.appendChild(el('strong', undefined, groupName(me.groups, gid)));
      if (view.initialized) {
        const count = view.activities.length;
        line.appendChild(
          document.createTextNode(
            t('stateLine', {
              activities: count > 1 ? t('activitiesMany', { n: count }) : t('activitiesOne'),
              n: view.nbUserAsk ?? '?',
              statuses: Array.from(new Set(view.activities.map((a) => a.status))).join('/'),
              assigned: view.activities.reduce((sum, a) => sum + a.assignedCount, 0),
            }),
          ),
        );
      } else {
        line.appendChild(document.createTextNode(t('stateNotInitialized')));
      }
      stateBox.appendChild(line);
      for (const p of state.proposals.filter((x) => x.groupId === gid && x.status === 'PENDING')) {
        stateBox.appendChild(
          el(
            'div',
            'epitools-ik-proposal',
            t('pendingLine', {
              kind: kindLabel(p),
              on: p.eventId !== state.eventId ? t('onFirstEvent', { id: p.eventId }) : '',
              summary: proposalSummary(p),
              author: personName(p.proposedBy),
              yours: p.mine ? t('yours') : '',
            }),
          ),
        );
      }
    }
  }

  function readAers(): number | null {
    const n = parseAers(aersInput.value);
    if (n === null) setMessage(t('aersRange', { max: MAX_AERS }));
    return n;
  }

  async function perform(
    btn: HTMLButtonElement,
    write: () => Promise<IntrastekWriteResult>,
    done?: string,
    conflict?: 'remove' | 'approve',
  ): Promise<void> {
    if (busy || !groupId) return;
    busy = true;
    setMessage('');
    for (const b of Array.from(actions.querySelectorAll('button'))) b.disabled = true;
    setBusy(btn);
    aersInput.disabled = true;
    groupSelect.disabled = true;
    try {
      const res = await runWrite(write);
      state = res.state;
      forceOffered = null;
      edited = false;
      toast(done ?? resultMessage(res), 'success');
    } catch (err) {
      if (err instanceof IntrastekError && err.status === 409 && conflict) forceOffered = conflict;
      setMessage(errorText(err));
    } finally {
      busy = false;
      if (alive) renderAll();
    }
  }

  function renderActions(): void {
    actions.replaceChildren();
    const view = currentView();
    const gid = groupId;
    const buttons: HTMLButtonElement[] = [];
    const add = (label: string, cls: string, run: (b: HTMLButtonElement) => void): HTMLButtonElement => {
      const b = button(label, cls);
      b.addEventListener('click', () => run(b));
      buttons.push(b);
      return b;
    };
    const confirmed = (label: string, armedLabel: string, run: (b: HTMLButtonElement) => void): void => {
      const b = button(label, 'epitools-ik-btn-danger');
      armable(b, () => run(b), { armedLabel, ms: CONFIRM_MS });
      buttons.push(b);
    };
    let note = '';

    if (gid && view && view.linkedTo !== null) {
      note = t('followsNote', { id: view.linkedTo });
    } else if (gid && view) {
      if (me.isAdmin) {
        add(t('apply'), 'epitools-ik-btn-primary', (b) => {
          const n = readAers();
          if (n !== null) void perform(b, () => api.set(event.id, gid, n));
        });
        if (view.initialized) {
          confirmed(t('remove'), t('confirmRemove'), (b) => void perform(b, () => api.remove(event.id, gid), undefined, 'remove'));
          if (forceOffered === 'remove') {
            confirmed(t('removeAnyway'), t('confirmDrop'), (b) => void perform(b, () => api.remove(event.id, gid, true)));
          }
        }
        if (view.proposal) {
          const proposal = view.proposal;
          add(t('approve'), '', (b) => void perform(b, () => api.approve(proposal.id), undefined, 'approve'));
          add(t('reject'), 'epitools-ik-btn-danger', (b) => void perform(b, () => api.cancel(proposal.id), t('proposalRejected')));
          if (forceOffered === 'approve') {
            confirmed(t('approveAnyway'), t('confirmDrop'), (b) => void perform(b, () => api.approve(proposal.id, true)));
          }
        }
      } else {
        const proposal = view.proposal;
        const othersPending = !!proposal && !proposal.mine;
        const mine = proposal && proposal.mine ? proposal : null;
        add(mine ? t('updateMine') : t('propose'), 'epitools-ik-btn-primary', (b) => {
          const n = readAers();
          if (n !== null) void perform(b, () => api.set(event.id, gid, n));
        }).disabled = othersPending;
        if (view.initialized) {
          add(t('proposeRemoval'), 'epitools-ik-btn-danger', (b) => void perform(b, () => api.remove(event.id, gid))).disabled =
            othersPending || mine?.kind === 'REMOVE';
        }
        if (mine) add(t('cancelMine'), '', (b) => void perform(b, () => api.cancel(mine.id), t('proposalCancelled')));
        if (othersPending && proposal) note = t('othersPending', { name: personName(proposal.proposedBy) });
      }
    }
    if (!writable) note = t('readOnlyKey');

    for (const b of buttons) {
      if (!writable || busy || !state) b.disabled = true;
      actions.appendChild(b);
    }
    if (opts.onClose) {
      const closeBtn = button(t('close'));
      closeBtn.addEventListener('click', opts.onClose);
      actions.appendChild(closeBtn);
    }
    if (note && !message.textContent) setMessage(note, 'info');
  }

  function renderAll(): void {
    renderState();
    const view = currentView();
    if (view && !edited) aersInput.value = prefillAers(view);
    aersInput.disabled = busy || !writable || !view || view.linkedTo !== null;
    groupSelect.disabled = busy;
    renderActions();
  }

  groupSelect.addEventListener('change', () => {
    groupId = groupSelect.value || null;
    edited = false;
    forceOffered = null;
    setMessage('');
    renderAll();
  });
  aersInput.addEventListener('input', () => {
    edited = true;
  });
  aersInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    actions.querySelector<HTMLButtonElement>('.epitools-ik-btn-primary:not(:disabled)')?.click();
  });

  renderAll();
  if (opts.autofocus) aersInput.focus();
  // Always fresh: the editor is where decisions are made.
  fetchStatus([event.id], true).then(
    () => {
      if (!alive) return;
      state = cachedState(event.id);
      renderAll();
    },
    (err: unknown) => {
      if (!alive) return;
      setMessage(errorText(err));
      renderAll();
    },
  );

  return () => {
    alive = false;
    root.remove();
  };
}

// --- Bulk editor (several selected events) ---

// Which selected events a bulk write can go to; the rest are skipped (the API
// would refuse them, or the state is unknown).
export function bulkTargets(ids: number[], me: IntrastekMe, gid: string, kind: 'set' | 'remove'): number[] {
  return ids.filter((id) => {
    const state = cachedState(id);
    if (!state) return false;
    const view = groupView(state, gid);
    // Followers: 409 "This event follows event N".
    if (view.linkedTo !== null) return false;
    if (!me.isAdmin && view.proposal && !view.proposal.mine) return false;
    if (kind === 'remove') return view.initialized && !(view.proposal?.mine && view.proposal.kind === 'REMOVE');
    return true;
  });
}

/** `onDone(failedIds)`: the caller replaces the selection (failures stay selected for a retry). */
export function mountBulkEditor(
  container: HTMLElement,
  ids: number[],
  me: IntrastekMe,
  defaultGroupId: string | null,
  onDone: (failedIds: number[]) => void,
): () => void {
  const root = el('div', 'epitools-ik-editor');
  container.appendChild(root);
  if (!canWrite(me)) {
    root.appendChild(el('p', 'epitools-ik-message epitools-ik-message--info', t('readOnlyKey')));
    return () => root.remove();
  }
  if (!me.groups.length) {
    root.appendChild(el('p', 'epitools-ik-message epitools-ik-message--error', t('noGroupToTarget')));
    return () => root.remove();
  }
  let gid = defaultGroupId ?? me.groups[0].id;
  const groupSelect = groupSelectEl(me, gid);
  const input = aersInputEl();
  const status = el('p', 'epitools-ik-message');
  status.hidden = true;
  const actions = el('div', 'epitools-ik-actions');
  const setBtn = button(me.isAdmin ? t('applyAll') : t('proposeAll'), 'epitools-ik-btn-primary');
  const removeBtn = button(me.isAdmin ? t('removeAll') : t('proposeRemovalAll'), 'epitools-ik-btn-danger');
  actions.append(setBtn, removeBtn);
  root.append(field(t('group'), groupSelect), field(t('aersNeeded'), input), status, actions);
  groupSelect.addEventListener('change', () => (gid = groupSelect.value));

  function say(text: string, kind: 'error' | 'info' = 'info'): void {
    status.textContent = text;
    status.className = `epitools-ik-message epitools-ik-message--${kind}`;
    status.hidden = !text;
  }

  async function run(kind: 'set' | 'remove', n: number): Promise<void> {
    const targets = bulkTargets(ids, me, gid, kind);
    const skipped = ids.length - targets.length;
    if (!targets.length) {
      say(t('bulkNothing', { skipped }));
      return;
    }
    for (const node of [setBtn, removeBtn, input, groupSelect]) node.disabled = true;
    say(t('bulkProgress', { done: 0, total: targets.length }));
    const { done, failed } = await runWrites(
      targets,
      // Never force: assignations are only dropped from the single-event editor.
      (id) => (kind === 'set' ? api.set(id, gid, n) : api.remove(id, gid)),
      (handled) => say(t('bulkProgress', { done: handled, total: targets.length })),
    );
    const summary = t('bulkSummary', { done, skipped, failed: failed.length });
    toast(failed.length ? `${summary} ${failed[0].message}` : summary, failed.length ? 'error' : 'success');
    onDone(failed.map((f) => f.id));
  }

  setBtn.addEventListener('click', () => {
    const n = parseAers(input.value);
    if (n === null) {
      say(t('enterRange', { max: MAX_AERS }), 'error');
      input.focus();
      return;
    }
    void run('set', n);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    setBtn.click();
  });
  armable(removeBtn, () => void run('remove', 0), {
    armedLabel: t('confirmRemoveAll', { n: bulkTargets(ids, me, gid, 'remove').length }),
    ms: CONFIRM_MS,
  });
  return () => root.remove();
}

// --- Event modal popup (the modal's "Intrastek" button) ---

export function closeEventPopup(): void {
  for (const node of Array.from(document.querySelectorAll(`.${POPUP_BACKDROP_CLASS}`))) {
    (node as HTMLElement & { epitoolsClose?: () => void }).epitoolsClose?.();
    node.remove();
  }
}

export function isEventPopupOpenFor(dialog: Element, eventId: number): boolean {
  const node = dialog.querySelector(`.${POPUP_BACKDROP_CLASS}`);
  return !!node && node.getAttribute('data-epitools-ik-for') === String(eventId);
}

// Mounted inside the intranet's Mantine dialog (like the eval-sheet modal):
// a popup under <body> would lose focus and wheel events to Mantine's focus
// trap and scroll lock.
export function openEventPopup(mountIn: Element, event: EventInfo, me: IntrastekMe, defaultGroupId: string | null): void {
  closeEventPopup();
  const backdrop = el('div', POPUP_BACKDROP_CLASS) as HTMLDivElement & { epitoolsClose?: () => void };
  backdrop.setAttribute('data-epitools-ik-for', String(event.id));
  const modal = el('div', 'epitools-ik-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Intrastek');
  modal.append(
    el('h2', 'epitools-ik-modal-title', 'Intrastek'),
    el('div', 'epitools-ik-event-title', event.title || t('eventFallback', { id: event.id })),
  );
  const when = formatEventDate(event.start, event.end);
  if (when) modal.appendChild(el('div', 'epitools-ik-muted', when));
  backdrop.appendChild(modal);
  mountIn.appendChild(backdrop);

  // Escape closes only this popup, not the intranet's event modal underneath.
  const removeEscape = captureEscape(close, backdrop);
  const destroy = mountEventEditor(modal, event, me, defaultGroupId, { onClose: close, autofocus: true });
  function close(): void {
    removeEscape();
    destroy();
    backdrop.remove();
  }
  backdrop.epitoolsClose = removeEscape;
  // Keep our typing away from the site's keyboard shortcuts.
  backdrop.addEventListener('keydown', (ev) => ev.stopPropagation());
  backdrop.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.target === backdrop) close();
  });
}
