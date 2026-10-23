// Generic small modal dialog for the "Save filter" flow. No existing modal
// component exists elsewhere in this codebase (dom-inject.ts only has a
// positioned dropdown menu, openFactionMenu/openChecklistMenu) — built from
// scratch here, following the same DOM-API-only construction (no innerHTML;
// the AMO addons-linter flags dynamic innerHTML assignment) already
// established in dom-inject.ts.

export type SaveFilterChoice = { mode: 'create'; name: string } | { mode: 'override' };

export interface SaveFilterModalOptions {
  currentPresetName: string;
  isDefaultSelected: boolean;
  onConfirm: (choice: SaveFilterChoice) => void;
  onCancel: () => void;
}

const BACKDROP_CLASS = 'epitools-modal-backdrop';

export function closeSaveFilterModal(): void {
  document.querySelector(`.${BACKDROP_CLASS}`)?.remove();
}

export function openSaveFilterModal(options: SaveFilterModalOptions): void {
  closeSaveFilterModal();

  const backdrop = document.createElement('div');
  backdrop.className = BACKDROP_CLASS;

  const modal = document.createElement('div');
  modal.className = 'epitools-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const title = document.createElement('h2');
  title.className = 'epitools-modal-title';
  title.textContent = 'Save filter';
  modal.appendChild(title);

  const form = document.createElement('div');
  form.className = 'epitools-modal-form';

  const groupName = 'epitools-save-mode';

  // "Create new" row
  const createRow = document.createElement('label');
  createRow.className = 'epitools-modal-radio-row';
  const createRadio = document.createElement('input');
  createRadio.type = 'radio';
  createRadio.name = groupName;
  createRadio.value = 'create';
  createRadio.checked = true;
  createRow.appendChild(createRadio);
  createRow.appendChild(document.createTextNode('Create new'));
  form.appendChild(createRow);

  const nameField = document.createElement('input');
  nameField.type = 'text';
  nameField.className = 'epitools-modal-field';
  nameField.placeholder = 'Filter name';
  form.appendChild(nameField);

  // "Override" row
  const overrideRow = document.createElement('label');
  overrideRow.className = 'epitools-modal-radio-row';
  if (options.isDefaultSelected) overrideRow.classList.add('epitools-modal-radio-disabled');
  const overrideRadio = document.createElement('input');
  overrideRadio.type = 'radio';
  overrideRadio.name = groupName;
  overrideRadio.value = 'override';
  overrideRadio.disabled = options.isDefaultSelected;
  overrideRow.appendChild(overrideRadio);
  overrideRow.appendChild(document.createTextNode(`Override "${options.currentPresetName}"`));
  form.appendChild(overrideRow);

  const error = document.createElement('p');
  error.className = 'epitools-modal-error';
  error.style.display = 'none';
  form.appendChild(error);

  modal.appendChild(form);

  const actions = document.createElement('div');
  actions.className = 'epitools-modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'epitools-modal-primary';
  saveBtn.textContent = 'Save';

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  nameField.focus();

  function cancel(): void {
    closeSaveFilterModal();
    options.onCancel();
  }

  cancelBtn.addEventListener('click', cancel);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) cancel();
  });
  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      document.removeEventListener('keydown', onKeydown);
      cancel();
    }
  }
  document.addEventListener('keydown', onKeydown);

  createRadio.addEventListener('change', () => {
    if (createRadio.checked) nameField.focus();
  });

  saveBtn.addEventListener('click', () => {
    const mode = overrideRadio.checked && !overrideRadio.disabled ? 'override' : 'create';
    if (mode === 'create') {
      const name = nameField.value.trim();
      if (!name) {
        error.textContent = 'Enter a name for this filter.';
        error.style.display = '';
        return;
      }
      document.removeEventListener('keydown', onKeydown);
      closeSaveFilterModal();
      options.onConfirm({ mode: 'create', name });
      return;
    }
    document.removeEventListener('keydown', onKeydown);
    closeSaveFilterModal();
    options.onConfirm({ mode: 'override' });
  });
}
