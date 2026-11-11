// Old Intrastek mode UI (native calendar, new planning calendar off): the
// right-click menu on a calendar block, its "AERs needed" mini-prompt and the
// Ctrl/⌘+click selection bar. Driven by intrastek-calendar.ts. DOM API only;
// every string from the page or the API goes through textContent.
import { closeAnyOpenMenu } from './dom-inject';
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
import { aersInputEl, bulkTargets, CONFIRM_MS, MAX_AERS, parseAers, prefillAers, type EventInfo } from './intrastek-ui';
import type { IntrastekMe, IntrastekWriteResult } from '../types';

const PROMPT_BACKDROP_CLASS = 'epitools-ik-prompt-backdrop';

function eventTitle(event: EventInfo): string {
  return event.title || t('eventFallback', { id: event.id });
}

function groupOptions(select: HTMLSelectElement, me: IntrastekMe): void {
  for (const group of me.groups) {
    const opt = el('option', undefined, group.name);
    opt.value = group.id;
    select.appendChild(opt);
  }
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
  input.classList.add('epitools-modal-field');
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

// --- Selection bar (Ctrl/⌘+click on blocks in Intrastek mode) ---

const SELBAR_CLASS = 'epitools-ik-selbar';

export function removeSelectionBar(): void {
  const bar = document.querySelector(`.${SELBAR_CLASS}`) as (HTMLElement & { epitoolsClose?: () => void }) | null;
  bar?.epitoolsClose?.();
  bar?.remove();
}

/**
 * Idempotent: creates, updates or (no ids) removes the bar. `ids` are the
 * selected event ids; `onDone(failedIds)` replaces the selection after a bulk
 * write (failures stay selected for a retry).
 */
export function syncSelectionBar(opts: {
  ids: number[];
  me: IntrastekMe | null;
  groupId: string | null;
  onClear: () => void;
  onDone: (failedIds: number[]) => void;
}): void {
  const { ids, me, groupId } = opts;
  let bar = document.querySelector(`.${SELBAR_CLASS}`) as (HTMLElement & { epitoolsClose?: () => void }) | null;
  if (!ids.length) {
    removeSelectionBar();
    return;
  }
  const sig = `${ids.join(',')}|${groupId}|${me ? 1 : 0}|${t('selected', { n: 0 })}`;
  if (bar?.getAttribute('data-epitools-ik-sig') === sig || bar?.hasAttribute('aria-busy')) return;

  // Keep the typed value across re-renders.
  const previous = bar?.querySelector<HTMLInputElement>('input')?.value ?? '';
  if (!bar) {
    bar = el('div', SELBAR_CLASS);
    bar.setAttribute('role', 'toolbar');
    bar.addEventListener('keydown', (ev) => ev.stopPropagation());
    // Escape clears the selection, unless a modal/menu is open (they own it).
    // Not any [role=dialog]: the site's block hover card is one.
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape' && !document.querySelector(`section[role=dialog], .epitools-menu, .${PROMPT_BACKDROP_CLASS}`)) {
        opts.onClear();
      }
    };
    // Capture: the focused calendar block stops Escape before it bubbles. We
    // only observe it (no stopPropagation).
    window.addEventListener('keydown', onKey, true);
    bar.epitoolsClose = () => window.removeEventListener('keydown', onKey, true);
    document.body.appendChild(bar);
  }
  bar.setAttribute('data-epitools-ik-sig', sig);
  bar.replaceChildren(el('strong', undefined, t('selected', { n: ids.length })));
  const clear = button(t('clearSelection'));
  clear.addEventListener('click', opts.onClear);

  if (!me || !groupId || !canWrite(me)) {
    bar.append(
      el('span', 'epitools-ik-hint', !me ? t('loadingOption') : !groupId ? t('keyNoGroup') : t('readOnlyKey')),
      clear,
    );
    return;
  }
  const gid = groupId;
  const who = me;
  bar.append(el('span', 'epitools-ik-hint', groupName(me.groups, gid)));
  const label = el('label', 'epitools-ik-selbar-field');
  const input = aersInputEl();
  input.value = previous;
  input.placeholder = '0';
  label.append(document.createTextNode(t('aersNeeded')), input);
  const status = el('span', 'epitools-ik-hint');
  const setBtn = button(me.isAdmin ? t('applyAll') : t('proposeAll'), 'epitools-modal-primary');
  const removeBtn = button(me.isAdmin ? t('removeAll') : t('proposeRemovalAll'), 'epitools-ik-danger');
  bar.append(label, setBtn, removeBtn, clear, status);

  async function run(kind: 'set' | 'remove', n: number): Promise<void> {
    const targets = bulkTargets(ids, who, gid, kind);
    const skipped = ids.length - targets.length;
    if (!targets.length) {
      toast(t('bulkNothing', { skipped }), 'info');
      return;
    }
    const node = bar as HTMLElement;
    node.setAttribute('aria-busy', 'true');
    for (const b of Array.from(node.querySelectorAll('button, input'))) (b as HTMLButtonElement).disabled = true;
    status.textContent = t('bulkProgress', { done: 0, total: targets.length });
    const { done, failed } = await runWrites(
      targets,
      // Never force: assignations are only dropped from the single-event UI.
      (id) => (kind === 'set' ? api.set(id, gid, n) : api.remove(id, gid)),
      (handled) => (status.textContent = t('bulkProgress', { done: handled, total: targets.length })),
    );
    node.removeAttribute('aria-busy');
    node.removeAttribute('data-epitools-ik-sig');
    const summary = t('bulkSummary', { done, skipped, failed: failed.length });
    toast(failed.length ? `${summary} ${failed[0].message}` : summary, failed.length ? 'error' : 'success');
    opts.onDone(failed.map((f) => f.id));
  }

  setBtn.addEventListener('click', () => {
    const n = parseAers(input.value);
    if (n === null) {
      status.textContent = t('enterRange', { max: MAX_AERS });
      input.focus();
      return;
    }
    void run('set', n);
  });
  armable(removeBtn, () => void run('remove', 0), {
    armedLabel: t('confirmRemoveAll', { n: bulkTargets(ids, who, gid, 'remove').length }),
    ms: CONFIRM_MS,
  });
}
