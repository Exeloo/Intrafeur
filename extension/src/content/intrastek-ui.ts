// Intrastek, isolated world: the UI pieces (toast, event popup, right-click
// menu, "AERs needed" mini-prompt). DOM API only, no innerHTML; every
// string from the page or the API goes through textContent.
import { closeAnyOpenMenu } from './dom-inject';
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
import type { IntrastekEventState, IntrastekMe, IntrastekWriteResult } from '../types';

const POPUP_BACKDROP_CLASS = 'epitools-ik-backdrop';
const PROMPT_BACKDROP_CLASS = 'epitools-ik-prompt-backdrop';
const TOAST_CLASS = 'epitools-ik-toast';
const CONFIRM_MS = 3000;
const MAX_AERS = 999;

export interface EventInfo {
  id: number;
  title: string;
  start: string | null;
  end: string | null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, className = ''): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  return b;
}

function errorText(err: unknown): string {
  return (err as Error)?.message || String(err);
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

// --- Toast ---

export function toast(
  message: string,
  kind: 'success' | 'error' | 'info' = 'info',
  action?: { label: string; run: () => void },
): void {
  for (const old of Array.from(document.querySelectorAll(`.${TOAST_CLASS}`))) old.remove();
  const node = el('div', `${TOAST_CLASS} ${TOAST_CLASS}--${kind}`);
  node.setAttribute('role', 'status');
  node.appendChild(el('span', undefined, message));
  if (action) {
    const actionBtn = button(action.label, 'epitools-ik-toast-action');
    actionBtn.addEventListener('click', () => {
      node.remove();
      action.run();
    });
    node.appendChild(actionBtn);
  }
  const closeBtn = button('×', 'epitools-ik-toast-close');
  closeBtn.addEventListener('click', () => node.remove());
  node.appendChild(closeBtn);
  document.body.appendChild(node);
  window.setTimeout(() => node.remove(), action ? 10000 : 5000);
}

// Two-click confirm (no blocking confirm()).
function armable(btn: HTMLButtonElement, armedLabel: string, run: () => void): void {
  const label = btn.textContent || '';
  let armedUntil = 0;
  btn.addEventListener('click', () => {
    if (Date.now() > armedUntil) {
      armedUntil = Date.now() + CONFIRM_MS;
      btn.textContent = armedLabel;
      window.setTimeout(() => {
        if (Date.now() >= armedUntil) btn.textContent = label;
      }, CONFIRM_MS);
      return;
    }
    armedUntil = 0;
    btn.textContent = label;
    run();
  });
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
  const writable = canWrite(me);

  const backdrop = el('div', POPUP_BACKDROP_CLASS) as HTMLDivElement & { epitoolsClose?: () => void };
  backdrop.setAttribute('data-epitools-ik-for', String(event.id));
  const modal = el('div', 'epitools-modal epitools-ik-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.appendChild(el('h2', 'epitools-modal-title', 'Intrastek'));
  modal.appendChild(el('div', 'epitools-ik-event-title', event.title || `Event ${event.id}`));
  const when = formatEventDate(event.start, event.end);
  if (when) modal.appendChild(el('div', 'epitools-ik-hint', when));

  // Group
  const groupRow = el('label', 'epitools-ik-row');
  groupRow.appendChild(el('span', 'epitools-ik-label', 'Group'));
  const groupSelect = el('select', 'epitools-modal-field');
  for (const group of me.groups) {
    const opt = el('option', undefined, group.id === me.defaultGroupId ? `${group.name} (my group)` : group.name);
    opt.value = group.id;
    groupSelect.appendChild(opt);
  }
  if (groupId) groupSelect.value = groupId;
  groupRow.appendChild(groupSelect);
  modal.appendChild(groupRow);
  if (!me.groups.length) {
    groupRow.style.display = 'none';
    modal.appendChild(el('p', 'epitools-modal-error', 'Your Intrastek key has no group to target.'));
  }

  // Current state
  modal.appendChild(el('div', 'epitools-ik-label', 'Current state'));
  const stateBox = el('div', 'epitools-ik-state');
  modal.appendChild(stateBox);

  // AERs needed
  const aersRow = el('label', 'epitools-ik-row');
  aersRow.appendChild(el('span', 'epitools-ik-label', 'AERs needed'));
  const aersInput = el('input', 'epitools-modal-field epitools-ik-number');
  aersInput.type = 'number';
  aersInput.min = '0';
  aersInput.max = String(MAX_AERS);
  aersInput.step = '1';
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
      stateBox.appendChild(el('div', 'epitools-ik-hint', 'Loading…'));
      return;
    }
    const groupIds = Array.from(
      new Set([...state.activities.map((a) => a.groupId), ...state.proposals.map((p) => p.groupId)]),
    );
    if (!groupIds.length) {
      stateBox.appendChild(el('div', 'epitools-ik-hint', 'Not initialized in Intrastek, no pending proposal.'));
      return;
    }
    for (const gid of groupIds) {
      const view = groupView(state, gid);
      const line = el('div', 'epitools-ik-state-line');
      line.appendChild(el('strong', undefined, groupName(me.groups, gid)));
      if (view.initialized) {
        const statuses = Array.from(new Set(view.activities.map((a) => a.status))).join('/');
        const assigned = view.activities.reduce((sum, a) => sum + a.assignedCount, 0);
        line.appendChild(
          document.createTextNode(
            ` — ${view.activities.length} activit${view.activities.length > 1 ? 'ies' : 'y'}, ` +
              `${view.nbUserAsk} AER(s) needed, ${statuses}, ${assigned} assigned`,
          ),
        );
      } else {
        line.appendChild(document.createTextNode(' — not initialized'));
      }
      stateBox.appendChild(line);
      for (const p of state.proposals.filter((x) => x.groupId === gid && x.status === 'PENDING')) {
        const pl = el('div', 'epitools-ik-proposal');
        const on = p.eventId !== state.eventId ? ` (on the first event, ${p.eventId})` : '';
        pl.textContent = `⏳ Pending ${p.kind}${on}: ${proposalSummary(p)}, by ${personName(p.proposedBy)}${p.mine ? ' (yours)' : ''}`;
        stateBox.appendChild(pl);
      }
    }
  }

  function readAers(): number | null {
    const n = parseAers(aersInput.value);
    if (n === null) setMessage(`AERs needed must be a whole number between 0 and ${MAX_AERS}.`);
    return n;
  }

  async function perform(
    write: () => Promise<IntrastekWriteResult>,
    done?: string,
    conflict?: 'remove' | 'approve',
  ): Promise<void> {
    if (busy || !groupId) return;
    busy = true;
    setMessage('');
    renderActions();
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
    const closeBtn = button('Close');
    closeBtn.addEventListener('click', close);

    const writeButtons: HTMLButtonElement[] = [];
    let note = '';

    aersInput.disabled = !!view && view.linkedTo !== null;
    if (gid && view && view.linkedTo !== null) {
      note = `This event follows event ${view.linkedTo} of the same activity: set the AERs needed on that one.`;
    } else if (gid && view) {
      if (me.isAdmin) {
        const apply = button('Apply', 'epitools-modal-primary');
        apply.addEventListener('click', () => {
          const n = readAers();
          if (n !== null) void perform(() => api.set(event.id, gid, n));
        });
        writeButtons.push(apply);
        if (view.initialized) {
          const remove = button('Remove', 'epitools-ik-danger');
          armable(remove, 'Confirm remove?', () => void perform(() => api.remove(event.id, gid), undefined, 'remove'));
          writeButtons.push(remove);
          if (forceOffered === 'remove') {
            const force = button('Remove anyway', 'epitools-ik-danger');
            armable(force, 'Confirm (drops assignations)?', () => void perform(() => api.remove(event.id, gid, true)));
            writeButtons.push(force);
          }
        }
        if (view.proposal) {
          const proposal = view.proposal;
          const approve = button('Approve');
          approve.addEventListener('click', () => void perform(() => api.approve(proposal.id), undefined, 'approve'));
          const reject = button('Reject', 'epitools-ik-danger');
          reject.addEventListener('click', () => void perform(() => api.cancel(proposal.id), 'Proposal rejected'));
          writeButtons.push(approve, reject);
          if (forceOffered === 'approve') {
            const force = button('Approve anyway', 'epitools-ik-danger');
            armable(force, 'Confirm (drops assignations)?', () => void perform(() => api.approve(proposal.id, true)));
            writeButtons.push(force);
          }
        }
      } else {
        const proposal = view.proposal;
        const othersPending = !!proposal && !proposal.mine;
        const mine = proposal && proposal.mine ? proposal : null;
        const propose = button(mine ? 'Update my proposal' : 'Propose', 'epitools-modal-primary');
        propose.disabled = othersPending;
        propose.addEventListener('click', () => {
          const n = readAers();
          if (n !== null) void perform(() => api.set(event.id, gid, n));
        });
        writeButtons.push(propose);
        if (view.initialized) {
          const proposeRemoval = button('Propose removal', 'epitools-ik-danger');
          proposeRemoval.disabled = othersPending || mine?.kind === 'REMOVE';
          proposeRemoval.addEventListener('click', () => void perform(() => api.remove(event.id, gid)));
          writeButtons.push(proposeRemoval);
        }
        if (mine) {
          const cancelMine = button('Cancel my proposal');
          cancelMine.addEventListener('click', () => void perform(() => api.cancel(mine.id), 'Proposal cancelled'));
          writeButtons.push(cancelMine);
        }
        if (othersPending && proposal) {
          note = `${personName(proposal.proposedBy)} already has a pending proposal for this group; wait for an admin.`;
        }
      }
    }
    if (!writable) note = 'Your Intrastek key is read-only (no INTRANET_WRITE scope).';

    for (const b of writeButtons) {
      if (!writable || busy || !state) b.disabled = true;
      actions.appendChild(b);
    }
    actions.appendChild(closeBtn);
    if (note && !message.textContent) setMessage(note, 'info');
  }

  function renderAll(): void {
    renderState();
    const view = currentView();
    if (view && !edited) aersInput.value = prefillAers(view);
    aersInput.disabled = busy || !writable || !view;
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

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    // Capture phase + stopPropagation: Escape closes only this popup, not
    // the intranet's event modal underneath.
    ev.stopPropagation();
    ev.preventDefault();
    if (!busy) close();
  }

  function close(): void {
    window.removeEventListener('keydown', onKeydown, true);
    backdrop.remove();
  }
  backdrop.epitoolsClose = () => window.removeEventListener('keydown', onKeydown, true);

  window.addEventListener('keydown', onKeydown, true);
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

export function openAersPrompt(opts: {
  event: EventInfo;
  me: IntrastekMe;
  groupId: string;
  initial: string;
  submitLabel: string;
  onSubmit: (groupId: string, nbUserAsk: number) => void;
}): void {
  for (const node of Array.from(document.querySelectorAll(`.${PROMPT_BACKDROP_CLASS}`))) node.remove();

  const backdrop = el('div', PROMPT_BACKDROP_CLASS);
  const box = el('div', 'epitools-modal epitools-ik-prompt');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.appendChild(el('div', 'epitools-ik-event-title', opts.event.title || `Event ${opts.event.id}`));
  const when = formatEventDate(opts.event.start, opts.event.end);
  if (when) box.appendChild(el('div', 'epitools-ik-hint', when));

  let groupId = opts.groupId;
  if (opts.me.groups.length > 1) {
    const groupRow = el('label', 'epitools-ik-row');
    groupRow.appendChild(el('span', 'epitools-ik-label', 'Group'));
    const select = el('select', 'epitools-modal-field');
    for (const group of opts.me.groups) {
      const opt = el('option', undefined, group.name);
      opt.value = group.id;
      select.appendChild(opt);
    }
    select.value = groupId;
    select.addEventListener('change', () => {
      groupId = select.value;
    });
    groupRow.appendChild(select);
    box.appendChild(groupRow);
  } else {
    box.appendChild(el('div', 'epitools-ik-hint', `Group: ${groupName(opts.me.groups, groupId)}`));
  }

  const row = el('label', 'epitools-ik-row');
  row.appendChild(el('span', 'epitools-ik-label', 'AERs needed'));
  const input = el('input', 'epitools-modal-field epitools-ik-number');
  input.type = 'number';
  input.min = '0';
  input.max = String(MAX_AERS);
  input.step = '1';
  input.value = opts.initial;
  row.appendChild(input);
  box.appendChild(row);

  const error = el('p', 'epitools-modal-error');
  error.style.display = 'none';
  box.appendChild(error);

  const actions = el('div', 'epitools-modal-actions');
  const cancelBtn = button('Cancel');
  const okBtn = button(opts.submitLabel, 'epitools-modal-primary');
  actions.append(cancelBtn, okBtn);
  box.appendChild(actions);
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);

  function close(): void {
    window.removeEventListener('keydown', onKeydown, true);
    backdrop.remove();
  }
  function submit(): void {
    const n = parseAers(input.value);
    if (n === null) {
      error.textContent = `Enter a whole number between 0 and ${MAX_AERS}.`;
      error.style.display = '';
      return;
    }
    close();
    opts.onSubmit(groupId, n);
  }
  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      ev.preventDefault();
      close();
    }
  }
  window.addEventListener('keydown', onKeydown, true);
  backdrop.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });
  backdrop.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.target === backdrop) close();
  });
  cancelBtn.addEventListener('click', close);
  okBtn.addEventListener('click', submit);
  input.focus();
  input.select();
}

