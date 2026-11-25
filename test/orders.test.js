import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { neonConfig } from '@neondatabase/serverless';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../worker.js';

const origin = 'https://erp.example';
const authOrigin = 'https://orders-auth.example';
const path = '/api/orders';
const draftPath = '/api/metadata/draft';
const publishPath = '/api/metadata/publish';
const literal = "PO_'%";
const config = {
  schema: [
    { id: 'order-name', label: 'Order name', type: 'text', required: true, options: [] },
    { id: 'total', label: 'Total', type: 'number', required: false, options: [] },
    { id: 'due-date', label: 'Due date', type: 'date', required: false, options: [] },
    { id: 'priority', label: 'Priority', type: 'select', required: false, options: ['Normal', 'Urgent'] },
  ],
  table: { columns: ['order-name', 'total', 'due-date', 'priority'] },
  form: {
    items: [
      { kind: 'heading', id: 'order', label: 'Purchase order', width: 2 },
      { kind: 'field', fieldId: 'order-name', width: 2 },
      { kind: 'field', fieldId: 'total', width: 1 },
      { kind: 'field', fieldId: 'due-date', width: 1 },
      { kind: 'field', fieldId: 'priority', width: 1 },
    ],
  },
  query: {
    filters: [
      { fieldId: 'order-name', operator: 'contains', value: literal },
      { fieldId: 'total', operator: 'gte', value: 2 },
      { fieldId: 'due-date', operator: 'gte', value: '2026-01-01' },
      { fieldId: 'priority', operator: 'eq', value: 'Normal' },
    ],
    sort: [{ fieldId: 'total', direction: 'asc' }, { fieldId: 'due-date', direction: 'desc' }],
  },
};

let database, originalFetch, jwksServer, env, admin, user;
const queries = [];

before(async () => {
  database = new PGlite();
  await database.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  originalFetch = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async (_url, { body }) => {
    const batch = JSON.parse(body);
    const execute = (db, { query, params }) => {
      queries.push({ query, params });
      return db.query(query, params, {
        rowMode: 'array', parsers: { 16: String, 23: String, 1184: String, 3802: String },
      });
    };
    if (!batch.queries) return Response.json(await execute(database, batch));
    const results = await database.transaction(async tx => {
      const output = [];
      for (const entry of batch.queries) output.push(await execute(tx, entry));
      return output;
    });
    return Response.json({ results });
  };
  const { privateKey, publicKey } = await generateKeyPair('EdDSA');
  const jwk = { ...await exportJWK(publicKey), kid: 'orders-test', alg: 'EdDSA' };
  jwksServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise(resolve => jwksServer.listen(0, '127.0.0.1', resolve));
  env = {
    DATABASE_URL: 'postgresql://fixture:fixture@db.invalid/erp',
    NEON_AUTH_BASE_URL: authOrigin + '/auth',
    NEON_AUTH_JWKS_URL: 'http://127.0.0.1:' + jwksServer.address().port + '/jwks',
    ERP_ADMIN_USER_ID: 'admin',
  };
  const sign = subject => new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid }).setSubject(subject)
    .setIssuer(authOrigin).setAudience(authOrigin).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  [admin, user] = await Promise.all([sign('admin'), sign('user')]);
});

after(async () => {
  neonConfig.fetchFunction = originalFetch;
  if (jwksServer) await new Promise(resolve => jwksServer.close(resolve));
  if (database) await database.close();
});

async function request(route, bearer, method = 'GET', data, referer = origin) {
  const headers = { 'Content-Type': 'application/json', Origin: referer };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const body = data === undefined ? undefined : JSON.stringify(data);
  const response = await worker.fetch(new Request(origin + route, { method, headers, body }), env);
  return { status: response.status, body: await response.json() };
}

const draft = (configuration, draftRevision) =>
  request(draftPath, admin, 'PUT', { config: configuration, draftRevision });
const publish = draftRevision => request(publishPath, admin, 'POST', { draftRevision });
const orderValues = (name, total, due = '2026-03-01', priority = 'Normal') =>
  ({ 'order-name': name, total, 'due-date': due, priority });

