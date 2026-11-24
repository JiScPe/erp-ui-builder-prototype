const fieldId = /^[a-z0-9-]{1,48}$/i;
const filterOperators = {
  text: new Set(['eq', 'ne', 'contains']),
  number: new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
  date: new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
  select: new Set(['eq', 'ne']),
};

function hasKeys(value, ...keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validId(value) {
  return typeof value === 'string' && fieldId.test(value);
}

function validLabel(value) {
  return typeof value === 'string' && value.length <= 100 && value.trim().length > 0;
}

function boundedList(value, limit = 50) {
  return Array.isArray(value) && value.length <= limit;
}

function unique(items) {
  return new Set(items).size === items.length;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validField(field) {
  return hasKeys(field, 'id', 'label', 'type', 'required', 'options') &&
    validId(field.id) && validLabel(field.label) && typeof field.type === 'string' && Object.hasOwn(filterOperators, field.type) &&
    typeof field.required === 'boolean' && boundedList(field.options, 25) &&
    field.options.every(option => typeof option === 'string' && option.length <= 100) &&
    (field.type !== 'select' || field.options.length > 0);
}

function validFormItem(item, fields) {
  if (!item || ![1, 2].includes(item.width)) return false;
  if (item.kind === 'field') {
    return hasKeys(item, 'kind', 'fieldId', 'width') && fields.has(item.fieldId);
  }
  return item.kind === 'heading' && hasKeys(item, 'kind', 'id', 'label', 'width') &&
    validId(item.id) && validLabel(item.label);
}

function validFilter(filter, fields) {
  if (!hasKeys(filter, 'fieldId', 'operator', 'value')) return false;
  const field = fields.get(filter.fieldId);
  if (!field || !filterOperators[field.type].has(filter.operator)) return false;
  if (field.type === 'number') return Number.isFinite(filter.value);
  if (field.type === 'date') return validDate(filter.value);
  if (field.type === 'select') return field.options.includes(filter.value);
  return typeof filter.value === 'string' && filter.value.length <= 2000;
}

export function validConfiguration(config) {
  if (!hasKeys(config, 'schema', 'table', 'form', 'query') ||
      !boundedList(config.schema) || !config.schema.every(validField) ||
      !unique(config.schema.map(field => field.id))) return false;

  const fields = new Map(config.schema.map(field => [field.id, field]));
  const { table, form, query } = config;
  if (!hasKeys(table, 'columns') || !boundedList(table.columns) ||
      !table.columns.every(id => fields.has(id)) || !unique(table.columns)) return false;
  if (!hasKeys(form, 'items') || !boundedList(form.items) ||
      !form.items.every(item => validFormItem(item, fields)) ||
      !unique(form.items.map(item => item.kind === 'field' ? item.fieldId : item.id))) return false;

  return hasKeys(query, 'filters', 'sort') &&
    boundedList(query.filters) && query.filters.every(filter => validFilter(filter, fields)) &&
    boundedList(query.sort) && query.sort.every(sort => hasKeys(sort, 'fieldId', 'direction') &&
      fields.has(sort.fieldId) && ['asc', 'desc'].includes(sort.direction)) &&
    unique(query.sort.map(sort => sort.fieldId));
}

export function layoutFor(config) {
  const fields = new Map(config.schema.map(field => [field.id, field]));
  return config.form.items.map(item => item.kind === 'field'
    ? { ...fields.get(item.fieldId), width: item.width }
    : { id: item.id, label: item.label, type: 'heading', width: item.width, required: false, options: [] });
}

export function validLayout(layout) {
  return boundedList(layout) && unique(layout.map(field => field?.id)) &&
    layout.every(field => field && validId(field.id) &&
      (field.type === 'heading' || typeof field.type === 'string' && Object.hasOwn(filterOperators, field.type)) &&
      validLabel(field.label) && [1, 2].includes(field.width) &&
      typeof field.required === 'boolean' && boundedList(field.options, 25) &&
      field.options.every(option => typeof option === 'string' && option.length <= 100) &&
      (field.type !== 'select' || field.options.length > 0));
}

export function validRecordValues(layout, values) {
  const fields = layout.filter(field => field.type !== 'heading');
  return fields.length > 0 && values !== null && typeof values === 'object' &&
    !Array.isArray(values) && Object.keys(values).length === fields.length &&
    fields.every(field => Object.hasOwn(values, field.id) && validValue(field, values[field.id]));
}

function validValue(field, value) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  if (!value.trim()) return !field.required;
  if (field.type === 'number') return Number.isFinite(Number(value));
  if (field.type === 'date') return validDate(value);
  return field.type !== 'select' || field.options.includes(value);
}
