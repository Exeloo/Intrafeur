// Intrastek, isolated world: the UI pieces (event popup, right-click menu,
// "AERs needed" mini-prompt). DOM API only, no innerHTML; every string from
// the page or the API goes through textContent.
import { closeAnyOpenMenu } from './dom-inject';
import { armable, button, captureEscape, el, errorText, setBusy, spinner, toast } from './shared/ui';
import { t } from '../i18n/intrastek';
import {
  api,
  canWrite,
  fetchStatus,
  cachedState,
  formatEventDate,
  groupName,
  groupView,
  IntrastekError,
  personName,
  proposalSummary,
  resultMessage,
  runWrite,
  type GroupView,
} from './intrastek-client';
import type { IntrastekEventState, IntrastekMe, IntrastekProposal, IntrastekWriteResult } from '../types';

const POPUP_BACKDROP_CLASS = 'epitools-ik-backdrop';
const PROMPT_BACKDROP_CLASS = 'epitools-ik-prompt-backdrop';
const CONFIRM_MS = 3000;
const MAX_AERS = 999;

export interface EventInfo {
  id: number;
  title: string;
  start: string | null;
  end: string | null;
}

// "", "-1", "1.5", "abc" -> null; "0".."999" -> number.
function parseAers(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d{1,3}$/.test(value)) return null;
  const n = Number(value);
  return n >= 0 && n <= MAX_AERS ? n : null;
}

function prefillAers(view: GroupView): string {
  if (view.proposal && view.proposal.nbUserAsk !== null) return String(view.proposal.nbUserAsk);
  return view.nbUserAsk !== null ? String(view.nbUserAsk) : '';
}

function eventTitle(event: EventInfo): string {
  return event.title || t('eventFallback', { id: event.id });
}

function kindLabel(p: IntrastekProposal): string {
  return p.kind === 'INIT' ? t('kindInit') : p.kind === 'UPDATE' ? t('kindUpdate') : t('kindRemove');
}

function aersInputEl(): HTMLInputElement {
  const input = el('input', 'epitools-modal-field epitools-ik-number');
  input.type = 'number';
  input.min = '0';
  input.max = String(MAX_AERS);
  input.step = '1';
  return input;
}

function groupOptions(select: HTMLSelectElement, me: IntrastekMe, markOwn = false): void {
  for (const group of me.groups) {
    const own = markOwn && group.id === me.defaultGroupId;
    const opt = el('option', undefined, own ? t('myGroup', { name: group.name }) : group.name);
    opt.value = group.id;
    select.appendChild(opt);
  }
}

