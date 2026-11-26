import { createAuthClient } from '@neon/auth';
import { ordersView } from './orders-view.js';
import { schemaEditor } from './schema-editor.js';

const element = id => document.getElementById(id);
const status = element('status');
const form = element('login');
const result = element('result');
const workspace = element('workspace');
const builder = element('schema-builder');
const dashboardNav = element('dashboard-nav');
const builderNav = element('builder-nav');
const schema = schemaEditor(api);
const orders = ordersView(api, locked => {
  dashboardNav.disabled = builderNav.disabled = locked;
});
let auth;
let authUrl;
let session;
let builderLoaded = false;

function showSignIn() {
  session?.controller.abort();
  session = undefined;
  builderLoaded = false;
  orders.hide();
  schema.setAdmin(false);
  workspace.hidden = true;
  builderNav.hidden = element('gateway').hidden = true;
  element('identity').textContent = '';
  result.textContent = '';
  element('auth').hidden = false;
  status.textContent = 'Sign in to view purchase orders.';
}

function showDashboard() {
  if (!session || dashboardNav.disabled) return;
  builder.hidden = true;
  builderNav.removeAttribute('aria-current');
  dashboardNav.setAttribute('aria-current', 'page');
  orders.show();
}

function showBuilder() {
  if (!session?.isAdmin || builderNav.disabled) return;
  orders.hide();
  dashboardNav.removeAttribute('aria-current');
  builderNav.setAttribute('aria-current', 'page');
  if (!builderLoaded) {
    schema.setAdmin(true);
    builderLoaded = true;
  } else {
    builder.hidden = false;
  }
  element('schema-heading').focus();
}

async function api(path, method = 'GET', authenticated = true, { body, signal } = {}) {
  const headers = {};
  if (authenticated) {
    // Exchange the session cookie for a JWT instead of reading a cached session.
    const response = await fetch(authUrl + '/token', { credentials: 'include', cache: 'no-store', signal });
    if (response.status >= 500) throw new Error('Could not refresh the session. Try again.');
    const { token } = response.ok ? await response.json() : {};
    signal?.throwIfAborted();
    if (!token) {
      showSignIn();
      throw new Error('Sign in required');
    }
    headers.Authorization = 'Bearer ' + token;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: JSON.stringify(body), signal });
  signal?.throwIfAborted();
  if (response.status === 401) showSignIn();
  const data = response.status === 204 ? null : await response.json();
  signal?.throwIfAborted();
  if (!response.ok) {
    throw Object.assign(new Error(data?.error || 'Request failed'), { status: response.status, fields: data?.fields });
  }
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
  session = { isAdmin, controller: new AbortController() };
  element('identity').textContent = data.user.email + (isAdmin ? ' · Admin' : ' · User');
  element('auth').hidden = true;
  workspace.hidden = false;
  builderNav.hidden = element('gateway').hidden = !isAdmin;
  status.textContent = '';
  showDashboard();
}

function action(target, callback) {
  target.addEventListener('click', async () => {
    const owner = session;
    if (!owner) return;
    target.disabled = true;
    try { await callback(owner.controller.signal); }
    catch (error) { if (session === owner) status.textContent = error.message; }
    finally { target.disabled = false; }
  });
}

element('schema-heading').tabIndex = -1;
dashboardNav.addEventListener('click', showDashboard);
builderNav.addEventListener('click', showBuilder);

form.addEventListener('submit', async event => {
  event.preventDefault();
  const submitter = event.submitter;
  if (!submitter) return;
  const buttons = Array.from(form.querySelectorAll('button'));
  buttons.forEach(button => { button.disabled = true; });
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
    buttons.forEach(button => { button.disabled = false; });
  }
});

action(element('postgres'), async signal => {
  const data = await api('/api/state', 'GET', true, { signal });
  result.textContent = JSON.stringify(data, null, 2);
  status.textContent = 'Read ERP state from Neon Postgres.';
});
action(element('gateway'), async signal => {
  const data = await api('/api/ai/test', 'POST', true, { signal });
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