// --- Right-click menu on a calendar block (Intrastek mode) ---

export function isOurMenuOpen(): boolean {
  return !!document.querySelector('.epitools-menu[data-epitools-ik-menu]');
}

export function closeOurMenu(): void {
  if (isOurMenuOpen()) closeAnyOpenMenu();
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

  function close(): void {
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('keydown', onKeydown, true);
    menu.remove();
  }
  function onOutside(ev: MouseEvent): void {
    if (!menu.contains(ev.target as Node)) close();
  }
  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
    }
  }
  window.setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  window.addEventListener('keydown', onKeydown, true);

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

  async function doWrite(
    write: () => Promise<IntrastekWriteResult>,
    done?: string,
    onConflict?: () => void,
    conflictLabel = 'Remove anyway',
  ): Promise<void> {
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

  function render(): void {
    menu.replaceChildren();
    menu.appendChild(el('div', 'epitools-ik-menu-title', event.title || `Event ${event.id}`));

    if (me.groups.length > 1) {
      const select = el('select', 'epitools-ik-menu-select');
      for (const group of me.groups) {
        const opt = el('option', undefined, group.name);
        opt.value = group.id;
        select.appendChild(opt);
      }
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
      item('Your key has no group', null);
      item('Open details', opts.onOpenDetails);
      return;
    }
    if (!state) {
      item('Loading…', null);
      item('Open details', opts.onOpenDetails);
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
          `⏳ ${personName(proposal.proposedBy)}${proposal.mine ? ' (you)' : ''}: ${proposalSummary(proposal)}`,
        ),
      );
    }

    const submitLabel = me.isAdmin ? 'Apply' : proposal?.mine ? 'Update my proposal' : 'Propose';
    const head = view.linkedTo;
    if (head !== null) {
      menu.appendChild(el('div', 'epitools-ik-menu-note', `🔗 Part of event ${head} (first): set it there.`));
      item('Edit AERs needed on the first event…', blocked ? null : () =>
        openAersPrompt({
          event: { ...event, id: head },
          me,
          groupId: gid,
          initial: prefillAers(view),
          submitLabel,
          onSubmit: (g, n) => void doWrite(() => api.set(head, g, n)),
        }),
      );
      item('Open details', opts.onOpenDetails);
      return;
    }
    item(view.initialized ? 'Edit AERs needed…' : 'Init…', blocked ? null : () =>
      openAersPrompt({
        event,
        me,
        groupId: gid,
        initial: prefillAers(view),
        submitLabel,
        onSubmit: (g, n) => void doWrite(() => api.set(event.id, g, n)),
      }),
    );

    if (view.initialized) {
      if (me.isAdmin) {
        const force = () => void doWrite(() => api.remove(event.id, gid, true));
        const remove = button('Remove', 'epitools-menu-item epitools-ik-danger');
        if (blocked) remove.disabled = true;
        armable(remove, 'Click again to remove', () => {
          close();
          void doWrite(() => api.remove(event.id, gid), undefined, force);
        });
        menu.appendChild(remove);
      } else {
        item(
          'Propose removal',
          blocked || proposal?.kind === 'REMOVE' ? null : () => void doWrite(() => api.remove(event.id, gid)),
          'epitools-ik-danger',
        );
      }
    }

    if (me.isAdmin && proposal && writable) {
      item('Approve', () =>
        void doWrite(
          () => api.approve(proposal.id),
          undefined,
          () => void doWrite(() => api.approve(proposal.id, true)),
          'Approve anyway',
        ),
      );
      item('Reject', () => void doWrite(() => api.cancel(proposal.id), 'Proposal rejected'), 'epitools-ik-danger');
    }
    if (proposal?.mine && writable) {
      item('Cancel my proposal', () => void doWrite(() => api.cancel(proposal.id), 'Proposal cancelled'));
    }
    item('Open details', opts.onOpenDetails);
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
