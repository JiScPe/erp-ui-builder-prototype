import { validConfiguration } from '../metadata.js';

const endpoint = '/api/metadata/draft';
const emptyConfig = { schema: [], table: { columns: [] }, form: { items: [] }, query: { filters: [], sort: [] } };

export function schemaEditor(api) {
  const element = id => document.getElementById(id);
  const section = element('schema-builder');
  const status = element('schema-status');
  const form = element('schema-form');
  const controls = element('schema-controls');
  const fields = element('schema-fields');
  const reload = element('schema-reload');
  const add = element('schema-add');
  const template = element('schema-field-template');
  const optionTemplate = element('schema-option-template');
  const originalOptionValues = new WeakMap();
  let session;
  let draft;

  function appendOption(list, addOption, value) {
    const row = optionTemplate.content.firstElementChild.cloneNode(true);
    const option = row.querySelector('[name="option"]');
    option.value = value;
    originalOptionValues.set(option, value);
    option.addEventListener('input', () => originalOptionValues.delete(option), { once: true });
    row.querySelector('[data-remove-option]').addEventListener('click', () => {
      row.remove();
      addOption.disabled = false;
      addOption.focus();
    });
    list.append(row);
    addOption.disabled = list.children.length >= 25;
    return option;
  }

  function appendField(field, isNew = false) {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.fieldId = field.id;
    const { label, type, required } = row.elements;
    const options = row.querySelector('[data-options]');
    const optionList = options.querySelector('[data-option-list]');
    const addOption = options.querySelector('[data-add-option]');
    const discard = row.querySelector('[data-discard-field]');
    label.value = field.label;
    type.value = field.type;
    required.checked = field.required;
    field.options.forEach(option => appendOption(optionList, addOption, option));
    addOption.addEventListener('click', () => appendOption(optionList, addOption, '').focus());

    function showOptions() {
      options.hidden = type.value !== 'select';
    }
    type.addEventListener('change', showOptions);
    showOptions();
    if (isNew) {
      discard.hidden = false;
      discard.addEventListener('click', () => {
        if (discard.hidden) return;
        row.remove();
        add.disabled = false;
        add.focus();
      });
    }
    fields.append(row);
    add.disabled = fields.children.length >= 50;
    return label;
  }

  function setPending(pending) {
    controls.disabled = pending;
    reload.disabled = pending;
  }

  async function loadDraft() {
    const { signal } = session;
    setPending(true);
    status.textContent = 'Loading schema draft…';
    try {
      const saved = await api(endpoint, 'GET', true, { signal });
      if (signal.aborted) return;
      draft = { config: saved.config ?? emptyConfig, draftRevision: saved.draftRevision };
      fields.replaceChildren();
      add.disabled = false;
      draft.config.schema.forEach(field => appendField(field));
      form.hidden = false;
      reload.hidden = true;
      status.textContent = draft.config.schema.length ? '' : 'Add a field to start the schema draft.';
    } catch (error) {
      if (signal.aborted) return;
      reload.hidden = false;
      status.textContent = error.message;
    } finally {
      if (!signal.aborted) setPending(false);
    }
  }

  add.addEventListener('click', () => {
    appendField({ id: crypto.randomUUID(), label: '', type: 'text', required: false, options: [] }, true).focus();
  });
  reload.addEventListener('click', loadDraft);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!draft || controls.disabled) return;

    const originalFields = new Map(draft.config.schema.map(field => [field.id, field]));
    const schema = Array.from(fields.children, row => {
      const id = row.dataset.fieldId;
      const { label, type, required } = row.elements;
      const original = originalFields.get(id);
      return {
        id,
        label: original && label.value === original.label.replace(/[\r\n]/g, '') ? original.label : label.value.trim(),
        type: type.value,
        required: required.checked,
        options: type.value === 'select'
          ? Array.from(row.querySelectorAll('[name="option"]'), option => originalOptionValues.get(option) ?? option.value)
          : original?.options ?? [],
      };
    });
    const config = { ...draft.config, schema };
    if (!validConfiguration(config)) {
      status.textContent = 'Check field names, select options, and existing query filters before saving.';
      return;
    }

    const { signal } = session;
    setPending(true);
    status.textContent = 'Saving schema draft…';
    try {
      const saved = await api(endpoint, 'PUT', true, { body: { config, draftRevision: draft.draftRevision }, signal });
      if (signal.aborted) return;
      draft = saved;
      fields.querySelectorAll('[data-discard-field]').forEach(button => { button.hidden = true; });
      reload.hidden = true;
      status.textContent = 'Schema draft saved.';
    } catch (error) {
      if (signal.aborted) return;
      if (error.status === 409) {
        reload.hidden = false;
        status.textContent = 'Another admin saved this draft. Reload the saved draft to discard your unsaved edits.';
      } else {
        status.textContent = error.message;
      }
    } finally {
      if (!signal.aborted) setPending(false);
    }
  });

  return {
    setAdmin(isAdmin) {
      session?.abort();
      draft = null;
      form.hidden = true;
      reload.hidden = true;
      fields.replaceChildren();
      status.textContent = '';
      section.hidden = !isAdmin;
      session = isAdmin ? new AbortController() : null;
      if (session) loadDraft();
    },
  };
}
