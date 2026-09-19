/**
 * The LFG endpoints, over real HTTP — the same harness shape as
 * story-routes.test.js: real router, in-memory models, fake session
 * middleware. This is the flow a member actually goes through: flip the
 * toggle → appear on the board → flip it off → disappear, with the board
 * broadcast firing on every change.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createLfgRouter } = require('../lfg.js');
const matchStyles = require('../public/js/match-styles.js');
const { makeModels } = require('./helpers/fakeModels');

async function startApi() {
  const models = makeModels();
  models.User._add({ username: 'alice', display: 'Alice', lastSeenAt: new Date() });
  models.User._add({ username: 'bob', display: 'Bob', lastSeenAt: new Date() });

  const broadcasts = [];

  const requireUser = (req, res, next) => {
    req.username = req.headers['x-test-user'] || null;
    if (!req.username) return res.status(401).json({ ok: false, error: 'auth' });
    next();
  };

  const app = express();
  app.use(express.json());
  app.use('/api/lfg', createLfgRouter({
    User: models.User,
    matchStyles,
    requireUser,
    broadcast: entries => broadcasts.push(entries)
  }).router);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, options = {}) => {
    const res = await fetch(base + path, {
      method: options.method || 'GET',
      headers: {
        ...(options.user ? { 'x-test-user': options.user } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (err) { /* not json */ }
    return { status: res.status, json };
  };

  return {
    call,
    broadcasts,
    models,
    async close() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

test('the board is members-only', async t => {
  const api = await startApi();
  t.after(() => api.close());

  const res = await api.call('/api/lfg/board');
  assert.equal(res.status, 401);
});

test('flipping the toggle puts you on the board and broadcasts it', async t => {
  const api = await startApi();
  t.after(() => api.close());

  const save = await api.call('/api/lfg/status', {
    method: 'POST',
    user: 'alice',
    body: { looking: true, styles: ['pro', 'dice'], note: 'best of 3 tonight' }
  });
  assert.equal(save.status, 200);
  assert.equal(save.json.ok, true);
  assert.equal(save.json.status.looking, true);

  const board = await api.call('/api/lfg/board', { user: 'bob' });
  assert.equal(board.json.entries.length, 1);
  const entry = board.json.entries[0];
  assert.equal(entry.username, 'alice');
  assert.deepEqual(entry.styles, ['pro', 'dice']);
  assert.equal(entry.note, 'best of 3 tonight');

  assert.equal(api.broadcasts.length, 1);
  assert.equal(api.broadcasts[0][0].username, 'alice');
});

test('switching off removes you from the board and clears your stale styles', async t => {
  const api = await startApi();
  t.after(() => api.close());

  await api.call('/api/lfg/status', { method: 'POST', user: 'alice', body: { looking: true, styles: ['pro'], note: 'here' } });
  await api.call('/api/lfg/status', { method: 'POST', user: 'alice', body: { looking: false } });

  const board = await api.call('/api/lfg/board', { user: 'bob' });
  assert.deepEqual(board.json.entries, []);
  // the last broadcast was the cleared board
  assert.deepEqual(api.broadcasts[api.broadcasts.length - 1], []);

  // and the stored state really is empty, not just filtered out
  const stored = api.models.User._all().find(user => user.username === 'alice');
  assert.deepEqual(stored.lfg.styles, []);
  assert.equal(stored.lfg.note, '');
});

test('a status save with bogus styles is a 400, and nothing is written', async t => {
  const api = await startApi();
  t.after(() => api.close());

  const res = await api.call('/api/lfg/status', { method: 'POST', user: 'alice', body: { looking: true, styles: 42 } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'invalid_styles');

  const board = await api.call('/api/lfg/board', { user: 'bob' });
  assert.deepEqual(board.json.entries, []);
});

test('the board shows newest status first', async t => {
  const api = await startApi();
  t.after(() => api.close());

  await api.call('/api/lfg/status', { method: 'POST', user: 'alice', body: { looking: true, styles: ['pro'] } });
  await new Promise(resolve => setTimeout(resolve, 5)); // distinct updatedAt
  await api.call('/api/lfg/status', { method: 'POST', user: 'bob', body: { looking: true, styles: ['dice'] } });

  const board = await api.call('/api/lfg/board', { user: 'alice' });
  assert.deepEqual(board.json.entries.map(entry => entry.username), ['bob', 'alice']);
});

test('a status save only ever touches the caller\'s own flag', async t => {
  const api = await startApi();
  t.after(() => api.close());

  // alice tries to flip bob's flag by naming him in the body
  await api.call('/api/lfg/status', {
    method: 'POST',
    user: 'alice',
    body: { looking: true, styles: ['pro'], username: 'bob' }
  });

  const board = await api.call('/api/lfg/board', { user: 'alice' });
  assert.deepEqual(board.json.entries.map(entry => entry.username), ['alice']);
});
