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
import { EVAL_SHEET_DEFAULT_PRESET_ID, type EvalSheetLayout, type EvalSheetPreset } from '../types';
import { t } from '../i18n/eval-sheet';
import { armable, button, captureEscape, el, errorText, setBusy, spinner } from './shared/ui';

const BACKDROP_CLASS = 'epitools-es-backdrop';
const DELETE_CONFIRM_MS = 3000;

// The built-in preset's name is translated at display (types.ts holds the constant).
function presetName(preset: EvalSheetPreset): string {
  return preset.id === EVAL_SHEET_DEFAULT_PRESET_ID ? t('defaultPreset') : preset.name;
}

interface FieldRow {
  label: string;
  max: string; // raw input value, validated on use
}

// Called on "Download PDF" with the validated layout. The modal is busy
// (spinner + `progress(message)` text) while it runs, closes when it
// resolves, and shows the error (and lets the user retry) when it rejects.
export type EvalSheetSubmit = (layout: EvalSheetLayout, progress: (message: string) => void) => Promise<void>;

let removeEscape: (() => void) | null = null;

export function closeEvalSheetModal(): void {
  removeEscape?.();
  removeEscape = null;
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

  // --- DOM skeleton ---
  const backdrop = el('div', BACKDROP_CLASS);
  const modal = el('div', 'epitools-modal epitools-es-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.appendChild(el('h2', 'epitools-modal-title', t('title')));

  // Preset bar
  const presetBar = el('div', 'epitools-es-preset-bar');
  presetBar.appendChild(el('span', 'epitools-es-label', t('preset')));
  const presetSelect = el('select', 'epitools-modal-field epitools-es-select');
  presetBar.appendChild(presetSelect);
  const modifiedBadge = el('span', 'epitools-es-modified', t('modified'));
  presetBar.appendChild(modifiedBadge);
  const resetBtn = button(t('reset'));
  const updateBtn = button(t('update'));
  const newBtn = button(t('newPreset'));
  const deleteBtn = button(t('delete'), 'epitools-es-danger');
  for (const b of [resetBtn, updateBtn, newBtn, deleteBtn]) presetBar.appendChild(b);
  modal.appendChild(presetBar);

  const newRow = el('div', 'epitools-es-new-row');
  const newName = el('input', 'epitools-modal-field');
  newName.type = 'text';
  newName.placeholder = t('presetName');
  newName.maxLength = 60;
  const createBtn = button(t('create'), 'epitools-modal-primary');
  const cancelNewBtn = button(t('cancel'));
  newRow.append(newName, createBtn, cancelNewBtn);
  newRow.style.display = 'none';
  modal.appendChild(newRow);

  // Orientation
  const orientationRow = el('div', 'epitools-es-row');
  orientationRow.appendChild(el('span', 'epitools-es-label', t('orientation')));
  const radios: Record<EvalSheetLayout['orientation'], HTMLInputElement> = {
    portrait: el('input'),
    landscape: el('input'),
  };
  for (const [value, text] of [
    ['portrait', t('portrait')],
    ['landscape', t('landscape')],
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
  commentLabel.append(commentBox, t('commentColumn'));
  commentBox.addEventListener('change', () => {
    comment = commentBox.checked;
    refresh();
  });
  modal.appendChild(commentLabel);

  // Header
  const headerLabel = el('label', 'epitools-modal-radio-row');
  const headerBox = el('input');
  headerBox.type = 'checkbox';
  headerLabel.append(headerBox, t('minimalHeader'));
  headerBox.addEventListener('change', () => {
    minimalHeader = headerBox.checked;
    refresh();
  });
  modal.appendChild(headerLabel);

  // Fields
  modal.appendChild(el('div', 'epitools-es-label epitools-es-section', t('fields')));
  const fieldList = el('div', 'epitools-es-fields');
  modal.appendChild(fieldList);
  const fieldFooter = el('div', 'epitools-es-row');
  const addBtn = button(t('addField'));
  const fieldHint = el('span', 'epitools-es-hint');
  fieldFooter.append(addBtn, fieldHint);
  modal.appendChild(fieldFooter);

  const error = el('p', 'epitools-modal-error');
  error.style.display = 'none';
  modal.appendChild(error);

  const progress = spinner();
  progress.classList.add('epitools-es-progress');
  progress.style.display = 'none';
  const progressLabel = progress.querySelector('.epitools-loading-label') as HTMLElement;
  modal.appendChild(progress);

  const actions = el('div', 'epitools-modal-actions');
  const cancelBtn = button(t('cancel'));
  const downloadBtn = button(t('download'), 'epitools-modal-primary');
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
  function readLayout(): { layout: EvalSheetLayout | null; message: string; tooMany?: boolean } {
    const fields = rows.map((r) => ({ label: r.label.trim(), max: Number(r.max.trim()) }));
    const bad = fields.findIndex((f) => !isValidField(f));
    if (bad !== -1) {
      return {
        layout: null,
        message: t('invalidField', { index: bad + 1, max: FIELD_LABEL_MAX_LENGTH, limit: FIELD_MAX_LIMIT }),
      };
    }
    const layout: EvalSheetLayout = { orientation, comment, minimalHeader, fields };
    const limit = maxFields(layout, withSlots);
    if (fields.length > limit) {
      return { layout: null, message: t(comment ? 'tooManyFieldsComment' : 'tooManyFields', { limit }), tooMany: true };
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
      const opt = el('option', undefined, presetName(preset));
      opt.value = preset.id;
      presetSelect.appendChild(opt);
    }
    presetSelect.value = state.selectedId;
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
    fieldHint.textContent = t('fieldCount', { count: rows.length, limit }) + (rows.length ? '' : t('noGrades'));
    const { message, tooMany } = readLayout();
    // Only surface validation live once something is wrong with the count;
    // per-field problems are reported on submit to avoid nagging mid-typing.
    if (!message || tooMany) setError(message);
  }

  function renderFields(): void {
    fieldList.replaceChildren();
    rows.forEach((row, index) => {
      const line = el('div', 'epitools-es-field-row');
      const label = el('input', 'epitools-modal-field epitools-es-field-label');
      label.type = 'text';
      label.value = row.label;
      label.placeholder = t('fieldName');
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
      remove.title = t('removeField');
      remove.setAttribute('aria-label', t('removeField'));
      remove.addEventListener('click', () => {
        rows.splice(index, 1);
        renderFields();
      });
      line.append(label, el('span', 'epitools-es-hint', t('outOf')), max, remove);
      fieldList.appendChild(line);
    });
    refresh();
  }

  async function persist(): Promise<void> {
    try {
      await savePresets(state);
    } catch (err) {
      setError(t('saveFailed', { error: errorText(err) }));
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
      setError(t('nameRequired'));
      return;
    }
    if (allPresetsForDisplay(state).some((p) => presetName(p).toLowerCase() === name.toLowerCase())) {
      setError(t('nameTaken'));
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
  const disarmDelete = armable(deleteBtn, () => {
    state = {
      presets: state.presets.filter((p) => p.id !== state.selectedId),
      selectedId: EVAL_SHEET_DEFAULT_PRESET_ID,
    };
    rebuildPresetSelect();
    loadLayout(cloneLayout(getPreset(state, state.selectedId).layout));
    void persist();
  }, { armedLabel: t('confirm'), ms: DELETE_CONFIRM_MS });

  addBtn.addEventListener('click', () => {
    rows.push({ label: '', max: '5' });
    renderFields();
    fieldList.querySelector<HTMLInputElement>('.epitools-es-field-row:last-child .epitools-es-field-label')?.focus();
  });

  // --- Close / submit ---
  // Escape closes only this modal, not the intranet's event modal underneath.
  removeEscape = captureEscape(() => {
    if (!busy) close();
  }, backdrop);

  function close(): void {
    closeEvalSheetModal();
  }

  // Keep our typing away from the site's own keyboard shortcuts/handlers.
  backdrop.addEventListener('keydown', (ev) => ev.stopPropagation());
  backdrop.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (ev.target === backdrop && !busy) close();
  });
  cancelBtn.addEventListener('click', close);

  const controls = (): (HTMLInputElement | HTMLButtonElement | HTMLSelectElement)[] =>
    Array.from(modal.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select'));

  downloadBtn.addEventListener('click', () => {
    const { layout, message } = readLayout();
    if (!layout) {
      setError(message);
      return;
    }
    setError('');
    void persist();
    busy = true;
    const disabled = controls().filter((node) => node !== downloadBtn && !node.disabled);
    for (const node of disabled) node.disabled = true;
    const restore = setBusy(downloadBtn);
    progressLabel.textContent = t('building');
    progress.style.display = '';
    const done = (): void => {
      busy = false;
      restore();
      for (const node of disabled) node.disabled = false;
      progress.style.display = 'none';
    };
    onSubmit(layout, (text) => (progressLabel.textContent = text)).then(
      () => {
        done();
        close();
      },
      (err: unknown) => {
        done();
        setError(t('generateFailed', { error: errorText(err) }));
        refresh();
      },
    );
  });

  rebuildPresetSelect();
  loadLayout(cloneLayout(getPreset(state, state.selectedId).layout));
  downloadBtn.focus();
}
