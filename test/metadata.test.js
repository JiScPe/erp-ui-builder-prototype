import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { neonConfig } from '@neondatabase/serverless';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../worker.js';

const origin = 'https://erp.example';
const authOrigin = 'https://neon-auth.example';
const path = '/api/metadata';
const draftPath = path + '/draft';
const publishPath = path + '/publish';

const legacyLayout = [
  { id: 'intro', type: 'heading', label: 'Order', required: false, width: 2, options: [] },
  { id: 'sku', type: 'text', label: 'SKU', required: true, width: 1, options: ['unused'], extra: true },
  { id: 'memo', type: 'text', label: 'Memo', required: false, width: 1, options: [] },
];
const historicLayout = [
  ...legacyLayout,
  { id: 'historic', type: 'text', label: 'Historical', required: false, width: 1, options: [] },
];

function configuration(label) {
  return {
    schema: [
      { id: 'sku', label, type: 'text', required: true, options: [] },
      { id: 'quantity', label: 'Quantity', type: 'number', required: false, options: [] },
    ],
    table: { columns: ['quantity', 'sku'] },
    form: { items: [
      { kind: 'heading', id: 'intro', label: 'Order', width: 2 },
      { kind: 'field', fieldId: 'sku', width: 1 },
      { kind: 'field', fieldId: 'quantity', width: 1 },
    ] },
    query: {
      filters: [{ fieldId: 'quantity', operator: 'gte', value: 2 }],
      sort: [{ fieldId: 'sku', direction: 'desc' }],
    },
  };
}

let database, originalFetch, jwksServer, env, adminToken, userToken, migration;

before(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE erp_prototype (
      id integer PRIMARY KEY CHECK (id = 1), layout jsonb, revision integer NOT NULL DEFAULT 0
    );
    CREATE TABLE erp_prototype_submissions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, layout jsonb NOT NULL,
      values_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await database.query('INSERT INTO erp_prototype VALUES (1, $1::jsonb, 7)', [JSON.stringify(legacyLayout)]);
  await database.query('INSERT INTO erp_prototype_submissions (layout, values_json) VALUES ($1::jsonb, $2::jsonb)', [
    JSON.stringify(historicLayout), JSON.stringify({ sku: 'A-001', memo: ' \t ', historic: 'old value' }),
  ]);
  migration = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  await database.exec(migration);

  originalFetch = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async (_url, { body }) => {
    const batch = JSON.parse(body);
    const execute = (connection, { query, params }) => connection.query(query, params, {
      rowMode: 'array', parsers: { 16: String, 23: String, 1184: String, 3802: String },
    });
    if (!batch.queries) return Response.json(await execute(database, batch));
    const results = await database.transaction(async transaction => {
      const results = [];
      for (const entry of batch.queries) results.push(await execute(transaction, entry));
      return results;
    });
    return Response.json({ results });
  };

  const keys = await generateKeyPair('EdDSA');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'metadata-test-key', alg: 'EdDSA' };
  jwksServer = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => jwksServer.listen(0, '127.0.0.1', resolve));
  env = {
    DATABASE_URL: 'postgresql://fixture:fixture@db.invalid/erp',
    NEON_AUTH_BASE_URL: authOrigin + '/neondb/auth',
    NEON_AUTH_JWKS_URL: 'http://127.0.0.1:' + jwksServer.address().port + '/jwks',
    ERP_ADMIN_USER_ID: 'admin',
  };
  const sign = subject => new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid })
    .setSubject(subject).setIssuer(authOrigin).setAudience(authOrigin)
    .setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  [adminToken, userToken] = await Promise.all([sign('admin'), sign('user')]);
});

after(async () => {
  neonConfig.fetchFunction = originalFetch;
  if (jwksServer) await new Promise(resolve => jwksServer.close(resolve));
  if (database) await database.close();
});

async function request(route, bearer, method = 'GET', payload) {
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const response = await worker.fetch(new Request(origin + route, { method, headers, body }), env);
  return { status: response.status, body: await response.json() };
}

const save = (config, draftRevision) => request(draftPath, adminToken, 'PUT', { config, draftRevision });
const publish = draftRevision => request(publishPath, adminToken, 'POST', { draftRevision });