test('the order routes apply the published query and protect record edits', async t => {
  await t.test('requires sign-in, same-origin writes, and a published form', async () => {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path + '/1')).status, 401);
    assert.equal((await request(path, undefined, 'POST', {})).status, 401);
    assert.equal((await request(path + '/1', undefined, 'PUT', {})).status, 401);
    assert.equal((await request(path + '/1', undefined, 'DELETE', {})).status, 401);
    assert.equal((await request(path, user, 'POST', {}, 'https://different.example')).status, 403);
    assert.deepEqual(await request(path, user), {
      status: 200, body: { config: null, revision: 0, records: [], hasMore: false },
    });
    assert.equal((await request(path, user, 'POST', { revision: 0, values: {} })).status, 422);
    assert.equal((await request(path + '/9223372036854775808', user)).status, 400);
    assert.equal((await request(path + '?page=0', user)).status, 400);
    assert.equal((await request(path + '/1', user)).status, 404);
    assert.equal((await draft(config, 0)).status, 200);
    assert.equal((await request(path, user)).body.config, null);
    assert.equal((await publish(1)).status, 200);
  });

  let first, second;
  await t.test('filters with bound values, typed numeric sort, and safe legacy reads', async () => {
    const create = async values => {
      const response = await request(path, user, 'POST', { revision: 1, values });
      assert.equal(response.status, 201);
      return response.body.record;
    };
    first = await create(orderValues(literal + ' large', '10'));
    second = await create(orderValues(literal + ' small', '2', '2026-03-02'));
    const sameTotal = await create(orderValues(literal + ' same price', '2', '2026-02-01'));
    const hexadecimal = await create(orderValues(literal + ' hexadecimal', '0x10'));
    assert.equal(hexadecimal.values.total, '16');
    const tiny = await create(orderValues(literal + ' underflow', '1e-9999999'));
    assert.equal(tiny.values.total, '0');
    const zero = await create(orderValues(literal + ' decimal zero', '0.00'));
    assert.equal(zero.values.total, '0.00');
    const exact = await create(orderValues(literal + ' exact decimal', '9007199254740993.01'));
    assert.equal(exact.values.total, '9007199254740993.01');
    await create(orderValues('POabX similar only with wildcards', '5'));
    await create(orderValues(literal + ' before date', '8', '2025-03-02'));
    await create(orderValues(literal + ' urgent', '8', '2026-07-02', 'Urgent'));
    for (const params of [
      orderValues(literal + ' bad decimal', 'legacy'),
      orderValues(literal + ' bad date', '9', '2026-99-99'),
      orderValues(literal + ' out of range', '1e9999999999'),
    ]) {
      await database.query('INSERT INTO erp_prototype_submissions (layout, values_json) VALUES (\'[]\'::jsonb, $1::jsonb)',
        [JSON.stringify(params)]);
    }
    const response = await request(path, user);
    assert.equal(response.status, 200);
    assert.equal(response.body.revision, 1);
    assert.deepEqual(response.body.config, config);
    assert.deepEqual(response.body.records.map(record => record.id), [second.id, sameTotal.id, first.id, hexadecimal.id, exact.id]);
    assert.equal(response.body.hasMore, false);
    const { query, params } = queries.at(-1);
    assert.equal(query.includes(literal), false);
    assert.equal(query.includes("'order-name'"), false);
    assert(params.includes(literal));
    assert(params.includes('order-name'));
    assert.equal((await request(path + '/' + first.id, user)).body.record.version, first.version);
  });

  await t.test('validates server-side layout and preserves hidden values and stale versions', async () => {
    const values = orderValues(literal + ' edited', '18');
    const old = await database.query(
      `UPDATE erp_prototype_submissions
       SET values_json = values_json || '{"old-note":"keep"}'::jsonb
       WHERE id = $1::bigint RETURNING layout`,
      [first.id],
    );
    const route = path + '/' + first.id;
    const version = (await request(route, user)).body.record.version;
    assert.notEqual(version, first.version);
    assert.equal((await request(path, user, 'POST', { revision: 0, values })).status, 409);
    assert.equal((await request(path, user, 'POST', { revision: 1, values: { ...values, extra: 'disallowed' } })).status, 422);
    assert.equal((await request(path, user, 'POST', { revision: 1, values: { ...values, total: 'impossible' } })).status, 422);
    assert.equal((await request(route, user, 'PUT', { revision: 1, version: first.version, values })).status, 409);
    const updated = await request(route, user, 'PUT', { revision: 1, version, values });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.record.values, { ...values, 'old-note': 'keep' });
    assert.notEqual(updated.body.record.version, version);
    assert.deepEqual((await database.query(
      'SELECT layout FROM erp_prototype_submissions WHERE id = $1::bigint', [first.id],
    )).rows, old.rows);
    assert.equal((await request(route, user, 'DELETE', { version })).status, 409);
    assert.equal((await request(route, user, 'DELETE', { version: updated.body.record.version })).status, 200);
    assert.equal((await request(route, user)).status, 404);
  });

  await t.test('keeps a saved draft separate and paginates the newly published list', async () => {
    const next = structuredClone(config);
    next.query.filters = [];
    next.query.sort = [];
    assert.equal((await draft(next, 1)).status, 200);
    assert.deepEqual((await request(path, user)).body.config.query, config.query);
    assert.equal((await publish(2)).status, 200);
    assert.equal((await request(path + '/' + second.id, user, 'PUT', {
      revision: 1, version: second.version, values: second.values,
    })).status, 409);
    await database.query(`INSERT INTO erp_prototype_submissions (layout, values_json)
      SELECT '[]'::jsonb, jsonb_build_object('order-name', 'Page ' || index)
      FROM generate_series(1, 52) AS sample(index)`);
    const pageOne = (await request(path, user)).body;
    const pageTwo = (await request(path + '?page=2', user)).body;
    assert.equal(pageOne.records.length, 50);
    assert.equal(pageOne.hasMore, true);
    assert.equal(pageTwo.hasMore, false);
    assert(pageTwo.records.length > 0);
    assert(pageOne.records.every(firstPage => !pageTwo.records.some(secondPage => secondPage.id === firstPage.id)));
    assert.equal(pageTwo.revision, 2);
  });
});
