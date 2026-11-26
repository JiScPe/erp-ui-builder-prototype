import { filterOperators, validFilter } from '../metadata.js';

const limit = 50;
const operatorLabels = {
  eq: 'Equals',
  ne: 'Does not equal',
  contains: 'Contains',
  lt: 'Less than',
  lte: 'Less than or equal to',
  gt: 'Greater than',
  gte: 'Greater than or equal to',
};

function create(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function labeled(name, input) {
  const label = create('label', name);
  label.append(input);
  return label;
}

function setOptions(select, options, current, missingLabel) {
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  if (!options.some(([value]) => value === current)) {
    const missing = new Option(missingLabel, current);
    missing.disabled = true;
    select.prepend(missing);
  }
  select.value = current;
}

function action(name, attr, handleClick, disabled = false) {
  const button = create('button', name);
  button.type = 'button';
  button.setAttribute(attr, '');
  button.disabled = disabled;
  button.addEventListener('click', handleClick);
  return button;
}

function defaultFilter(field) {
  return {
    fieldId: field.id,
    operator: 'eq',
    value: field.type === 'number' ? null : field.type === 'select' ? field.options[0] ?? '' : '',
  };
}

export function tableEditor(formBuilder) {
  const panel = create('div');
  panel.id = 'table-builder';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', 'table-builder-title');
  const style = create('style');
  style.textContent = `
      #table-builder { border-top: 1px solid #dfe5ea; padding-top: 1rem }
      #table-builder h3, #table-builder h4 { margin-block: 0 .6rem }
      #table-builder .table-settings { display: grid; gap: .85rem; grid-template-columns: repeat(2, minmax(0, 1fr)) }
      #table-builder .table-settings > :first-child { grid-column: 1 / -1 }
      #table-builder .table-group { min-width: 0; border: 1px solid #dfe5ea; border-radius: .5rem; padding: .75rem }
      #table-builder ol { display: grid; gap: .5rem; padding: 0; list-style: none }
      #table-builder ol:empty { display: none }
      #table-builder li { padding: .5rem; background: #f6f8fa; border-radius: .35rem; display: grid; gap: .4rem }
      #table-builder li > span { overflow-wrap: anywhere }
      #table-builder button { padding: .35rem .55rem }
      #table-builder select, #table-builder input, #table-builder textarea { min-width: 0; width: 100% }
      #table-builder .filter-error { color: #982636; margin: 0 }
      @media (max-width: 42rem) { #table-builder .table-settings { grid-template-columns: minmax(0, 1fr) } }
  `;
  document.head.append(style);
  panel.innerHTML = `
    <h3 id="table-builder-title">Table Builder</h3>
    <div class="table-settings">
      <div class="table-group" role="group" aria-labelledby="table-columns-title">
        <h4 id="table-columns-title">Columns</h4>
        <ol id="table-columns" aria-label="Column order"></ol>
        <label>Column field<select id="table-column-field"></select></label>
        <div class="actions"><button type="button" id="table-add-column">Add column</button></div>
      </div>
      <div class="table-group" role="group" aria-labelledby="table-filters-title">
        <h4 id="table-filters-title">Filters</h4>
        <ol id="table-filters" aria-label="Filter rules"></ol>
        <button type="button" id="table-add-filter">Add filter</button>
      </div>
      <div class="table-group" role="group" aria-labelledby="table-sort-title">
        <h4 id="table-sort-title">Sort</h4>
        <ol id="table-sort" aria-label="Sort priority"></ol>
        <button type="button" id="table-add-sort">Add sort</button>
      </div>
    </div>
  `;
  formBuilder.after(panel);
  const get = id => panel.querySelector('#' + id);
  const columnRows = get('table-columns');
  const filterRows = get('table-filters');
  const sortRows = get('table-sort');
  const columnField = get('table-column-field');
  const addColumn = get('table-add-column');
  const addFilter = get('table-add-filter');
  const addSort = get('table-add-sort');
  let schema = [];
  let columns = [];
  let filters = [];
  let sort = [];

  function fieldOptions(fields) {
    return fields.map(field => [field.id, field.label || 'Untitled field']);
  }

  function rowActions(items, index, rows, addButton, render, reorder) {
    const actions = create('div');
    actions.className = 'actions';
    function move(offset, attr) {
      const next = index + offset;
      [items[index], items[next]] = [items[next], items[index]];
      render();
      const button = rows.children[next].querySelector('[' + attr + ']');
      (button.disabled ? rows.children[next].querySelector('[data-remove]') : button).focus();
    }
    if (reorder) {
      actions.append(
        action('Move up', 'data-up', () => move(-1, 'data-up'), index === 0),
        action('Move down', 'data-down', () => move(1, 'data-down'), index === items.length - 1),
      );
    }
    actions.append(action('Remove', 'data-remove', () => {
      items.splice(index, 1);
      render();
      const row = rows.children[Math.min(index, rows.children.length - 1)];
      (row?.querySelector('[data-remove]') ?? addButton).focus();
    }));
    return actions;
  }

  function renderColumns() {
    const labels = new Map(fieldOptions(schema));
    columnRows.replaceChildren(...columns.map((id, index) => {
      const row = create('li');
      row.dataset.column = id;
      row.append(create('span', labels.get(id)), rowActions(columns, index, columnRows, addColumn, renderColumns, true));
      return row;
    }));
    const options = fieldOptions(schema.filter(field => !columns.includes(field.id)));
    const selected = options.find(([id]) => id === columnField.value) ?? options[0];
    setOptions(columnField, options, selected?.[0] ?? '', 'No available fields');
    columnField.disabled = addColumn.disabled = !selected;
  }

  function filterInput(field, filter) {
    const input = create(field.type === 'select' ? 'select' : field.type === 'text' ? 'textarea' : 'input');
    input.dataset.value = '';
    if (field.type === 'select') {
      const options = field.options.map(value => [value, value || '(Empty value)']);
      setOptions(input, options, filter.value, 'Choose an option');
    } else {
      if (field.type === 'text') {
        input.rows = 1;
        input.maxLength = 2000;
      } else {
        input.type = field.type;
        if (field.type === 'number') input.step = 'any';
      }
      input.value = filter.value ?? '';
    }
    input.addEventListener('input', () => {
      filter.value = field.type === 'number'
        ? Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null
        : input.value;
    });
    return input;
  }

  function renderFilters() {
    const fields = new Map(schema.map(field => [field.id, field]));
    filterRows.replaceChildren(...filters.map((filter, index) => {
      const row = create('li');
      row.dataset.filter = '';
      const field = fields.get(filter.fieldId);
      const fieldSelect = create('select');
      fieldSelect.dataset.field = '';
      setOptions(fieldSelect, fieldOptions(schema), filter.fieldId, 'Choose a field');
      fieldSelect.addEventListener('change', () => {
        filters[index] = defaultFilter(fields.get(fieldSelect.value));
        renderFilters();
        filterRows.children[index].querySelector('[data-field]').focus();
      });
      const operator = create('select');
      operator.dataset.operator = '';
      setOptions(operator, Array.from(filterOperators[field.type], key => [key, operatorLabels[key]]),
        filter.operator, 'Choose an operator');
      const value = filterInput(field, filter);
      const validation = create('p');
      validation.className = 'filter-error';
      validation.setAttribute('role', 'status');
      function showValidation() {
        const validOperator = filterOperators[field.type].has(filter.operator);
        const valid = validFilter(filter, fields);
        operator.setAttribute('aria-invalid', String(!validOperator));
        value.setAttribute('aria-invalid', String(validOperator && !valid));
        validation.hidden = valid;
        validation.textContent = validOperator ? 'Enter a value that matches this field.' : 'Choose an operator for this field type.';
      }
      operator.addEventListener('change', () => {
        filter.operator = operator.value;
        showValidation();
      });
      value.addEventListener('input', showValidation);
      showValidation();
      row.append(labeled('Filter field', fieldSelect), labeled('Operator', operator), labeled('Value', value),
        validation, rowActions(filters, index, filterRows, addFilter, renderFilters, false));
      return row;
    }));
    addFilter.disabled = !schema.length || filters.length >= limit;
  }

  function unusedSortFields(except) {
    return schema.filter(field => field.id === except || !sort.some(item => item.fieldId === field.id));
  }

  function renderSort() {
    sortRows.replaceChildren(...sort.map((item, index) => {
      const row = create('li');
      row.dataset.sort = '';
      const fieldSelect = create('select');
      fieldSelect.dataset.field = '';
      setOptions(fieldSelect, fieldOptions(unusedSortFields(item.fieldId)), item.fieldId, 'Choose a field');
      fieldSelect.addEventListener('change', () => {
        item.fieldId = fieldSelect.value;
        renderSort();
        sortRows.children[index].querySelector('[data-field]').focus();
      });
      const direction = create('select');
      direction.dataset.direction = '';
      setOptions(direction, [['asc', 'Ascending'], ['desc', 'Descending']], item.direction, 'Choose a direction');
      direction.addEventListener('change', () => { item.direction = direction.value; });
      row.append(labeled('Sort field', fieldSelect), labeled('Direction', direction),
        rowActions(sort, index, sortRows, addSort, renderSort, true));
      return row;
    }));
    addSort.disabled = !unusedSortFields().length;
  }

  addColumn.addEventListener('click', () => {
    if (addColumn.disabled) return;
    columns.push(columnField.value);
    renderColumns();
    (columnField.disabled ? columnRows.lastElementChild.querySelector('[data-remove]') : columnField).focus();
  });
  addFilter.addEventListener('click', () => {
    if (addFilter.disabled) return;
    filters.push(defaultFilter(schema[0]));
    renderFilters();
    filterRows.lastElementChild.querySelector('[data-field]').focus();
  });
  addSort.addEventListener('click', () => {
    if (addSort.disabled) return;
    sort.push({ fieldId: unusedSortFields()[0].id, direction: 'asc' });
    renderSort();
    sortRows.lastElementChild.querySelector('[data-field]').focus();
  });

  function updateSchema(fields) {
    schema = fields;
    const ids = new Set(fields.map(field => field.id));
    columns = columns.filter(id => ids.has(id));
    filters = filters.filter(filter => ids.has(filter.fieldId));
    sort = sort.filter(item => ids.has(item.fieldId));
    renderColumns();
    renderFilters();
    renderSort();
  }

  return {
    load(config) {
      columns = [...config.table.columns];
      filters = config.query.filters.map(filter => ({ ...filter }));
      sort = config.query.sort.map(item => ({ ...item }));
      updateSchema(config.schema);
    },
    updateSchema,
    read() {
      return { table: { columns }, query: { filters, sort } };
    },
  };
}