test('draft and publish protect the live configuration and the data that uses it', async t => {
  await t.test('migration keeps legacy layout and submissions, and access is role-based', async () => {
    const live = await request(path, userToken);
    assert.equal(live.status, 200);
    assert.equal(live.body.revision, 7);
    assert.deepEqual(live.body.config.schema, [
      { id: 'sku', type: 'text', label: 'SKU', required: true, options: ['unused'] },
      { id: 'memo', type: 'text', label: 'Memo', required: false, options: [] },
    ]);
    const state = await request('/api/state', userToken);
    assert.deepEqual(state.body.layout, legacyLayout);
    assert.deepEqual(state.body.records[0].layout, historicLayout);
    assert.equal(state.body.records[0].values.historic, 'old value');
    assert.deepEqual((await request(draftPath, adminToken)).body,
      { config: live.body.config, draftRevision: 0 });
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(draftPath)).status, 401);
    assert.equal((await request(draftPath, userToken)).status, 403);
    assert.equal((await request(draftPath, userToken, 'PUT', { config: configuration('SKU'), draftRevision: 0 })).status, 403);
    assert.equal((await request(publishPath, userToken, 'POST', { draftRevision: 0 })).status, 403);
    assert.equal((await request('/api/layout', adminToken, 'POST', { layout: legacyLayout, revision: 7 })).status, 410);
    assert.equal((await publish(0)).status, 409);
  });

  await t.test('invalid schema, form, table, and query references are rejected', async () => {
    const invalidEdits = [
      config => { config.schema[0].type = ['text']; },
      config => { config.form.items[1].fieldId = 'missing'; },
      config => { config.table.columns.push('missing'); },
      config => { config.query.filters[0].value = '2'; },
      config => { config.query.filters[0].operator = 'contains'; },
      config => { config.query.sort[0].direction = 'ASC'; },
      config => { config.query.sql = 'ignored'; },
    ];
    for (const edit of invalidEdits) {
      const invalid = configuration('Item');
      edit(invalid);
      assert.equal((await save(invalid, 0)).status, 422);
    }
    assert.equal((await request(draftPath, adminToken)).body.draftRevision, 0);
  });

  await t.test('draft save is isolated, stale writes fail, and publication changes all sections once', async () => {
    const next = configuration('Item number');
    const saved = await save(next, 0);
    assert.deepEqual(saved, { status: 200, body: { config: next, draftRevision: 1 } });
    assert.deepEqual(await save(next, 0), saved);
    assert.equal((await save(configuration('Stale edit'), 0)).status, 409);
    assert.equal((await request(path, userToken)).body.revision, 7);
    assert.equal((await request('/api/state', userToken)).body.layout[1].label, 'SKU');
    const published = await publish(1);
    assert.deepEqual(published, { status: 200, body: { config: next, revision: 8 } });
    assert.deepEqual(await publish(1), published);
    await database.exec(migration);
    assert.deepEqual(await request(path, userToken), published);
    const state = (await request('/api/state', userToken)).body;
    assert.deepEqual(state.layout, [
      { id: 'intro', type: 'heading', label: 'Order', required: false, width: 2, options: [] },
      { id: 'sku', type: 'text', label: 'Item number', required: true, width: 1, options: [] },
      { id: 'quantity', type: 'number', label: 'Quantity', required: false, width: 1, options: [] },
    ]);
    assert.equal(state.records[0].values.sku, 'A-001');
    assert.equal((await request('/api/records', userToken, 'POST', {
      revision: 7, layout: legacyLayout, values: { sku: 'A-002', memo: '' },
    })).status, 409);
    const submitted = await request('/api/records', userToken, 'POST', {
      revision: state.revision, layout: state.layout, values: { sku: 'A-002', quantity: '2' },
    });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.values.quantity, '2');
  });

  await t.test('publish rejects missing required fields and incompatible stored data', async () => {
    const incomplete = configuration('Item');
    incomplete.form.items.splice(1, 1);
    assert.equal((await save(incomplete, 1)).status, 200);
    assert.equal((await publish(2)).status, 422);

    const removed = configuration('Item');
    removed.schema.shift();
    removed.form.items.splice(1, 1);
    removed.table.columns.pop();
    removed.query.sort = [];
    assert.equal((await save(removed, 2)).status, 200);
    const deletion = await publish(3);
    assert.equal(deletion.status, 409);
    assert.deepEqual(deletion.body.fields, ['sku']);

    const retyped = configuration('Item');
    retyped.schema[0].type = 'number';
    assert.equal((await save(retyped, 3)).status, 200);
    const typeChange = await publish(4);
    assert.equal(typeChange.status, 409);
    assert.deepEqual(typeChange.body.fields, ['sku']);

    const reused = configuration('Item');
    reused.schema.push({ id: 'historic', label: 'Historical', type: 'date', required: false, options: [] });
    assert.equal((await save(reused, 4)).status, 200);
    const reusedId = await publish(5);
    assert.equal(reusedId.status, 409);
    assert.deepEqual(reusedId.body.fields, ['historic']);
    assert.equal((await publish(3)).status, 409);
    assert.deepEqual((await request(path, userToken)).body, { config: configuration('Item number'), revision: 8 });
    assert.equal((await request('/api/state', userToken)).body.records.length, 2);

    reused.schema.at(-1).type = 'text';
    assert.equal((await save(reused, 5)).status, 200);
    assert.deepEqual(await publish(6), { status: 200, body: { config: reused, revision: 9 } });
  });
});