// --- Event popup (from the planning event modal's "Intrastek" button) ---

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

  let state: IntrastekEventState | null = cachedState(event.id);
  let groupId = defaultGroupId;
  let edited = false;
  let busy = false;
  // Which write the API refused with a 409 (AERs assigned), offered again with force.
  let forceOffered: 'remove' | 'approve' | null = null;
  let writeButtons: HTMLButtonElement[] = [];
  const writable = canWrite(me);

  const backdrop = el('div', POPUP_BACKDROP_CLASS) as HTMLDivElement & { epitoolsClose?: () => void };
  backdrop.setAttribute('data-epitools-ik-for', String(event.id));
  const modal = el('div', 'epitools-modal epitools-ik-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.appendChild(el('h2', 'epitools-modal-title', 'Intrastek'));
  modal.appendChild(el('div', 'epitools-ik-event-title', eventTitle(event)));
  const when = formatEventDate(event.start, event.end);
  if (when) modal.appendChild(el('div', 'epitools-ik-hint', when));

  const groupRow = el('label', 'epitools-ik-row');
  groupRow.appendChild(el('span', 'epitools-ik-label', t('group')));
  const groupSelect = el('select', 'epitools-modal-field');
  groupOptions(groupSelect, me, true);
  if (groupId) groupSelect.value = groupId;
  groupRow.appendChild(groupSelect);
  modal.appendChild(groupRow);
  if (!me.groups.length) {
    groupRow.style.display = 'none';
    modal.appendChild(el('p', 'epitools-modal-error', t('noGroupToTarget')));
  }

  modal.appendChild(el('div', 'epitools-ik-label', t('currentState')));
  const stateBox = el('div', 'epitools-ik-state');
  modal.appendChild(stateBox);

  const aersRow = el('label', 'epitools-ik-row');
  aersRow.appendChild(el('span', 'epitools-ik-label', t('aersNeeded')));
  const aersInput = aersInputEl();
  aersRow.appendChild(aersInput);
  modal.appendChild(aersRow);

  const message = el('p', 'epitools-ik-message');
  message.style.display = 'none';
  modal.appendChild(message);

  const actions = el('div', 'epitools-modal-actions epitools-ik-actions');
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  mountIn.appendChild(backdrop);

  function setMessage(text: string, kind: 'error' | 'info' = 'error'): void {
    message.textContent = text;
    message.className = `epitools-ik-message epitools-ik-message--${kind}`;
    message.style.display = text ? '' : 'none';
  }

  function currentView(): GroupView | null {
    return state && groupId ? groupView(state, groupId) : null;
  }

  function renderState(): void {
    stateBox.replaceChildren();
    if (!state) {
      stateBox.appendChild(spinner());
      return;
    }
    const groupIds = Array.from(
      new Set([...state.activities.map((a) => a.groupId), ...state.proposals.map((p) => p.groupId)]),
    );
    if (!groupIds.length) {
      stateBox.appendChild(el('div', 'epitools-ik-hint', t('stateEmpty')));
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
    // Not a re-render (that would drop the clicked button's spinner):
    // renderAll() rebuilds everything once the write is done.
    for (const b of writeButtons) b.disabled = true;
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
      renderAll();
    }
  }

  function renderActions(): void {
    actions.replaceChildren();
    const view = currentView();
    const gid = groupId;
    const closeBtn = button(t('close'));
    closeBtn.addEventListener('click', close);

    const buttons: HTMLButtonElement[] = [];
    const add = (b: HTMLButtonElement, run?: () => void): HTMLButtonElement => {
      if (run) b.addEventListener('click', run);
      buttons.push(b);
      return b;
    };
    const confirmed = (b: HTMLButtonElement, armedLabel: string, run: () => void): void => {
      armable(b, run, { armedLabel, ms: CONFIRM_MS });
      buttons.push(b);
    };
    let note = '';

    if (gid && view && view.linkedTo !== null) {
      note = t('followsNote', { id: view.linkedTo });
    } else if (gid && view) {
      if (me.isAdmin) {
        const apply = add(button(t('apply'), 'epitools-modal-primary'), () => {
          const n = readAers();
          if (n !== null) void perform(apply, () => api.set(event.id, gid, n));
        });
        if (view.initialized) {
          const remove = button(t('remove'), 'epitools-ik-danger');
          confirmed(remove, t('confirmRemove'), () =>
            void perform(remove, () => api.remove(event.id, gid), undefined, 'remove'),
          );
          if (forceOffered === 'remove') {
            const force = button(t('removeAnyway'), 'epitools-ik-danger');
            confirmed(force, t('confirmDrop'), () => void perform(force, () => api.remove(event.id, gid, true)));
          }
        }
        if (view.proposal) {
          const proposal = view.proposal;
          const approve = add(button(t('approve')), () =>
            void perform(approve, () => api.approve(proposal.id), undefined, 'approve'),
          );
          const reject = add(button(t('reject'), 'epitools-ik-danger'), () =>
            void perform(reject, () => api.cancel(proposal.id), t('proposalRejected')),
          );
          if (forceOffered === 'approve') {
            const force = button(t('approveAnyway'), 'epitools-ik-danger');
            confirmed(force, t('confirmDrop'), () => void perform(force, () => api.approve(proposal.id, true)));
          }
        }
      } else {
        const proposal = view.proposal;
        const othersPending = !!proposal && !proposal.mine;
        const mine = proposal && proposal.mine ? proposal : null;
        const propose = add(button(mine ? t('updateMine') : t('propose'), 'epitools-modal-primary'), () => {
          const n = readAers();
          if (n !== null) void perform(propose, () => api.set(event.id, gid, n));
        });
        propose.disabled = othersPending;
        if (view.initialized) {
          const proposeRemoval = add(button(t('proposeRemoval'), 'epitools-ik-danger'), () =>
            void perform(proposeRemoval, () => api.remove(event.id, gid)),
          );
          proposeRemoval.disabled = othersPending || mine?.kind === 'REMOVE';
        }
        if (mine) {
          const cancelMine = add(button(t('cancelMine')), () =>
            void perform(cancelMine, () => api.cancel(mine.id), t('proposalCancelled')),
          );
        }
        if (othersPending && proposal) note = t('othersPending', { name: personName(proposal.proposedBy) });
      }
    }
    if (!writable) note = t('readOnlyKey');

    for (const b of buttons) {
      if (!writable || busy || !state) b.disabled = true;
      actions.appendChild(b);
    }
    writeButtons = buttons;
    actions.appendChild(closeBtn);
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

  // Escape closes only this popup, not the intranet's event modal underneath.
  const removeEscape = captureEscape(() => {
    if (!busy) close();
  }, backdrop);
  function close(): void {
    removeEscape();
    backdrop.remove();
  }
  backdrop.epitoolsClose = removeEscape;

  // Keep our typing away from the site's keyboard shortcuts.
  backdrop.addEventListener('keydown', (ev) => ev.stopPropagation());
  backdrop.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.target === backdrop && !busy) close();
  });

  renderAll();
  aersInput.focus();
  // Always fresh: the popup is where decisions are made.
  fetchStatus([event.id], true).then(
    () => {
      if (!backdrop.isConnected) return;
      state = cachedState(event.id);
      renderAll();
    },
    (err: unknown) => {
      if (!backdrop.isConnected) return;
      setMessage(errorText(err));
      renderAll();
    },
  );
}

