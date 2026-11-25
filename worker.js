import { neon } from '@neondatabase/serverless';
import { handleAuthProxyRequest } from '@neon/auth/server';
import { authenticatedUser, testGateway } from './neon-services.js';

import { validConfiguration, validLayout, validRecordValues } from './metadata.js';
import { publishDraft, readDraft, readPublished, saveDraft } from './metadata-store.js';

const reply = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store' },
});

const validRevision = revision =>
  Number.isInteger(revision) && revision >= 0 && revision <= 2_147_483_647;

const authProxyPath = '/api/auth';
const authProxyPrefix = authProxyPath + '/';
const authProxyRoutes = new Map([
  ['GET', new Set(['get-session', 'token'])],
  ['POST', new Set(['sign-in/email', 'sign-up/email', 'sign-out'])],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const authProxyEnabled = Boolean(env.NEON_AUTH_BASE_URL && env.NEON_AUTH_COOKIE_SECRET?.length >= 32);
    if (request.method === 'GET' && url.pathname === '/api/config') {
      return reply({
        authUrl: authProxyEnabled ? url.origin + authProxyPath : env.NEON_AUTH_BASE_URL || null,
      });
    }
    if (!env.NEON_AUTH_BASE_URL || !env.NEON_AUTH_JWKS_URL) {
      return reply({ error: 'Neon Auth is not configured' }, 503);
    }

    try {
      if (authProxyEnabled && url.pathname.startsWith(authProxyPrefix)) {
        const path = url.pathname.slice(authProxyPrefix.length);
        if (!authProxyRoutes.get(request.method)?.has(path)) return reply({ error: 'Route not found' }, 404);
        if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) {
          return reply({ error: 'Expected a same-origin auth request' }, 403);
        }
        const response = await handleAuthProxyRequest({
          request,
          path,
          baseUrl: env.NEON_AUTH_BASE_URL.replace(/\/$/, ''),
          cookieSecret: env.NEON_AUTH_COOKIE_SECRET,
          sameSite: 'lax',
        });
        response.headers.set('Cache-Control', 'no-store');
        return response;
      }
      const user = await authenticatedUser(request, env);
      if (!user) return reply({ error: 'Sign in required' }, 401);
      if (request.method === 'GET' && url.pathname === '/api/session') return reply(user);
      const aiTest = request.method === 'POST' && url.pathname === '/api/ai/test';
      const draft = url.pathname === '/api/metadata/draft';
      const publish = url.pathname === '/api/metadata/publish';
      const legacyLayout = url.pathname === '/api/layout';
      if ((aiTest || draft || publish || legacyLayout) && user.role !== 'admin') {
        return reply({ error: 'Admin access required' }, 403);
      }
      if (aiTest) {
        const result = await testGateway(env);
        return reply(result.data, result.status);
      }
      if (!env.DATABASE_URL) return reply({ error: 'Neon Postgres is not configured' }, 503);
      const sql = neon(env.DATABASE_URL);
      if (request.method === 'GET' && url.pathname === '/api/metadata') {
        return reply(await readPublished(sql));
      }
      if (request.method === 'GET' && draft) return reply(await readDraft(sql));
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const [[state], records] = await sql.transaction([
          sql`SELECT layout, revision FROM erp_prototype WHERE id = 1`,
          sql`SELECT id::text, layout, values_json AS values, created_at AS "createdAt"
              FROM erp_prototype_submissions ORDER BY id DESC LIMIT 10`,
        ]);
        return reply({ ...state, records });
      }
      if (request.method === 'POST' && legacyLayout) {
        return reply({ error: 'Use the draft and publish metadata endpoints.' }, 410);
      }

      const savingDraft = request.method === 'PUT' && draft;
      const publishingDraft = request.method === 'POST' && publish;
      const submittingRecord = request.method === 'POST' && url.pathname === '/api/records';
      if (!savingDraft && !publishingDraft && !submittingRecord) {
        return reply({ error: 'Route not found' }, 404);
      }
      if (request.headers.get('Origin') !== url.origin ||
          request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return reply({ error: 'Expected a same-origin JSON request' }, 403);
      }
      const raw = await request.text();
      if (raw.length > 150_000) return reply({ error: 'Request is too large' }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON' }, 400); }

      if (savingDraft || publishingDraft) {
        const draftRevision = body?.draftRevision;
        if (!validRevision(draftRevision)) return reply({ error: 'Invalid draft revision' }, 400);
        if (savingDraft) {
          if (!validConfiguration(body.config)) return reply({ error: 'Invalid metadata configuration' }, 422);
          const saved = await saveDraft(sql, body.config, draftRevision);
          return saved ? reply(saved) : reply({ error: 'Draft changed. Reload and try again.' }, 409);
        }
        const result = await publishDraft(sql, draftRevision);
        if (result.status === 'published') return reply({ config: result.config, revision: result.revision });
        if (result.status === 'invalid') return reply({ error: 'Invalid metadata configuration' }, 422);
        if (result.status === 'missing-fields') {
          return reply({ error: 'Required fields must appear in the form.', fields: result.fields }, 422);
        }
        if (result.status === 'conflict') {
          return reply({ error: 'Cannot remove or change the type of fields with stored data.', fields: result.fields }, 409);
        }
        return reply({ error: 'Draft changed or has not been saved. Reload and try again.' }, 409);
      }

      if (!validRevision(body?.revision) || !validLayout(body.layout)) {
        return reply({ error: 'Invalid page configuration' }, 400);
      }
      if (!validRecordValues(body.layout, body.values)) return reply({ error: 'Invalid form values' }, 422);

      const layout = JSON.stringify(body.layout);
      const [record] = await sql`
        WITH live AS (
          SELECT layout FROM erp_prototype
          WHERE id = 1 AND revision = ${body.revision} AND layout = ${layout}::jsonb
          FOR SHARE
        )
        INSERT INTO erp_prototype_submissions (layout, values_json)
        SELECT layout, ${JSON.stringify(body.values)}::jsonb FROM live
        RETURNING id::text, layout, values_json AS values, created_at AS "createdAt"
      `;
      return record ? reply(record, 201) : reply({ error: 'Reload the published layout before submitting.' }, 409);
    } catch (error) {
      console.error('ERP prototype service request failed', error.name);
      return reply({ error: 'Service request failed. Check the Neon setup.' }, 502);
    }
  },
};
