/**
 * The guard that keeps JSON feeds answering 200-with-a-body (noRevalidate.js).
 *
 * Regression for "/api/allUsers 304 error": Express stamps every res.json()
 * with an ETag, so a client revalidating an unchanged roster — open the roster
 * modal twice with nobody registering, fighting or editing a profile in
 * between — was answered 304 Not Modified with an empty body. Whatever is then
 * handed the wire answer sees an error ("Failed to load roster", "Unable to
 * load members", `bad_response`) instead of the JSON it asked for.
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

test('the server guards the roster and the public history feed', () => {
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
});
