const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const AUTH_ERRORS = fs.readFileSync(path.join(ROOT, 'public', 'js', 'auth-errors.js'), 'utf8');
const AUTH_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'auth.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const MARKUP = `<!doctype html><html><body>
  <button id="btnLogin" type="button">Login</button>
  <div id="modalLogin">
    <input id="loginUser"><input id="loginPass" type="password">
    <div id="loginError" style="display:none"></div>
    <button id="loginCancel" type="button">Cancel</button>
    <button id="loginSubmit" type="button">Login</button>
  </div>
</body></html>`;

function response(status, data, retryAfter) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter || null : null },
    json: async () => {
      if (data instanceof Error) throw data;
      return data;
    }
  };
}

function startClient(fetchImpl) {
  const dom = new JSDOM(MARKUP, {
    url: 'https://male-cyber-fighters.test/',
    runScripts: 'dangerously'
  });
  const win = dom.window;
  const requests = [];
  win.console.error = () => {};

  win.$ = id => win.document.getElementById(id);
  win.show = el => { el.style.display = 'flex'; };
  win.hide = el => { el.style.display = 'none'; };
  win.setSessionToken = () => {};
  win.setSession = () => {};
  win.socket = { emit() {} };
  win.fetch = (url, options) => {
    requests.push({ url: String(url), options });
    return fetchImpl(url, options);
  };

  win.eval(AUTH_ERRORS);
  win.eval(AUTH_SOURCE);

  return {
    win,
    requests,
    error: () => win.document.getElementById('loginError'),
    submit: () => win.document.getElementById('loginSubmit'),
    async login() {
      win.document.getElementById('loginUser').value = 'fighter';
      win.document.getElementById('loginPass').value = 'secret';
      win.document.getElementById('loginSubmit').click();
      await tick();
    },
    close: () => win.close()
  };
}

test('a successful 200 login is not changed into a network error by missing socket/UI updates', async () => {
  const client = startClient(async () => response(200, {
    ok: true,
    token: 'mcf_test-token',
    user: { username: 'fighter', display: 'Fighter' }
  }));
  try {
    client.win.console.error = () => {};
    client.win.socket = undefined;
    client.win.updateUIForSession = () => { throw new Error('profile widget failed'); };

    await client.login();

    assert.equal(client.error().textContent, '');
    assert.equal(client.win.document.getElementById('modalLogin').style.display, 'none');
    assert.equal(client.submit().disabled, false);
  } finally {
    client.close();
  }
});

test('an unreadable 200 response is reported as a server response problem', async () => {
  const client = startClient(async () => response(200, new SyntaxError('not JSON')));
  try {
    await client.login();
    assert.match(client.error().textContent, /unreadable response/i);
    assert.doesNotMatch(client.error().textContent, /network error/i);
  } finally {
    client.close();
  }
});

test('HTTP 401 is shown as a credential error, not a network error', async () => {
  const client = startClient(async () => response(401, { ok: false, error: 'invalid_credentials' }));
  try {
    await client.login();
    assert.equal(client.error().textContent, 'Invalid username or password.');
    assert.equal(client.requests.length, 1);
  } finally {
    client.close();
  }
});

test('HTTP 429 explains the login limit and uses Retry-After', async () => {
  const client = startClient(async () => response(429, new SyntaxError('plain-text response'), '600'));
  try {
    await client.login();
    assert.equal(client.error().textContent, 'Too many login attempts. Please try again in 10 minutes.');
    assert.equal(client.requests.length, 1);
  } finally {
    client.close();
  }
});

test('a failed fetch is reported as a network error and the button is re-enabled', async () => {
  const client = startClient(async () => { throw new Error('offline'); });
  try {
    await client.login();
    assert.equal(client.error().textContent, 'Network error. Check your connection and try again.');
    assert.equal(client.submit().disabled, false);
  } finally {
    client.close();
  }
});

test('rapid click and Enter events do not send parallel login requests', async () => {
  let resolveFetch;
  let requestCount = 0;
  const client = startClient(() => {
    requestCount += 1;
    return new Promise(resolve => { resolveFetch = resolve; });
  });
  try {
    const { win } = client;
    win.document.getElementById('loginUser').value = 'fighter';
    win.document.getElementById('loginPass').value = 'secret';

    client.submit().click();
    client.submit().click();
    win.document.getElementById('loginPass').dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );

    assert.equal(requestCount, 1);
    assert.equal(client.submit().disabled, true);

    resolveFetch(response(401, { ok: false, error: 'invalid_credentials' }));
    await tick();
    assert.equal(client.error().textContent, 'Invalid username or password.');
    assert.equal(client.submit().disabled, false);
  } finally {
    client.close();
  }
});
