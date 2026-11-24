import { createAuthClient } from '@neon/auth';

const element = id => document.getElementById(id);
const status = element('status');
const form = element('login');
const result = element('result');
let auth;

async function api(path, method = 'GET', authenticated = true) {
  const headers = {};
  if (authenticated) {
    const { data, error } = await auth.token();
    if (!data?.token) throw new Error(error?.message || 'Session token unavailable');
    headers.Authorization = 'Bearer ' + data.token;
  }
  const response = await fetch(path, { method, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function refresh() {
  const { data, error } = await auth.getSession();
  if (error) throw new Error(error.message);
  if (!data?.user) {
    element('workspace').hidden = true;
    element('gateway').hidden = true;
    result.textContent = '';
    element('auth').hidden = false;
    status.textContent = 'Sign in to check the connected services.';
    return;
  }
  const user = await api('/api/session');
  element('identity').textContent = data.user.email + (user.admin ? ' · Admin' : ' · User');
  element('auth').hidden = true;
  element('workspace').hidden = false;
  element('gateway').hidden = !user.admin;
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
  await refresh();
});

try {
  const { authUrl } = await api('/api/config', 'GET', false);
  if (!authUrl) throw new Error('Neon Auth configuration is missing. Run neon deploy and restart the app.');
  auth = createAuthClient(authUrl);
  await refresh();
} catch (error) {
  status.textContent = error.message;
}
