import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import worker from '../worker.js';

const authOrigin = 'https://neon-auth.example';
const adminId = 'first-erp-admin';
const keyId = 'neon-test-key';
let privateKey, jwksServer, env;

before(async () => {
  const keys = await generateKeyPair('EdDSA');
  privateKey = keys.privateKey;
  const jwk = { ...await exportJWK(keys.publicKey), kid: keyId, alg: 'EdDSA' };
  jwksServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/neondb/auth/sign-out') {
      response.setHeader('Set-Cookie', '__Secure-neon-auth.session_token=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned');
      response.end(JSON.stringify({ success: true, origin: request.headers.origin }));
      return;
    }
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve, reject) => {
    jwksServer.once('error', reject);
    jwksServer.listen(0, '127.0.0.1', resolve);
  });
  env = {
    NEON_AUTH_BASE_URL: authOrigin + '/neondb/auth',
    NEON_AUTH_JWKS_URL: 'http://127.0.0.1:' + jwksServer.address().port + '/jwks',
    ERP_ADMIN_USER_ID: adminId,
  };
});

after(() => {
  if (jwksServer) return new Promise(resolve => jwksServer.close(resolve));
});

async function token(claims = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: authOrigin,
    aud: authOrigin,
    sub: 'erp-user',
    iat: now,
    exp: now + 900,
    role: 'authenticated',
    ...claims,
  }).setProtectedHeader({ alg: 'EdDSA', kid: keyId }).sign(key);
}

function request(path, bearer, method = 'GET') {
  const headers = bearer ? { Authorization: 'Bearer ' + bearer } : undefined;
  return worker.fetch(new Request('https://erp.example' + path, { method, headers }), env);
}

test('signed-out requests cannot read ERP data or change the layout', async () => {
  assert.equal((await request('/api/session')).status, 401);
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/layout', undefined, 'POST')).status, 401);
});

test('the configured auth proxy uses the app origin and forwards session-cookie changes', async () => {
  const appOrigin = 'https://erp.example';
  const proxyEnv = {
    ...env,
    NEON_AUTH_BASE_URL: 'http://127.0.0.1:' + jwksServer.address().port + '/neondb/auth',
    NEON_AUTH_COOKIE_SECRET: 'fixture-cookie-secret-with-at-least-32-characters',
  };
  const config = await worker.fetch(new Request(appOrigin + '/api/config'), proxyEnv);
  assert.deepEqual(await config.json(), { authUrl: appOrigin + '/api/auth' });

  const signOut = origin => worker.fetch(new Request(appOrigin + '/api/auth/sign-out', {
    method: 'POST',
    headers: { Origin: origin },
  }), proxyEnv);
  assert.equal((await signOut('https://elsewhere.example')).status, 403);
  const result = await signOut(appOrigin);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { success: true, origin: appOrigin });
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.match(result.headers.get('Set-Cookie'), /SameSite=Lax/i);
  assert.doesNotMatch(result.headers.get('Set-Cookie'), /Partitioned/i);
});

test('a valid Neon token creates a user session without trusting the provider role', async () => {
  const bearer = await token({ role: 'admin' });
  const response = await request('/api/session', bearer);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'erp-user', role: 'user', admin: false });
  assert.equal((await request('/api/layout', bearer, 'POST')).status, 403);
  assert.equal((await request('/api/ai/test', bearer, 'POST')).status, 403);
});

test('the configured subject is an admin and can pass the layout permission check', async () => {
  const bearer = await token({ sub: adminId });
  const response = await request('/api/session', bearer);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: adminId, role: 'admin', admin: true });

  const layout = await request('/api/layout', bearer, 'POST');
  assert.equal(layout.status, 503);
  assert.deepEqual(await layout.json(), { error: 'Neon Postgres is not configured' });

  const gateway = await request('/api/ai/test', bearer, 'POST');
  assert.equal(gateway.status, 503);
  assert.deepEqual(await gateway.json(), { error: 'Neon AI Gateway is not configured' });
});

test('invalid identity claims do not create an ERP session', async t => {
  const variants = {
    'wrong issuer': { iss: env.NEON_AUTH_BASE_URL },
    'wrong audience': { aud: 'https://other-auth.example' },
    'expired token': { exp: Math.floor(Date.now() / 1000) - 1 },
    'empty subject': { sub: '' },
    'non-string subject': { sub: 42 },
    'anonymous token': { role: 'anonymous' },
    'banned account': { banned: true },
  };
  for (const [name, claims] of Object.entries(variants)) {
    await t.test(name, async () => {
      assert.equal((await request('/api/session', await token(claims))).status, 401);
    });
  }

  await t.test('untrusted signature', async () => {
    const untrusted = await generateKeyPair('EdDSA');
    assert.equal((await request('/api/session', await token({}, untrusted.privateKey))).status, 401);
  });
});
