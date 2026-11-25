import { layoutFor } from '../metadata.js';

const itemLimit = 50;

export function formEditor(isDisabled) {
  const element = id => document.getElementById(id);
  const section = element('form-builder');
  const palette = element('form-palette');
  const canvas = element('form-canvas');
  const list = element('form-items');
  const preview = element('form-preview');
  const previewSection = element('form-preview-section');
  const template = element('form-item-template');
  let schema = [];
  let items = [];
  let drag;
  let dropMarker;

  function renderPalette() {
    const used = new Set(items.filter(item => item.kind === 'field').map(item => item.fieldId));
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.dataset.addHeading = '';
    heading.textContent = 'Add heading';
    heading.draggable = true;
    heading.disabled = items.length >= itemLimit;
    const fields = schema.map(field => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.addField = field.id;
      button.textContent = 'Add ' + (field.label || 'untitled field');
      button.draggable = true;
      button.disabled = used.has(field.id) || items.length >= itemLimit;
      if (used.has(field.id)) button.title = 'This field is already on the form';
      return button;
    });
    palette.replaceChildren(heading, ...fields);
  }

  function renderCanvas() {
    const fields = new Map(schema.map(field => [field.id, field]));
    const rows = items.map((item, index) => {
      const row = template.content.firstElementChild.cloneNode(true);
      row.dataset.formItem = item.kind === 'field' ? item.fieldId : item.id;
      row.dataset.kind = item.kind;
      const name = row.querySelector('[data-form-name]');
      const headingLabel = row.querySelector('[data-heading-label]');
      name.textContent = item.kind === 'field' ? fields.get(item.fieldId)?.label || 'Untitled field' : 'Heading';
      if (item.kind === 'heading') {
        const heading = headingLabel.querySelector('[data-form-heading]');
        heading.value = item.label;
        headingLabel.hidden = false;
        heading.addEventListener('input', () => {
          item.label = heading.value;
          renderPreview();
        });
      } else {
        headingLabel.remove();
      }

      const width = row.querySelector('[data-form-width]');
      width.value = String(item.width);
      width.addEventListener('change', () => {
        item.width = Number(width.value);
        renderPreview();
      });
      row.querySelector('[data-form-up]').disabled = index === 0;
      row.querySelector('[data-form-down]').disabled = index === items.length - 1;
      return row;
    });
    list.replaceChildren(...rows);
    element('form-empty').hidden = items.length > 0;
  }

  function renderPreview() {
    const nodes = layoutFor({ schema, form: { items } }).map(field => {
      if (field.type === 'heading') {
        const heading = document.createElement('h4');
        heading.textContent = field.label;
        heading.dataset.width = String(field.width);
        return heading;
      }

      const label = document.createElement('label');
      label.dataset.width = String(field.width);
      label.textContent = (field.label || 'Untitled field') + (field.required ? ' (required)' : '');
      const input = document.createElement(field.type === 'select' ? 'select' : 'input');
      if (field.type === 'select') {
        const placeholder = new Option('Choose an option', '', true, true);
        placeholder.disabled = true;
        input.add(placeholder);
        field.options.forEach(option => input.add(new Option(option, option)));
      } else {
        input.type = field.type;
      }
      input.required = field.required;
      label.append(input);
      return label;
    });
    preview.replaceChildren(...nodes);
    element('form-preview-empty').hidden = items.length > 0;
  }

  function render() {
    renderPalette();
    renderCanvas();
    renderPreview();
  }

  function insert(component, index) {
    if (isDisabled() || items.length >= itemLimit) return;
    const { fieldId } = component;
    if (fieldId && (!schema.some(field => field.id === fieldId) || items.some(item => item.fieldId === fieldId))) return;

    const item = fieldId
      ? { kind: 'field', fieldId, width: 1 }
      : { kind: 'heading', id: crypto.randomUUID(), label: 'Heading', width: 2 };
    items.splice(index, 0, item);
    render();
    return list.children[index];
  }

  function move(index, destination) {
    if (index < destination) destination -= 1;
    const [item] = items.splice(index, 1);
    items.splice(destination, 0, item);
    render();
    return list.children[destination];
  }

  function paletteComponent(button) {
    return { fieldId: button.dataset.addField };
  }

  palette.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const row = insert(paletteComponent(button), items.length);
    row?.querySelector(button.hasAttribute('data-add-heading') ? '[data-form-heading]' : '[data-form-width]').focus();
  });

  list.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || isDisabled()) return;
    const index = Array.from(list.children).indexOf(button.closest('[data-form-item]'));
    if (button.hasAttribute('data-form-remove')) {
      items.splice(index, 1);
      render();
      const next = list.children[index] ?? list.lastElementChild;
      (next?.querySelector('[data-form-remove]') ?? palette.querySelector('button')).focus();
      return;
    }
    const direction = button.hasAttribute('data-form-up') ? 'up' : 'down';
    const row = move(index, direction === 'up' ? index - 1 : index + 2);
    const movedButton = row.querySelector('[data-form-' + direction + ']');
    (movedButton.disabled ? row.querySelector('[data-form-width]') : movedButton).focus();
  });

  function clearDropMarker() {
    dropMarker?.removeAttribute('data-drop-before');
    dropMarker?.removeAttribute('data-drop-after');
    dropMarker = null;
    canvas.removeAttribute('data-drag-over');
  }

  function dropPosition(event) {
    const row = event.target.closest('[data-form-item]');
    if (!row) return { index: items.length, row };
    const { top, height } = row.getBoundingClientRect();
    const after = event.clientY >= top + height / 2;
    return { index: Array.from(list.children).indexOf(row) + Number(after), row, after };
  }

  section.addEventListener('dragstart', event => {
    const button = event.target.closest('#form-palette button');
    const handle = event.target.closest('[data-form-drag]');
    if (isDisabled() || button?.disabled || (!button && !handle) || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    drag = button ? paletteComponent(button) : {
      index: Array.from(list.children).indexOf(handle.closest('[data-form-item]')),
    };
    event.dataTransfer.effectAllowed = button ? 'copy' : 'move';
    event.dataTransfer.setData('text/plain', 'Form component');
  });

  canvas.addEventListener('dragover', event => {
    if (!drag || isDisabled() || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = drag.index === undefined ? 'copy' : 'move';
    const { row, after } = dropPosition(event);
    clearDropMarker();
    canvas.setAttribute('data-drag-over', '');
    dropMarker = row;
    dropMarker?.setAttribute(after ? 'data-drop-after' : 'data-drop-before', '');
  });

  canvas.addEventListener('dragleave', event => {
    if (!canvas.contains(event.relatedTarget)) clearDropMarker();
  });

  canvas.addEventListener('drop', event => {
    if (!drag || isDisabled()) return;
    event.preventDefault();
    const { index } = dropPosition(event);
    if (drag.index === undefined) insert(drag, index);
    else move(drag.index, index);
    drag = null;
    clearDropMarker();
  });

  section.addEventListener('dragend', () => {
    drag = null;
    clearDropMarker();
  });

  return {
    load(fields, savedItems) {
      schema = fields;
      items = savedItems.map(item => ({ ...item }));
      drag = null;
      clearDropMarker();
      previewSection.hidden = false;
      render();
    },
    clear() {
      schema = [];
      items = [];
      drag = null;
      clearDropMarker();
      previewSection.hidden = true;
      render();
    },
    updateSchema(fields) {
      schema = fields;
      const ids = new Set(fields.map(field => field.id));
      items = items.filter(item => item.kind === 'heading' || ids.has(item.fieldId));
      render();
    },
    readItems() {
      return items;
    },
  };
}