// --- "AERs needed" mini-prompt (from the right-click menu) ---

function openAersPrompt(opts: {
  event: EventInfo;
  me: IntrastekMe;
  groupId: string;
  initial: string;
  submitLabel: string;
  onSubmit: (groupId: string, nbUserAsk: number) => Promise<void>;
}): void {
  for (const node of Array.from(document.querySelectorAll(`.${PROMPT_BACKDROP_CLASS}`))) node.remove();

  const backdrop = el('div', PROMPT_BACKDROP_CLASS);
  const box = el('div', 'epitools-modal epitools-ik-prompt');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.appendChild(el('div', 'epitools-ik-event-title', eventTitle(opts.event)));
  const when = formatEventDate(opts.event.start, opts.event.end);
  if (when) box.appendChild(el('div', 'epitools-ik-hint', when));

  let groupId = opts.groupId;
  if (opts.me.groups.length > 1) {
    const groupRow = el('label', 'epitools-ik-row');
    groupRow.appendChild(el('span', 'epitools-ik-label', t('group')));
    const select = el('select', 'epitools-modal-field');
    groupOptions(select, opts.me);
    select.value = groupId;
    select.addEventListener('change', () => {
      groupId = select.value;
    });
    groupRow.appendChild(select);
    box.appendChild(groupRow);
  } else {
    box.appendChild(el('div', 'epitools-ik-hint', t('groupHint', { name: groupName(opts.me.groups, groupId) })));
  }

  const row = el('label', 'epitools-ik-row');
  row.appendChild(el('span', 'epitools-ik-label', t('aersNeeded')));
  const input = aersInputEl();
  input.value = opts.initial;
  row.appendChild(input);
  box.appendChild(row);

  const error = el('p', 'epitools-modal-error');
  error.style.display = 'none';
  box.appendChild(error);

  const actions = el('div', 'epitools-modal-actions');
  const cancelBtn = button(t('cancel'));
  const okBtn = button(opts.submitLabel, 'epitools-modal-primary');
  actions.append(cancelBtn, okBtn);
  box.appendChild(actions);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);

  let submitting = false;
  const removeEscape = captureEscape(close, backdrop);
  function close(): void {
    removeEscape();
    backdrop.remove();
  }
  async function submit(): Promise<void> {
    if (submitting) return;
    const n = parseAers(input.value);
    if (n === null) {
      error.textContent = t('enterRange', { max: MAX_AERS });
      error.style.display = '';
      return;
    }
    submitting = true;
    setBusy(okBtn);
    // onSubmit never throws (it toasts its own errors).
    await opts.onSubmit(groupId, n);
    close();
  }
  backdrop.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void submit();
    }
  });
  backdrop.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.target === backdrop) close();
  });
  cancelBtn.addEventListener('click', close);
  okBtn.addEventListener('click', () => void submit());
  input.focus();
  input.select();
}

// --- Right-click menu on a calendar block (Intrastek mode) ---

export function closeOurMenu(): void {
  if (document.querySelector('.epitools-menu[data-epitools-ik-menu]')) closeAnyOpenMenu();
}

