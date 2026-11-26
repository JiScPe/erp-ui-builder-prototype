import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const target = new URL(process.env.ERP_PREVIEW_ORIGIN);
assert(target.protocol === 'https:' && !target.username && !target.password &&
  /^[a-z0-9-]+-erp-ui-builder-prototype\.[a-z0-9-]+\.workers\.dev$/.test(target.hostname),
  'Set ERP_PREVIEW_ORIGIN to this Worker’s named Cloudflare Preview');
const origin = target.origin;
const sessions = [];
const orders = new Set();

function request(path, { method = 'GET', body, cookie, token } = {}) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(origin + path, {
    method, headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
  });
}

async function data(path, options) {
  const response = await request(path, options);
  assert(response.ok, (options?.method ?? 'GET') + ' ' + path + ' returned HTTP ' + response.status);
  return response.status === 204 ? null : response.json();
}

async function signIn(kind, role) {
  const email = process.env['ERP_SMOKE_' + kind + '_EMAIL'];
  const password = process.env['ERP_SMOKE_' + kind + '_PASSWORD'];
  assert(email && password, 'Set the test email and password for ' + kind);
  const response = await request('/api/auth/sign-in/email', { method: 'POST', body: { email, password } });
  assert(response.ok, 'Sign-in returned HTTP ' + response.status + ' for ' + kind);
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  assert(cookie, 'No session cookie returned for ' + kind);
  sessions.push(cookie);
  const { token } = await data('/api/auth/token', { cookie });
  assert(token, 'No token returned for ' + kind);
  const session = await data('/api/session', { token });
  assert.equal(session.role, role);
  return token;
}

const config = {
  schema: [
    { id: 'smoke-reference', label: 'Reference', type: 'text', required: true, options: [] },
    { id: 'smoke-total', label: 'Total', type: 'number', required: true, options: [] },
  ],
  table: { columns: ['smoke-reference', 'smoke-total'] },
  form: { items: [
    { kind: 'heading', id: 'smoke-heading', label: 'Order details', width: 2 },
    { kind: 'field', fieldId: 'smoke-reference', width: 1 },
    { kind: 'field', fieldId: 'smoke-total', width: 1 },
  ] },
  query: {
    filters: [{ fieldId: 'smoke-reference', operator: 'contains', value: 'Smoke visible' }],
    sort: [{ fieldId: 'smoke-total', direction: 'desc' }],
  },
};

let user;
const failures = [];
try {
  const auth = await data('/api/config');
  assert.equal(auth.authUrl, origin + '/api/auth');
  assert.equal((await request('/api/orders')).status, 401);
  const admin = await signIn('ADMIN', 'admin');
  user = await signIn('USER', 'user');
  console.log('PASS Neon Auth and both ERP roles');

  const prior = await data('/api/orders', { token: user });
  const { records } = await data('/api/state', { token: user });
  assert.equal(records.length, 0, 'Use an isolated database with no orders');
  assert(!prior.config || isDeepStrictEqual(prior.config, config),
    'Use a database without unrelated published metadata');
  const draft = await data('/api/metadata/draft', { token: admin });
  assert(!draft.config || isDeepStrictEqual(draft.config, config),
    'Use a database without unrelated draft metadata');
  assert.equal((await request('/api/metadata/draft', { token: user })).status, 403);
  const saved = await data('/api/metadata/draft', {
    method: 'PUT', token: admin, body: { config, draftRevision: draft.draftRevision },
  });
  assert.deepEqual((await data('/api/orders', { token: user })).config, prior.config);
  const published = await data('/api/metadata/publish', {
    method: 'POST', token: admin, body: { draftRevision: saved.draftRevision },
  });
  assert.deepEqual((await data('/api/orders', { token: user })).config, config);
  console.log('PASS Draft stays private until Admin publishes the complete configuration');

  const values = (reference, total) => ({ 'smoke-reference': reference, 'smoke-total': total });
  async function create(reference, total) {
    const { record } = await data('/api/orders', {
      method: 'POST', token: user, body: { revision: published.revision, values: values(reference, total) },
    });
    orders.add(record.id);
    return record;
  }
  const first = await create('Smoke visible A', '2');
  const hidden = await create('Filtered order', '11');
  const second = await create('Smoke visible B', '5');
  let list = await data('/api/orders', { token: user });
  assert.deepEqual(list.records.map(row => row.id), [second.id, first.id]);
  const detail = await data('/api/orders/' + hidden.id, { token: user });
  assert.deepEqual(detail.record.values, hidden.values);
  const { record: edited } = await data('/api/orders/' + first.id, {
    method: 'PUT', token: user,
    body: { revision: published.revision, version: first.version, values: values('Smoke visible A', '8') },
  });
  assert.equal(edited.id, first.id);
  list = await data('/api/orders', { token: user });
  assert.deepEqual(list.records.map(row => row.id), [first.id, second.id]);
  assert.equal(list.records[0].values['smoke-total'], '8');
  assert.equal((await request('/api/orders/' + first.id, {
    method: 'DELETE', token: user, body: { version: first.version },
  })).status, 409);
  console.log('PASS User can create, view, and edit orders with published filters and numeric sort');
} catch (error) {
  failures.push(error);
}

for (const id of orders) {
  const path = '/api/orders/' + id;
  try {
    const { record } = await data(path, { token: user });
    await data(path, { method: 'DELETE', token: user, body: { version: record.version } });
    assert.equal((await request(path, { token: user })).status, 404);
  } catch (error) {
    failures.push(error);
  }
}
if (orders.size && !failures.length) {
  try {
    assert.equal((await data('/api/state', { token: user })).records.length, 0);
    console.log('PASS User deleted the smoke-test orders');
  } catch (error) {
    failures.push(error);
  }
}
const signOuts = await Promise.allSettled(sessions.map(async cookie => {
  const response = await request('/api/auth/sign-out', { method: 'POST', body: {}, cookie });
  assert(response.ok, 'Sign-out returned HTTP ' + response.status);
}));
failures.push(...signOuts.filter(result => result.status === 'rejected').map(result => result.reason));
if (failures.length) throw new AggregateError(failures, 'ERP Preview smoke test failed');
