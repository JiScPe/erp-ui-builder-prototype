import { createRemoteJWKSet, jwtVerify } from 'jose';

let jwks;
let jwksUrl;

export async function authenticatedUser(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return null;

  const authOrigin = new URL(env.NEON_AUTH_BASE_URL).origin;
  if (jwksUrl !== env.NEON_AUTH_JWKS_URL) {
    jwks = createRemoteJWKSet(new URL(env.NEON_AUTH_JWKS_URL));
    jwksUrl = env.NEON_AUTH_JWKS_URL;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: authOrigin,
      audience: authOrigin,
      algorithms: ['EdDSA'],
      requiredClaims: ['sub', 'exp', 'iat'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub.trim() ||
        payload.role === 'anonymous' || payload.banned === true) return null;
    const admin = payload.sub === env.ERP_ADMIN_USER_ID;
    return { id: payload.sub, role: admin ? 'admin' : 'user', admin };
  } catch (error) {
    if (error.code === 'ERR_JWKS_TIMEOUT' || error instanceof TypeError) throw error;
    return null;
  }
}

export async function testGateway(env) {
  if (!env.NEON_AI_GATEWAY_BASE_URL || !env.NEON_AI_GATEWAY_TOKEN) {
    return { status: 503, data: { error: 'Neon AI Gateway is not configured' } };
  }

  const base = env.NEON_AI_GATEWAY_BASE_URL.replace(/\/$/, '');
  const headers = { Authorization: 'Bearer ' + env.NEON_AI_GATEWAY_TOKEN };
  const catalog = await fetch(base + '/v1/models', { headers, signal: AbortSignal.timeout(8000) });
  if (!catalog.ok) {
    return { status: 502, data: { error: 'AI Gateway model catalog failed', upstreamStatus: catalog.status } };
  }

  const { data: models = [] } = await catalog.json();
  const available = models.filter(model => model.enabled === true);
  const model = env.ERP_AI_MODEL
    ? available.find(model => model.id === env.ERP_AI_MODEL)
    : available.find(model => /gpt.*mini|claude.*haiku|gemini.*flash/i.test(model.id));
  if (!model) {
    const reason = models.find(entry => entry.unavailable_reason)?.unavailable_reason;
    return {
      status: 503,
      data: { error: 'No enabled text model matched. Check Gateway access or set ERP_AI_MODEL.', reason },
    };
  }

  const response = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: 'user', content: 'Reply with one short sentence confirming the ERP connection test.' }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    return { status: 502, data: { error: 'AI Gateway completion failed', upstreamStatus: response.status } };
  }
  const result = await response.json();
  const output = result.choices?.[0]?.message?.content;
  return typeof output === 'string' && output.trim()
    ? { status: 200, data: { model: model.id, output } }
    : { status: 502, data: { error: 'AI Gateway returned an empty completion' } };
}