export function openBlockMenu(opts: {
  x: number;
  y: number;
  event: EventInfo;
  me: IntrastekMe;
  groupId: string | null;
  onOpenDetails: () => void;
}): void {
  closeAnyOpenMenu();
  const { event, me } = opts;
  let groupId = opts.groupId;
  const writable = canWrite(me);

  const menu = el('div', 'epitools-menu epitools-ik-menu');
  menu.setAttribute('data-epitools-ik-menu', '1');
  menu.style.left = `${opts.x}px`;
  menu.style.top = `${opts.y}px`;
  document.body.appendChild(menu);

  const removeEscape = captureEscape(close, menu);
  function close(): void {
    document.removeEventListener('mousedown', onOutside, true);
    removeEscape();
    menu.remove();
  }
  function onOutside(ev: MouseEvent): void {
    if (!menu.contains(ev.target as Node)) close();
  }
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

  function item(label: string, run: (() => void) | null, className = ''): HTMLButtonElement {
    const b = button(label, `epitools-menu-item ${className}`.trim());
    if (!run) b.disabled = true;
    else
      b.addEventListener('click', () => {
        close();
        run();
      });
    menu.appendChild(b);
    return b;
  }

  // The menu is gone by then: a toast says something is happening, and the
  // result toast replaces it (one toast at a time).
  async function doWrite(
    write: () => Promise<IntrastekWriteResult>,
    done?: string,
    onConflict?: () => void,
    conflictLabel = t('removeAnyway'),
  ): Promise<void> {
    toast(t('saving'), 'info');
    try {
      const res = await runWrite(write);
      toast(done ?? resultMessage(res), 'success');
    } catch (err) {
      if (err instanceof IntrastekError && err.status === 409 && onConflict) {
        toast(errorText(err), 'error', { label: conflictLabel, run: onConflict });
      } else {
        toast(errorText(err), 'error');
      }
    }
  }

  function promptAers(targetId: number, gid: string, view: GroupView, submitLabel: string): void {
    openAersPrompt({
      event: { ...event, id: targetId },
      me,
      groupId: gid,
      initial: prefillAers(view),
      submitLabel,
      onSubmit: (g, n) => doWrite(() => api.set(targetId, g, n)),
    });
  }

  function render(): void {
    menu.replaceChildren();
    menu.appendChild(el('div', 'epitools-ik-menu-title', eventTitle(event)));

    if (me.groups.length > 1) {
      const select = el('select', 'epitools-ik-menu-select');
      groupOptions(select, me);
      if (groupId) select.value = groupId;
      select.addEventListener('change', () => {
        groupId = select.value;
        render();
      });
      menu.appendChild(select);
    }

    const state = cachedState(event.id);
    const gid = groupId;
    if (!gid) {
      item(t('keyNoGroup'), null);
      item(t('openDetails'), opts.onOpenDetails);
      return;
    }
    if (!state) {
      const loading = el('div', 'epitools-ik-menu-loading');
      loading.appendChild(spinner());
      menu.appendChild(loading);
      item(t('openDetails'), opts.onOpenDetails);
      return;
    }
    const view = groupView(state, gid);
    const proposal = view.proposal;
    const othersPending = !me.isAdmin && !!proposal && !proposal.mine;
    const blocked = !writable || othersPending;

    if (proposal) {
      menu.appendChild(
        el(
          'div',
          'epitools-ik-menu-note',
          t('menuProposal', {
            author: personName(proposal.proposedBy),
            you: proposal.mine ? t('you') : '',
            summary: proposalSummary(proposal),
          }),
        ),
      );
    }

    const submitLabel = me.isAdmin ? t('apply') : proposal?.mine ? t('updateMine') : t('propose');
    const head = view.linkedTo;
    if (head !== null) {
      menu.appendChild(el('div', 'epitools-ik-menu-note', t('partOf', { id: head })));
      item(t('editOnFirst'), blocked ? null : () => promptAers(head, gid, view, submitLabel));
      item(t('openDetails'), opts.onOpenDetails);
      return;
    }
    item(view.initialized ? t('editAers') : t('init'), blocked ? null : () => promptAers(event.id, gid, view, submitLabel));

    if (view.initialized) {
      if (me.isAdmin) {
        const force = () => void doWrite(() => api.remove(event.id, gid, true));
        const remove = button(t('remove'), 'epitools-menu-item epitools-ik-danger');
        if (blocked) remove.disabled = true;
        armable(
          remove,
          () => {
            close();
            void doWrite(() => api.remove(event.id, gid), undefined, force);
          },
          { armedLabel: t('clickAgainRemove'), ms: CONFIRM_MS },
        );
        menu.appendChild(remove);
      } else {
        item(
          t('proposeRemoval'),
          blocked || proposal?.kind === 'REMOVE' ? null : () => void doWrite(() => api.remove(event.id, gid)),
          'epitools-ik-danger',
        );
      }
    }

    if (me.isAdmin && proposal && writable) {
      item(t('approve'), () =>
        void doWrite(
          () => api.approve(proposal.id),
          undefined,
          () => void doWrite(() => api.approve(proposal.id, true)),
          t('approveAnyway'),
        ),
      );
      item(t('reject'), () => void doWrite(() => api.cancel(proposal.id), t('proposalRejected')), 'epitools-ik-danger');
    }
    if (proposal?.mine && writable) {
      item(t('cancelMine'), () => void doWrite(() => api.cancel(proposal.id), t('proposalCancelled')));
    }
    item(t('openDetails'), opts.onOpenDetails);
  }

  render();
  // Keep the menu inside the viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, opts.x - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(window.scrollY, opts.y - rect.height)}px`;

  fetchStatus([event.id]).then(
    (fetched) => {
      if (fetched && menu.isConnected) render();
    },
    (err: unknown) => {
      if (!menu.isConnected) return;
      if (!cachedState(event.id)) {
        close();
        toast(errorText(err), 'error');
      }
    },
  );
}
