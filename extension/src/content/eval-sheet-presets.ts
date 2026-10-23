// Evaluation sheet presets — storage.local, per-browser, same model as the
// units-page filter presets (unit-filters.ts): a synthesized, never-stored
// "Défaut" preset plus user presets, and the last selected preset id.
import browser from 'webextension-polyfill';
import {
  EVAL_SHEET_PRESETS_KEY,
  EVAL_SHEET_SELECTED_KEY,
  EVAL_SHEET_DEFAULT_PRESET_ID,
  EVAL_SHEET_DEFAULT_PRESET_NAME,
  EVAL_SHEET_DEFAULT_LAYOUT,
  type EvalSheetLayout,
  type EvalSheetNoteField,
  type EvalSheetPreset,
} from '../types';

export const FIELD_LABEL_MAX_LENGTH = 40;
export const FIELD_MAX_LIMIT = 1000;

export const DEFAULT_PRESET: EvalSheetPreset = {
  id: EVAL_SHEET_DEFAULT_PRESET_ID,
  name: EVAL_SHEET_DEFAULT_PRESET_NAME,
  layout: EVAL_SHEET_DEFAULT_LAYOUT,
};

export function cloneLayout(layout: EvalSheetLayout): EvalSheetLayout {
  return { ...layout, fields: layout.fields.map((f) => ({ ...f })) };
}

export function isValidField(field: EvalSheetNoteField): boolean {
  const label = field.label.trim();
  return (
    label.length > 0 &&
    label.length <= FIELD_LABEL_MAX_LENGTH &&
    Number.isInteger(field.max) &&
    field.max >= 1 &&
    field.max <= FIELD_MAX_LIMIT
  );
}

function sanitizeLayout(value: unknown): EvalSheetLayout | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<EvalSheetLayout>;
  if (v.orientation !== 'portrait' && v.orientation !== 'landscape') return null;
  if (typeof v.comment !== 'boolean' || !Array.isArray(v.fields)) return null;
  const fields: EvalSheetNoteField[] = [];
  for (const f of v.fields as unknown[]) {
    if (!f || typeof f !== 'object') return null;
    const { label, max } = f as Partial<EvalSheetNoteField>;
    if (typeof label !== 'string' || typeof max !== 'number') return null;
    const field = { label: label.trim(), max };
    if (!isValidField(field)) return null;
    fields.push(field);
  }
  // Missing on presets saved before the option existed: full header.
  if (v.minimalHeader !== undefined && typeof v.minimalHeader !== 'boolean') return null;
  return { orientation: v.orientation, comment: v.comment, minimalHeader: v.minimalHeader === true, fields };
}

function sanitizePresets(value: unknown): EvalSheetPreset[] {
  if (!Array.isArray(value)) return [];
  const out: EvalSheetPreset[] = [];
  for (const p of value) {
    if (!p || typeof p !== 'object') continue;
    const { id, name, layout } = p as Partial<EvalSheetPreset>;
    const clean = sanitizeLayout(layout);
    if (typeof id !== 'string' || typeof name !== 'string' || !name.trim() || !clean) continue;
    if (id === EVAL_SHEET_DEFAULT_PRESET_ID) continue;
    out.push({ id, name: name.trim(), layout: clean });
  }
  return out;
}

export interface PresetState {
  presets: EvalSheetPreset[];
  selectedId: string;
}

export async function loadPresets(): Promise<PresetState> {
  const stored = await browser.storage.local.get({
    [EVAL_SHEET_PRESETS_KEY]: [],
    [EVAL_SHEET_SELECTED_KEY]: EVAL_SHEET_DEFAULT_PRESET_ID,
  });
  const presets = sanitizePresets(stored[EVAL_SHEET_PRESETS_KEY]);
  const selected = stored[EVAL_SHEET_SELECTED_KEY];
  const selectedId =
    typeof selected === 'string' && presets.some((p) => p.id === selected) ? selected : EVAL_SHEET_DEFAULT_PRESET_ID;
  return { presets, selectedId };
}

export async function savePresets(state: PresetState): Promise<void> {
  await browser.storage.local.set({
    [EVAL_SHEET_PRESETS_KEY]: state.presets,
    [EVAL_SHEET_SELECTED_KEY]: state.selectedId,
  });
}

export function getPreset(state: PresetState, id: string): EvalSheetPreset {
  return state.presets.find((p) => p.id === id) ?? DEFAULT_PRESET;
}

export function allPresetsForDisplay(state: PresetState): EvalSheetPreset[] {
  return [DEFAULT_PRESET, ...state.presets];
}

export function layoutsEqual(a: EvalSheetLayout, b: EvalSheetLayout): boolean {
  return (
    a.orientation === b.orientation &&
    a.comment === b.comment &&
    a.minimalHeader === b.minimalHeader &&
    a.fields.length === b.fields.length &&
    a.fields.every((f, i) => f.label.trim() === b.fields[i].label.trim() && f.max === b.fields[i].max)
  );
}
