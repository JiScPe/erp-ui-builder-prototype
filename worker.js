import { neon } from '@neondatabase/serverless';
import { authenticatedUser, testGateway } from './neon-services.js';

const allowedTypes = new Set(['heading', 'text', 'number', 'date', 'select']);
const reply = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store' },
});

function validLayout(layout) {
  return Array.isArray(layout) && layout.length <= 50 &&
    new Set(layout.map(field => field?.id)).size === layout.length &&
    layout.every(field => field && typeof field.id === 'string' &&
      /^[a-z0-9-]{1,48}$/i.test(field.id) && allowedTypes.has(field.type) &&
      typeof field.label === 'string' && field.label.trim() && field.label.length <= 100 &&
      [1, 2].includes(field.width) && typeof field.required === 'boolean' &&
      Array.isArray(field.options) && field.options.length <= 25 &&
      field.options.every(option => typeof option === 'string' && option.length <= 100) &&
      (field.type !== 'select' || field.options.length > 0));
}

function validValue(field, value) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  if (!value.trim()) return !field.required;
  if (field.type === 'number') return Number.isFinite(Number(value));
  if (field.type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  return field.type !== 'select' || field.options.includes(value);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/config') {
      return reply({ authUrl: env.NEON_AUTH_BASE_URL || null });
    }
    if (!env.NEON_AUTH_BASE_URL || !env.NEON_AUTH_JWKS_URL) {
      return reply({ error: 'Neon Auth is not configured' }, 503);
    }

    try {
      const user = await authenticatedUser(request, env);
      if (!user) return reply({ error: 'Sign in required' }, 401);
      if (request.method === 'GET' && url.pathname === '/api/session') return reply(user);
      const aiTest = request.method === 'POST' && url.pathname === '/api/ai/test';
      if ((aiTest || url.pathname === '/api/layout') && user.role !== 'admin') {
        return reply({ error: 'Admin access required' }, 403);
      }
      if (aiTest) {
        const result = await testGateway(env);
        return reply(result.data, result.status);
      }
      if (!env.DATABASE_URL) return reply({ error: 'Neon Postgres is not configured' }, 503);
      const sql = neon(env.DATABASE_URL);
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const [[state], records] = await sql.transaction([
          sql`SELECT layout, revision FROM erp_prototype WHERE id = 1`,
          sql`SELECT id::text, layout, values_json AS values, created_at AS "createdAt"
              FROM erp_prototype_submissions ORDER BY id DESC LIMIT 10`,
        ]);
        return reply({ ...state, records });
      }
      if (request.method !== 'POST' || !['/api/layout', '/api/records'].includes(url.pathname)) {
        return reply({ error: 'Route not found' }, 404);
      }
      if (request.headers.get('Origin') !== url.origin ||
          !request.headers.get('Content-Type')?.startsWith('application/json')) {
        return reply({ error: 'Expected a same-origin JSON request' }, 403);
      }
      const raw = await request.text();
      if (raw.length > 150_000) return reply({ error: 'Request is too large' }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON' }, 400); }
      if (!Number.isInteger(body?.revision) || !validLayout(body.layout)) {
        return reply({ error: 'Invalid page configuration' }, 400);
      }
      const layout = JSON.stringify(body.layout);
      if (url.pathname === '/api/layout') {
        const [updated] = await sql`
          UPDATE erp_prototype SET layout = ${layout}::jsonb, revision = revision + 1
          WHERE id = 1 AND revision = ${body.revision} RETURNING revision
        `;
        return updated ? reply(updated) : reply({ error: 'Layout changed. Reload and try again.' }, 409);
      }
      const fields = body.layout.filter(field => field.type !== 'heading');
      const values = body.values;
      if (!fields.length || !values || Array.isArray(values) ||
          Object.keys(values).length !== fields.length ||
          !fields.every(field => validValue(field, values[field.id]))) {
        return reply({ error: 'Invalid form values' }, 422);
      }
      const [record] = await sql`
        INSERT INTO erp_prototype_submissions (layout, values_json)
        SELECT layout, ${JSON.stringify(values)}::jsonb FROM erp_prototype
        WHERE id = 1 AND revision = ${body.revision} AND layout = ${layout}::jsonb
        RETURNING id::text, layout, values_json AS values, created_at AS "createdAt"
      `;
      return record ? reply(record, 201) : reply({ error: 'Save the current layout before submitting.' }, 409);
    } catch (error) {
      console.error('ERP prototype service request failed', error.name);
      return reply({ error: 'Service request failed. Check the Neon setup.' }, 502);
    }
  },
};
