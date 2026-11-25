import { validConfiguration } from '../metadata.js';
import { formEditor } from './form-editor.js';
import { tableEditor } from './table-editor.js';

const endpoint = '/api/metadata/draft';
const emptyConfig = { schema: [], table: { columns: [] }, form: { items: [] }, query: { filters: [], sort: [] } };

function comparableConfig(config) {
  return JSON.stringify(config, (_, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]]));
  });
}

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
  const layout = formEditor(() => !draft || controls.disabled);
  const table = tableEditor(element('form-builder'));
  const publish = document.createElement('button');
  publish.id = 'schema-publish';
  publish.type = 'button';
  publish.textContent = 'Publish draft';
  publish.disabled = true;
  element('schema-save').after(publish);

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
      syncSchema();
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
    addOption.addEventListener('click', () => {
      appendOption(optionList, addOption, '').focus();
      syncSchema();
    });

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
        syncSchema();
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
    status.textContent = 'Loading draft…';
    try {
      const saved = await api(endpoint, 'GET', true, { signal });
      if (signal.aborted) return;
      draft = { config: saved.config ?? emptyConfig, draftRevision: saved.draftRevision };
      fields.replaceChildren();
      add.disabled = false;
      draft.config.schema.forEach(field => appendField(field));
      layout.load(draft.config.schema, draft.config.form.items);
      table.load(draft.config);
      form.hidden = false;
      reload.hidden = true;
      publish.disabled = draft.draftRevision === 0;
      status.textContent = draft.config.schema.length ? '' : 'Add a field to start the draft.';
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
    syncSchema();
  });
  reload.addEventListener('click', loadDraft);
  fields.addEventListener('input', syncSchema);

  function readSchema() {
    const originalFields = new Map(draft.config.schema.map(field => [field.id, field]));
    return Array.from(fields.children, row => {
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
  }

  function syncSchema() {
    if (!draft) return;
    const schema = readSchema();
    layout.updateSchema(schema);
    table.updateSchema(schema);
  }

  function readConfig() {
    return { ...draft.config, schema: readSchema(), form: { items: layout.readItems() }, ...table.read() };
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!draft || controls.disabled) return;

    const config = readConfig();
    if (!validConfiguration(config)) {
      status.textContent = 'Check field names, select options, form headings, and table filters before saving.';
      return;
    }

    const { signal } = session;
    setPending(true);
    status.textContent = 'Saving draft…';
    try {
      const saved = await api(endpoint, 'PUT', true, { body: { config, draftRevision: draft.draftRevision }, signal });
      if (signal.aborted) return;
      draft = saved;
      fields.querySelectorAll('[data-discard-field]').forEach(button => { button.hidden = true; });
      reload.hidden = true;
      publish.disabled = false;
      status.textContent = 'Draft saved.';
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

  publish.addEventListener('click', async () => {
    if (!draft || publish.disabled || controls.disabled) return;
    if (comparableConfig(readConfig()) !== comparableConfig(draft.config)) {
      status.textContent = 'Save your draft changes before publishing.';
      return;
    }

    const { signal } = session;
    setPending(true);
    status.textContent = 'Publishing draft…';
    try {
      const published = await api('/api/metadata/publish', 'POST', true, {
        body: { draftRevision: draft.draftRevision }, signal,
      });
      if (signal.aborted) return;
      reload.hidden = true;
      status.textContent = 'Draft published.';
      document.dispatchEvent(new CustomEvent('erp:published', { detail: published }));
    } catch (error) {
      if (signal.aborted) return;
      const affected = Array.isArray(error.fields) ? error.fields : [];
      const names = new Map(draft.config.schema.map(field => [field.id, field.label]));
      status.textContent = affected.length
        ? error.message + ' Fields: ' + affected.map(id => names.get(id) ?? id).join(', ')
        : error.message;
      if (error.status === 409 && !affected.length) reload.hidden = false;
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
      layout.clear();
      table.load(emptyConfig);
      publish.disabled = true;
      status.textContent = '';
      section.hidden = !isAdmin;
      session = isAdmin ? new AbortController() : null;
      if (session) loadDraft();
    },
  };
}
