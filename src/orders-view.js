import { layoutFor, validRecordValues } from '../metadata.js';

const endpoint = '/api/orders';
const element = id => document.getElementById(id);
const orderPath = id => endpoint + '/' + encodeURIComponent(id);
const valuesFrom = (values, id) => Object.hasOwn(values, id) ? values[id] : '';
const showValue = value => value === '' || value == null ? '—' : String(value);
const formFields = config => config ? layoutFor(config) : [];
const canEdit = config => formFields(config).some(field => field.type !== 'heading');

function tagged(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function displayField(field, value) {
  const node = field.type === 'heading'
    ? tagged('h3', field.label)
    : tagged('div', undefined, 'order-value');
  if (field.type !== 'heading') node.append(tagged('strong', field.label), tagged('span', showValue(value)));
  if (field.width) node.dataset.width = String(field.width);
  return node;
}

function editField(field, savedValue) {
  if (field.type === 'heading') return { node: displayField(field) };
  const label = tagged('label', field.label + (field.required ? ' (required)' : ''));
  const control = tagged(field.type === 'select' ? 'select' : 'input');
  const value = typeof savedValue === 'string' ? savedValue : String(savedValue ?? '');
  label.dataset.width = String(field.width);
  control.name = field.id;
  control.dataset.orderField = field.id;
  control.required = field.required;

  if (field.type === 'select') {
    control.append(new Option(field.required ? 'Choose an option' : 'No value', ''));
    control.firstElementChild.disabled = field.required;
    for (const option of field.options) {
      if (option !== '') control.append(new Option(option, option));
    }
  } else {
    control.type = field.type;
    if (field.type === 'text') control.maxLength = 2000;
    if (field.type === 'number') control.step = 'any';
  }
  control.value = value;
  if (field.type === 'number' && value.trim() && !control.value && Number.isFinite(Number(value))) {
    control.value = String(Number(value));
  }
  const acceptedBlank = !field.required && !value.trim();
  if (value && !acceptedBlank && !control.value) {
    const hint = tagged('small', 'Saved value: ' + value + '. Enter a value for the published field.');
    control.setCustomValidity('Enter a value for the published field.');
    control.addEventListener('input', () => control.setCustomValidity(''), { once: true });
    label.append(control, hint);
  } else {
    label.append(control);
  }
  const initialValue = control.value;
  return {
    node: label,
    control,
    read: () => control.value === initialValue && (initialValue || acceptedBlank) ? value : control.value,
  };
}

export function ordersView(api, setNavigationLocked) {
  const dashboard = element('orders-dashboard');
  const dashboardStatus = element('orders-status');
  const newOrder = element('orders-new');
  const refresh = element('orders-refresh');
  const tableWrap = element('orders-table-wrap');
  const { tHead, tBodies: [body] } = element('orders-table');
  const pagination = element('orders-pagination');
  const previous = element('orders-previous');
  const next = element('orders-next');
  const panel = element('order-panel');
  const title = element('order-title');
  const status = element('order-status');
  const detail = element('order-detail');
  const edit = element('order-edit');
  const editor = element('order-editor');
  const controls = element('order-controls');
  const back = element('order-back');
  const confirm = element('order-delete-confirm');
  const confirmDelete = element('order-delete-apply');
  const cancelDelete = element('order-delete-cancel');
  let view;
  let page = 1;

  function setWriting(current, writing) {
    current.writing = writing;
    back.disabled = controls.disabled = confirmDelete.disabled = cancelDelete.disabled = writing;
    setNavigationLocked(writing);
  }

  function changeView(kind, screen = {}) {
    view?.controller.abort();
    if (confirm.open) confirm.close();
    view = kind ? { kind, controller: new AbortController(), ...screen } : undefined;
    dashboard.hidden = kind !== 'dashboard';
    panel.hidden = !kind || kind === 'dashboard';
    detail.hidden = true;
    editor.hidden = true;
    element('order-fields').replaceChildren();
    element('order-values').replaceChildren();
    element('order-other-values').replaceChildren();
    status.textContent = '';
    back.disabled = controls.disabled = confirmDelete.disabled = cancelDelete.disabled = false;
    setNavigationLocked(false);
    return view;
  }

  function dashboardRows(data) {
    const { config, records } = data;
    const fields = new Map((config?.schema ?? []).map(field => [field.id, field]));
    const columns = (config?.table.columns ?? []).map(id => fields.get(id));
    const header = tagged('tr');
    for (const label of [...columns.map(field => field.label), 'Order']) {
      const cell = tagged('th', label);
      cell.scope = 'col';
      header.append(cell);
    }
    tHead.replaceChildren(header);
    body.replaceChildren(...records.map(record => {
      const row = tagged('tr');
      row.dataset.orderId = record.id;
      for (const field of columns) row.append(tagged('td', showValue(valuesFrom(record.values, field.id))));
      const open = tagged('button', 'Open #' + record.id);
      open.type = 'button';
      open.dataset.openOrder = record.id;
      const cell = tagged('td');
      cell.append(open);
      row.append(cell);
      return row;
    }));
    tableWrap.hidden = records.length === 0;
    newOrder.disabled = !canEdit(config);
    pagination.hidden = page === 1 && !data.hasMore;
    previous.disabled = page === 1;
    next.disabled = !data.hasMore;
    element('orders-page').textContent = 'Page ' + page;
  }

  async function showDashboard(requestedPage = 1, message = '', focus = false) {
    page = requestedPage;
    const current = changeView('dashboard');
    if (focus) element('orders-title').focus();
    tableWrap.hidden = pagination.hidden = true;
    tHead.replaceChildren();
    body.replaceChildren();
    newOrder.disabled = refresh.disabled = previous.disabled = next.disabled = true;
    dashboardStatus.textContent = 'Loading orders…';
    try {
      const url = endpoint + '?page=' + page;
      const data = await api(url, 'GET', true, { signal: current.controller.signal });
      if (view !== current) return;
      if (data.records.length === 0 && page > 1) {
        return showDashboard(page - 1, message);
      }
      current.data = data;
      dashboardRows(data);
      dashboardStatus.textContent = [
        message,
        !data.config ? 'An admin can publish the purchase order configuration in Builder.' : '',
        data.records.length === 0 ? 'No purchase orders to show.' : '',
      ].filter(Boolean).join(' ');
    } catch (error) {
      if (view === current) dashboardStatus.textContent = [message, error.message].filter(Boolean).join(' ');
    } finally {
      if (view === current) refresh.disabled = false;
    }
  }

  function showDetail(data, message = '') {
    const { record, config } = data;
    changeView('detail', { data });
    title.textContent = 'Order #' + record.id;
    title.focus();
    const created = new Date(record.createdAt);
    const time = tagged('time', Number.isFinite(created.getTime())
      ? created.toLocaleString()
      : showValue(record.createdAt));
    if (Number.isFinite(created.getTime())) time.dateTime = created.toISOString();
    element('order-created').replaceChildren('Created ', time);
    const layout = formFields(config);
    const visibleIds = new Set(layout.filter(field => field.type !== 'heading').map(field => field.id));
    element('order-values').replaceChildren(...layout.map(field => displayField(field, valuesFrom(record.values, field.id))));
    const labels = new Map((config?.schema ?? []).map(field => [field.id, field.label]));
    const other = Object.entries(record.values).filter(([id]) => !visibleIds.has(id));
    element('order-other-values').replaceChildren(...other.map(([id, value]) => displayField({ label: labels.get(id) ?? id }, value)));
    element('order-other').hidden = other.length === 0;
    element('order-other').open = layout.length === 0;
    edit.disabled = !canEdit(config);
    detail.hidden = false;
    status.textContent = message;
  }

  async function openOrder(id) {
    const current = changeView('loading');
    title.textContent = 'Order #' + id;
    title.focus();
    status.textContent = 'Loading order…';
    try {
      const data = await api(orderPath(id), 'GET', true, { signal: current.controller.signal });
      if (view === current) showDetail(data);
    } catch (error) {
      if (view === current) status.textContent = error.message;
    }
  }

  function showEditor(data, record) {
    const layout = formFields(data.config);
    const fields = layout.map(field => editField(field, valuesFrom(record?.values ?? {}, field.id)));
    changeView(record ? 'edit' : 'new', { data, layout, fields });
    title.textContent = record ? 'Edit order #' + record.id : 'New purchase order';
    element('order-fields').replaceChildren(...fields.map(({ node }) => node));
    editor.hidden = false;
    title.focus();
  }

  async function writeOrder(current, path, method, body, message) {
    setWriting(current, true);
    status.textContent = method === 'DELETE' ? 'Deleting order…' : 'Saving order…';
    try {
      await api(path, method, true, { body, signal: current.controller.signal });
      if (view === current) showDashboard(method === 'POST' ? 1 : page, message, true);
    } catch (error) {
      if (view !== current) return;
      if (confirm.open) confirm.close();
      status.textContent = error.message;
    } finally {
      if (view === current) setWriting(current, false);
    }
  }

  newOrder.addEventListener('click', () => {
    if (view?.kind === 'dashboard' && view.data && canEdit(view.data.config)) showEditor(view.data);
  });
  refresh.addEventListener('click', () => showDashboard(page));
  previous.addEventListener('click', () => showDashboard(page - 1));
  next.addEventListener('click', () => showDashboard(page + 1));
  body.addEventListener('click', event => {
    const open = event.target.closest('[data-open-order]');
    if (open) openOrder(open.dataset.openOrder);
  });
  back.addEventListener('click', () => showDashboard(page, '', true));
  edit.addEventListener('click', () => {
    if (view?.kind === 'detail' && canEdit(view.data.config)) showEditor(view.data, view.data.record);
  });
  element('order-cancel').addEventListener('click', () => {
    if (view?.kind === 'edit') showDetail(view.data);
    else showDashboard(page, '', true);
  });
  editor.addEventListener('submit', event => {
    event.preventDefault();
    const current = view;
    if (!current || current.writing || !['new', 'edit'].includes(current.kind)) return;
    const { data, fields, layout } = current;
    const values = Object.fromEntries(fields.filter(field => field.control).map(field => [field.control.name, field.read()]));
    if (!validRecordValues(layout, values)) {
      status.textContent = 'Check the values and required fields in the published form.';
      return;
    }
    const payload = { revision: data.revision, values };
    if (current.kind === 'edit') {
      writeOrder(current, orderPath(data.record.id), 'PUT', { ...payload, version: data.record.version }, 'Order updated.');
    } else {
      writeOrder(current, endpoint, 'POST', payload, 'Order created.');
    }
  });
  element('order-delete').addEventListener('click', () => {
    if (view?.kind === 'detail' && !view.writing) confirm.showModal();
  });
  cancelDelete.addEventListener('click', () => confirm.close());
  confirm.addEventListener('cancel', event => {
    if (view?.writing) event.preventDefault();
  });
  confirmDelete.addEventListener('click', () => {
    const current = view;
    if (current?.kind !== 'detail' || current.writing) return;
    const { record } = current.data;
    writeOrder(current, orderPath(record.id), 'DELETE', { version: record.version }, 'Order deleted.');
  });
  document.addEventListener('erp:published', () => {
    if (view?.kind === 'dashboard') showDashboard();
  });

  return {
    show() { showDashboard(1, '', true); },
    hide() {
      changeView();
      dashboardStatus.textContent = '';
      tHead.replaceChildren();
      body.replaceChildren();
    },
  };
}
