// Small modal dialog for the units page "Save filter" flow, mounted under
// <body>. DOM API only (no innerHTML: AMO linter). The .epitools-modal*
// styles (unit-filters.css) are also reused by the eval-sheet modal, which
// has its own backdrop class so closeSaveFilterModal() never removes it.
import { t } from '../i18n/unit-filters';
import { button, captureEscape, el } from './shared/ui';

export type SaveFilterChoice = { mode: 'create'; name: string } | { mode: 'override' };

export interface SaveFilterModalOptions {
  currentPresetName: string;
  isDefaultSelected: boolean;
  onConfirm: (choice: SaveFilterChoice) => void;
}

const BACKDROP_CLASS = 'epitools-modal-backdrop';
let removeEscape: (() => void) | null = null;

export function closeSaveFilterModal(): void {
  removeEscape?.();
  removeEscape = null;
  document.querySelector(`.${BACKDROP_CLASS}`)?.remove();
}

function radioRow(name: string, value: string, label: string): { row: HTMLLabelElement; radio: HTMLInputElement } {
  const row = el('label', 'epitools-modal-radio-row');
  const radio = el('input');
  radio.type = 'radio';
  radio.name = name;
  radio.value = value;
  row.append(radio, label);
  return { row, radio };
}

export function openSaveFilterModal(options: SaveFilterModalOptions): void {
  closeSaveFilterModal();

  const backdrop = el('div', BACKDROP_CLASS);
  const modal = el('div', 'epitools-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.appendChild(el('h2', 'epitools-modal-title', t('saveFilter')));

  const form = el('div', 'epitools-modal-form');
  const create = radioRow('epitools-save-mode', 'create', t('createNew'));
  create.radio.checked = true;
  const nameField = el('input', 'epitools-modal-field');
  nameField.type = 'text';
  nameField.placeholder = t('filterName');
  const override = radioRow('epitools-save-mode', 'override', t('override', { name: options.currentPresetName }));
  override.radio.disabled = options.isDefaultSelected;
  if (options.isDefaultSelected) override.row.classList.add('epitools-modal-radio-disabled');
  const error = el('p', 'epitools-modal-error');
  error.style.display = 'none';
  form.append(create.row, nameField, override.row, error);
  modal.appendChild(form);

  const actions = el('div', 'epitools-modal-actions');
  const cancelBtn = button(t('cancel'));
  const saveBtn = button(t('save'), 'epitools-modal-primary');
  actions.append(cancelBtn, saveBtn);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  nameField.focus();

  removeEscape = captureEscape(closeSaveFilterModal);
  cancelBtn.addEventListener('click', closeSaveFilterModal);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) closeSaveFilterModal();
  });
  create.radio.addEventListener('change', () => {
    if (create.radio.checked) nameField.focus();
  });

  saveBtn.addEventListener('click', () => {
    if (override.radio.checked && !override.radio.disabled) {
      closeSaveFilterModal();
      options.onConfirm({ mode: 'override' });
      return;
    }
    const name = nameField.value.trim();
    if (!name) {
      error.textContent = t('nameRequired');
      error.style.display = '';
      return;
    }
    closeSaveFilterModal();
    options.onConfirm({ mode: 'create', name });
  });
}
