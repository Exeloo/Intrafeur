// Options modal shown when a "Fiche d'évaluation" button is clicked: page
// orientation, comment column, custom notation fields, and named presets
// (units-page style: a built-in "Défaut" that can't be changed, create /
// update / reset, plus delete). DOM API only — no innerHTML (AMO linter).
//
// Mounted inside the intranet's own Mantine dialog rather than under <body>:
// that dialog runs a focus trap and a scroll lock (react-remove-scroll) that
// would otherwise swallow focus/wheel events aimed at us.
import { maxFields } from './eval-sheet-pdf';
import {
  allPresetsForDisplay,
  cloneLayout,
  getPreset,
  isValidField,
  savePresets,
  FIELD_LABEL_MAX_LENGTH,
  FIELD_MAX_LIMIT,
  type PresetState,
} from './eval-sheet-presets';
import { EVAL_SHEET_DEFAULT_PRESET_ID, type EvalSheetLayout } from '../types';

const BACKDROP_CLASS = 'epitools-es-backdrop';
const DELETE_CONFIRM_MS = 3000;

interface FieldRow {
  label: string;
  max: string; // raw input value, validated on use
}

// Called on "Télécharger le PDF" with the validated layout. The modal is
// busy while it runs, closes when it resolves, and shows the error (and
// lets the user retry) when it rejects.
export type EvalSheetSubmit = (layout: EvalSheetLayout) => Promise<void>;

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

export function closeEvalSheetModal(): void {
  for (const node of Array.from(document.querySelectorAll(`.${BACKDROP_CLASS}`))) node.remove();
}

