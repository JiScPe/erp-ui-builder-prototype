import { createAuthClient } from '@neon/auth';
import { schemaEditor } from './schema-editor.js';

const element = id => document.getElementById(id);
const status = element('status');
const form = element('login');
const result = element('result');
const schema = schemaEditor(api);
let auth;
let authUrl;

function showSignIn() {
  schema.setAdmin(false);
  element('workspace').hidden = true;
  element('gateway').hidden = true;
  element('identity').textContent = '';
  result.textContent = '';
  element('auth').hidden = false;
  status.textContent = 'Sign in to check the connected services.';
}

async function api(path, method = 'GET', authenticated = true, { body, signal } = {}) {
  const headers = {};
  if (authenticated) {
    // Exchange the session cookie for a JWT instead of reading a cached session.
    const response = await fetch(authUrl + '/token', { credentials: 'include', cache: 'no-store', signal });
    const { token } = response.ok ? await response.json() : {};
    if (!token) {
      showSignIn();
      throw new Error('Sign in required');
    }
    headers.Authorization = 'Bearer ' + token;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: JSON.stringify(body), signal });
  if (response.status === 401) showSignIn();
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: response.status });
  return data;
}

async function refresh() {
  const { data, error } = await auth.getSession();
  if (error) throw new Error(error.message);
  if (!data?.user) {
    showSignIn();
    return;
  }
  const user = await api('/api/session');
  const isAdmin = user.role === 'admin';
  element('identity').textContent = data.user.email + (isAdmin ? ' · Admin' : ' · User');
  element('auth').hidden = true;
  element('workspace').hidden = false;
  element('gateway').hidden = !isAdmin;
  schema.setAdmin(isAdmin);
  status.textContent = 'Neon Auth session verified by the Worker.';
}

function action(target, callback) {
  target.addEventListener('click', async () => {
    target.disabled = true;
    try { await callback(); }
    catch (error) { status.textContent = error.message; }
    finally { target.disabled = false; }
  });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const submitter = event.submitter;
  if (!submitter) return;
  submitter.disabled = true;
  try {
    const { email, password, name } = Object.fromEntries(new FormData(form));
    if (submitter.value === 'signup' && !name.trim()) throw new Error('Enter a name to create an account.');
    const response = submitter.value === 'signup'
      ? await auth.signUp.email({ email, password, name: name.trim() })
      : await auth.signIn.email({ email, password });
    if (response.error) throw new Error(response.error.message);
    form.reset();
    await refresh();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submitter.disabled = false;
  }
});

action(element('postgres'), async () => {
  const data = await api('/api/state');
  result.textContent = JSON.stringify(data, null, 2);
  status.textContent = 'Read ERP state from Neon Postgres.';
});
action(element('gateway'), async () => {
  const data = await api('/api/ai/test', 'POST');
  result.textContent = data.model + '\n' + data.output;
  status.textContent = 'Neon AI Gateway returned a completion.';
});
action(element('signout'), async () => {
  const { error } = await auth.signOut();
  if (error) throw new Error(error.message);
  showSignIn();
});

try {
  const config = await api('/api/config', 'GET', false);
  if (!config.authUrl) throw new Error('Neon Auth is not configured for this deployment.');
  authUrl = config.authUrl.replace(/\/$/, '');
  auth = createAuthClient(authUrl);
  await refresh();
} catch (error) {
  status.textContent = error.message;
}
