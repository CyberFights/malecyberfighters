/**
 * The guard that keeps always-body responses at 200 (noRevalidate.js).
 *
 * Regression for "/api/allUsers 304 error", "/api/story/pending 304 error",
 * "/api/story/list 304 error" and "/sw.js 304 error": Express
 * stamps every res.send()/res.json() with an ETag (res.sendFile also adds
 * Last-Modified), so a client revalidating an unchanged body — open the roster
 * modal twice with nobody registering, fighting or editing a profile in
 * between; let the browser check the service worker for an update — was
 * answered 304 Not Modified with an empty body. Whatever is then handed the
 * wire answer sees an error ("Failed to load roster", "Unable to load
 * members", `bad_response`, an empty script) instead of the body it asked for.
 *
 * Driven over raw node:http on purpose: Node's fetch() attaches
 * Cache-Control: no-cache to conditional requests, and Express treats that as
 * an end-to-end reload and answers 200 even without the guard — fetch() would
 * mask exactly the bug under test. Plain http.get sends what a revalidating
 * client sends.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const noRevalidate = require('../noRevalidate');

function get(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: reqPath, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function startApp() {
  // The roster shape: an answer that comes back byte-identical whenever the
  // directory has not changed — the condition that invited the 304s.
  const payload = () => ({ success: true, users: [] });

  const app = express();
  app.get('/unguarded', (req, res) => res.json(payload()));
  app.get('/guarded', noRevalidate, (req, res) => res.json(payload()));
  // The real /sw.js route shape: sendFile sets Last-Modified as well as an
  // ETag and revalidates against both itself (the `send` package reads the
  // conditional headers straight off the request).
  app.get('/sw.js', noRevalidate, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('the unguarded hazard is real: an unchanged body revalidates to 304', async () => {
  const api = await startApp();
  try {
    const first = await get(api.port, '/unguarded');
    assert.equal(first.status, 200);

    const revalidated = await get(api.port, '/unguarded', { 'If-None-Match': first.headers.etag });
    assert.equal(revalidated.status, 304, 'express answers an unchanged body with 304');
    assert.equal(revalidated.body, '', 'and no body to parse');

    // If-None-Match: * is treated as a match no matter what the response says.
    const star = await get(api.port, '/unguarded', { 'If-None-Match': '*' });
    assert.equal(star.status, 304, '* revalidates to 304 too');
  } finally {
    await api.close();
  }
});

test('a revalidating client gets the full body back, never 304', async () => {
  const api = await startApp();
  try {
    const first = await get(api.port, '/guarded');
    assert.equal(first.status, 200);
    assert.equal(first.body, JSON.stringify({ success: true, users: [] }));

    // The same validator that304s the unguarded route must change nothing.
    const revalidated = await get(api.port, '/guarded', { 'If-None-Match': first.headers.etag });
    assert.equal(revalidated.status, 200);
    assert.equal(revalidated.body, first.body, 'the body arrives again, in full');

    const star = await get(api.port, '/guarded', { 'If-None-Match': '*' });
    assert.equal(star.status, 200, 'not even If-None-Match: * can304 it');

    // If-Modified-Since cannot sneak one in either.
    const modified = await get(api.port, '/guarded', {
      'If-Modified-Since': new Date(Date.now() + 86400000).toUTCString()
    });
    assert.equal(modified.status, 200);
  } finally {
    await api.close();
  }
});

test('clients are told not to keep the answer around', async () => {
  const api = await startApp();
  try {
    const res = await get(api.port, '/guarded');
    assert.match(res.headers['cache-control'] || '', /no-store/, 'nothing to cache, nothing to revalidate later');
  } finally {
    await api.close();
  }
});

test('the service worker script always arrives in full, never 304', async () => {
  const api = await startApp();
  try {
    const first = await get(api.port, '/sw.js');
    assert.equal(first.status, 200);
    assert.ok(first.body.length > 0, 'the worker itself, not an empty answer');
    assert.ok(first.headers.etag, 'sendFile hands out an ETag');
    assert.ok(first.headers['last-modified'], 'and a Last-Modified — two validators to revalidate with');

    // sendFile revalidates against both validators itself; the guard must win
    // over each of them and over the wildcard.
    const etag = await get(api.port, '/sw.js', { 'If-None-Match': first.headers.etag });
    assert.equal(etag.status, 200);
    assert.equal(etag.body, first.body);

    const both = await get(api.port, '/sw.js', {
      'If-None-Match': first.headers.etag,
      'If-Modified-Since': first.headers['last-modified']
    });
    assert.equal(both.status, 200);
    assert.equal(both.body, first.body);

    const star = await get(api.port, '/sw.js', { 'If-None-Match': '*' });
    assert.equal(star.status, 200);
  } finally {
    await api.close();
  }
});

test('the server guards the roster, the public history feed and the worker', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  assert.match(
    server,
    /app\.get\("\/api\/allUsers", noRevalidate, sessions\.requireUser/,
    'the roster feed never answers 304'
  );
  assert.match(
    server,
    /app\.get\("\/api\/public-messages", noRevalidate/,
    'and neither does the public history feed'
  );
  assert.match(
    server,
    /app\.get\('\/sw\.js', noRevalidate/,
    'nor the service worker script'
  );
});

test('every story endpoint is guarded the same way', () => {
  // The story routes live in their own module and are mounted wholesale, so
  // the guard belongs on the router itself: it then covers /pending, /list,
  // /archives and the permalink, in production and in any other host that
  // mounts the router. Regression for "/api/story/pending 304 error" and
  // "/api/story/list 304 error".
  const routes = fs.readFileSync(path.join(__dirname, '..', 'storyRoutes.js'), 'utf8');

  assert.match(
    routes,
    /router\.use\(noRevalidate\)/,
    'the story router never answers 304'
  );
  assert.match(
    routes,
    /const noRevalidate = require\('\.\/noRevalidate'\)/,
    'and it takes the guard from the shared middleware'
  );
});