// withSlots: the sheet will have the slot-time column (whole-event sheet of
// a slot-based event), which leaves less width for notation fields.
export function openEvalSheetModal(
  mountIn: Element,
  presetState: PresetState,
  withSlots: boolean,
  onSubmit: EvalSheetSubmit,
): void {
  closeEvalSheetModal();

  let state: PresetState = { presets: [...presetState.presets], selectedId: presetState.selectedId };
  let orientation: EvalSheetLayout['orientation'] = 'portrait';
  let comment = true;
  let minimalHeader = false;
  let rows: FieldRow[] = [];
  let busy = false;
  let deleteArmedUntil = 0;

  // --- DOM skeleton ---
  const backdrop = el('div', BACKDROP_CLASS);
  const modal = el('div', 'epitools-modal epitools-es-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.appendChild(el('h2', 'epitools-modal-title', "Fiche d'évaluation"));

  // Preset bar
  const presetBar = el('div', 'epitools-es-preset-bar');
  presetBar.appendChild(el('span', 'epitools-es-label', 'Préréglage :'));
  const presetSelect = el('select', 'epitools-modal-field epitools-es-select');
  presetBar.appendChild(presetSelect);
  const modifiedBadge = el('span', 'epitools-es-modified', '(modifié)');
  presetBar.appendChild(modifiedBadge);
  const resetBtn = button('Réinitialiser');
  const updateBtn = button('Mettre à jour');
  const newBtn = button('Nouveau…');
  const deleteBtn = button('Supprimer', 'epitools-es-danger');
  for (const b of [resetBtn, updateBtn, newBtn, deleteBtn]) presetBar.appendChild(b);
  modal.appendChild(presetBar);

  const newRow = el('div', 'epitools-es-new-row');
  const newName = el('input', 'epitools-modal-field');
  newName.type = 'text';
  newName.placeholder = 'Nom du préréglage';
  newName.maxLength = 60;
  const createBtn = button('Créer', 'epitools-modal-primary');
  const cancelNewBtn = button('Annuler');
  newRow.append(newName, createBtn, cancelNewBtn);
  newRow.style.display = 'none';
  modal.appendChild(newRow);

  // Orientation
  const orientationRow = el('div', 'epitools-es-row');
  orientationRow.appendChild(el('span', 'epitools-es-label', 'Orientation :'));
  const radios: Record<EvalSheetLayout['orientation'], HTMLInputElement> = {
    portrait: el('input'),
    landscape: el('input'),
  };
  for (const [value, text] of [
    ['portrait', 'Portrait'],
    ['landscape', 'Paysage (4 étudiants par page)'],
  ] as const) {
    const label = el('label', 'epitools-modal-radio-row');
    const radio = radios[value];
    radio.type = 'radio';
    radio.name = 'epitools-es-orientation';
    radio.value = value;
    label.append(radio, document.createTextNode(text));
    orientationRow.appendChild(label);
    radio.addEventListener('change', () => {
      if (radio.checked) {
        orientation = value;
        refresh();
      }
    });
  }
  modal.appendChild(orientationRow);

  // Comment
  const commentLabel = el('label', 'epitools-modal-radio-row');
  const commentBox = el('input');
  commentBox.type = 'checkbox';
  commentLabel.append(commentBox, document.createTextNode('Colonne « Commentaire »'));
  commentBox.addEventListener('change', () => {
    comment = commentBox.checked;
    refresh();
  });
  modal.appendChild(commentLabel);

  // Header
  const headerLabel = el('label', 'epitools-modal-radio-row');
  const headerBox = el('input');
  headerBox.type = 'checkbox';
  headerLabel.append(headerBox, document.createTextNode('En-tête réduit (module, date et horaire uniquement)'));
  headerBox.addEventListener('change', () => {
    minimalHeader = headerBox.checked;
    refresh();
  });
  modal.appendChild(headerLabel);

  // Fields
  modal.appendChild(el('div', 'epitools-es-label epitools-es-section', 'Champs de notation :'));
  const fieldList = el('div', 'epitools-es-fields');
  modal.appendChild(fieldList);
  const fieldFooter = el('div', 'epitools-es-row');
  const addBtn = button('+ Ajouter un champ');
  const fieldHint = el('span', 'epitools-es-hint');
  fieldFooter.append(addBtn, fieldHint);
  modal.appendChild(fieldFooter);

  const error = el('p', 'epitools-modal-error');
  error.style.display = 'none';
  modal.appendChild(error);

  const actions = el('div', 'epitools-modal-actions');
  const cancelBtn = button('Annuler');
  const downloadBtn = button('Télécharger le PDF', 'epitools-modal-primary');
  actions.append(cancelBtn, downloadBtn);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  mountIn.appendChild(backdrop);

  // --- State helpers ---
  function loadLayout(layout: EvalSheetLayout): void {
    orientation = layout.orientation;
    comment = layout.comment;
    minimalHeader = layout.minimalHeader;
    headerBox.checked = minimalHeader;
    rows = layout.fields.map((f) => ({ label: f.label, max: String(f.max) }));
    radios[orientation].checked = true;
    commentBox.checked = comment;
    renderFields();
  }

  // null when some field is invalid; the error message says which.
  function readLayout(): { layout: EvalSheetLayout | null; message: string } {
    const fields = rows.map((r) => ({ label: r.label.trim(), max: Number(r.max.trim()) }));
    const bad = fields.findIndex((f) => !isValidField(f));
    if (bad !== -1) {
      return {
        layout: null,
        message: `Champ ${bad + 1} : il faut un nom (${FIELD_LABEL_MAX_LENGTH} caractères max) et une note maximale entière entre 1 et ${FIELD_MAX_LIMIT}.`,
      };
    }
    const layout: EvalSheetLayout = { orientation, comment, minimalHeader, fields };
    const limit = maxFields(layout, withSlots);
    if (fields.length > limit) {
      return {
        layout: null,
        message: `Trop de champs pour cette mise en page : ${limit} au maximum${comment ? ' avec la colonne « Commentaire »' : ''}.`,
      };
    }
    return { layout, message: '' };
  }

  // Compared on raw values so a half-typed edit still counts as "modified".
  function isModified(): boolean {
    const preset = getPreset(state, state.selectedId).layout;
    return (
      preset.orientation !== orientation ||
      preset.comment !== comment ||
      preset.minimalHeader !== minimalHeader ||
      preset.fields.length !== rows.length ||
      preset.fields.some((f, i) => f.label !== rows[i].label.trim() || String(f.max) !== rows[i].max.trim())
    );
  }

  function setError(message: string): void {
    error.textContent = message;
    error.style.display = message ? '' : 'none';
  }

  function rebuildPresetSelect(): void {
    presetSelect.replaceChildren();
    for (const preset of allPresetsForDisplay(state)) {
      const opt = el('option', undefined, preset.name);
      opt.value = preset.id;
      presetSelect.appendChild(opt);
    }
    presetSelect.value = state.selectedId;
  }

  function disarmDelete(): void {
    deleteArmedUntil = 0;
    deleteBtn.textContent = 'Supprimer';
  }

  // Cheap UI sync after any change; never rebuilds the field inputs (that
  // would steal focus mid-typing).
  function refresh(): void {
    const isDefault = state.selectedId === EVAL_SHEET_DEFAULT_PRESET_ID;
    const modified = isModified();
    modifiedBadge.style.display = modified ? '' : 'none';
    resetBtn.style.display = modified ? '' : 'none';
    updateBtn.style.display = modified && !isDefault ? '' : 'none';
    deleteBtn.style.display = isDefault ? 'none' : '';
    const limit = maxFields({ orientation, comment }, withSlots);
    addBtn.disabled = busy || rows.length >= limit;
    fieldHint.textContent = `${rows.length} / ${limit} champs`;
    if (!rows.length) fieldHint.textContent += ' (aucune note)';
    const { message } = readLayout();
    // Only surface validation live once something is wrong with the count;
    // per-field problems are reported on submit to avoid nagging mid-typing.
    if (!message || message.startsWith('Trop')) setError(message);
  }

  function renderFields(): void {
    fieldList.replaceChildren();
    rows.forEach((row, index) => {
      const line = el('div', 'epitools-es-field-row');
      const label = el('input', 'epitools-modal-field epitools-es-field-label');
      label.type = 'text';
      label.value = row.label;
      label.placeholder = 'Nom du champ';
      label.maxLength = FIELD_LABEL_MAX_LENGTH;
      label.addEventListener('input', () => {
        row.label = label.value;
        refresh();
      });
      const max = el('input', 'epitools-modal-field epitools-es-field-max');
      max.type = 'number';
      max.min = '1';
      max.max = String(FIELD_MAX_LIMIT);
      max.step = '1';
      max.value = row.max;
      max.addEventListener('input', () => {
        row.max = max.value;
        refresh();
      });
      const remove = button('×', 'epitools-es-remove');
      remove.title = 'Retirer ce champ';
      remove.addEventListener('click', () => {
        rows.splice(index, 1);
        renderFields();
      });
      line.append(label, el('span', 'epitools-es-hint', 'sur'), max, remove);
      fieldList.appendChild(line);
    });
    refresh();
  }

  async function persist(): Promise<void> {
    try {
      await savePresets(state);
    } catch (err) {
      setError(`Impossible d'enregistrer le préréglage : ${(err as Error).message}`);
    }
  }

  // --- Preset actions ---
  presetSelect.addEventListener('change', () => {
    state.selectedId = presetSelect.value;
    disarmDelete();
    loadLayout(cloneLayout(getPreset(state, state.selectedId).layout));
    void persist();
  });

  resetBtn.addEventListener('click', () => {
    setError('');
    loadLayout(cloneLayout(getPreset(state, state.selectedId).layout));
  });

  updateBtn.addEventListener('click', () => {
    const { layout, message } = readLayout();
    if (!layout) {
      setError(message);
      return;
    }
    state = {
      ...state,
      presets: state.presets.map((p) => (p.id === state.selectedId ? { ...p, layout: cloneLayout(layout) } : p)),
    };
    setError('');
    refresh();
    void persist();
  });

  newBtn.addEventListener('click', () => {
    newRow.style.display = '';
    newName.value = '';
    newName.focus();
  });

  cancelNewBtn.addEventListener('click', () => {
    newRow.style.display = 'none';
  });

  function createPreset(): void {
    const name = newName.value.trim();
    const { layout, message } = readLayout();
    if (!name) {
      setError('Donnez un nom au préréglage.');
      return;
    }
    if (allPresetsForDisplay(state).some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      setError('Un préréglage porte déjà ce nom.');
      return;
    }
    if (!layout) {
      setError(message);
      return;
    }
    const preset = { id: crypto.randomUUID(), name, layout: cloneLayout(layout) };
    state = { presets: [...state.presets, preset], selectedId: preset.id };
    newRow.style.display = 'none';
    setError('');
    rebuildPresetSelect();
    refresh();
    void persist();
  }

  createBtn.addEventListener('click', createPreset);
  newName.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      createPreset();
    }
  });

  // Two-step delete instead of a blocking confirm() dialog.
  deleteBtn.addEventListener('click', () => {
    if (Date.now() > deleteArmedUntil) {
      deleteArmedUntil = Date.now() + DELETE_CONFIRM_MS;
      deleteBtn.textContent = 'Confirmer ?';
      window.setTimeout(() => {
        if (Date.now() >= deleteArmedUntil) disarmDelete();
      }, DELETE_CONFIRM_MS);
      return;
    }
    disarmDelete();
    state = {
      presets: state.presets.filter((p) => p.id !== state.selectedId),
      selectedId: EVAL_SHEET_DEFAULT_PRESET_ID,
    };
    rebuildPresetSelect();
    loadLayout(cloneLayout(getPreset(state, state.selectedId).layout));
    void persist();
  });

  addBtn.addEventListener('click', () => {
    rows.push({ label: '', max: '5' });
    renderFields();
    fieldList.querySelector<HTMLInputElement>('.epitools-es-field-row:last-child .epitools-es-field-label')?.focus();
  });

  // --- Close / submit ---
  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    // Capture phase + stopPropagation: Escape must close only this modal,
    // not the intranet's event modal underneath.
    ev.stopPropagation();
    ev.preventDefault();
    if (!busy) cancel();
  }

  function close(): void {
    window.removeEventListener('keydown', onKeydown, true);
    backdrop.remove();
  }

  function cancel(): void {
    close();
  }

  window.addEventListener('keydown', onKeydown, true);
  // Keep our typing away from the site's own keyboard shortcuts/handlers.
  backdrop.addEventListener('keydown', (ev) => ev.stopPropagation());
  backdrop.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.target === backdrop && !busy) cancel();
  });
  cancelBtn.addEventListener('click', cancel);

  downloadBtn.addEventListener('click', () => {
    const { layout, message } = readLayout();
    if (!layout) {
      setError(message);
      return;
    }
    setError('');
    void persist();
    setBusy('Génération…');
    onSubmit(layout).then(close, (err: unknown) =>
      showError(`La génération du PDF a échoué : ${(err as Error)?.message || err}`),
    );
  });

  function setBusy(label: string): void {
    busy = true;
    downloadBtn.textContent = label;
    for (const node of Array.from(modal.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
      'input, button, select',
    ))) {
      node.disabled = true;
    }
  }

  function showError(message: string): void {
    busy = false;
    for (const node of Array.from(modal.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
      'input, button, select',
    ))) {
      node.disabled = false;
    }
    downloadBtn.textContent = 'Télécharger le PDF';
    setError(message);
    refresh();
  }

  rebuildPresetSelect();
  loadLayout(cloneLayout(getPreset(state, state.selectedId).layout));
  downloadBtn.focus();
}
