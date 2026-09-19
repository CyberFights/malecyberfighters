/**
 * Reports — the validation between the ⚠ button and the moderation queue.
 * A user report needs a named member; an app-issue report does not. Reason
 * must come from the catalogue, and the snippet is capped because it is
 * copied onto the report as evidence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateReport, isAllowedReason, summarizeForDispatch, serializeReport, REASONS } = require('../reports.js');

test('a user report passes with reason, target and snippet', () => {
  const result = validateReport({
    kind: 'user',
    targetUser: 'troublemaker',
    reason: 'harassment',
    scope: 'public',
    messageId: 'm42',
    snippet: 'you stink and so does your finisher',
    details: 'third time this week'
  });
  assert.equal(result.ok, true);
  assert.equal(result.report.kind, 'user');
  assert.equal(result.report.targetUser, 'troublemaker');
  assert.equal(result.report.reason, 'harassment');
  assert.equal(result.report.scope, 'public');
});

test('a user report without a target is rejected', () => {
  const result = validateReport({ kind: 'user', reason: 'harassment', scope: 'public' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_target');
});

test('an app issue does not name a member and passes', () => {
  const result = validateReport({ kind: 'issue', reason: 'other', details: 'upload button spins forever' });
  assert.equal(result.ok, true);
  assert.equal(result.report.kind, 'issue');
  assert.equal(result.report.targetUser, null);
});

test('reasons outside the catalogue are rejected', () => {
  assert.equal(validateReport({ kind: 'user', targetUser: 'x', reason: 'i_dont_like_him' }).error, 'invalid_reason');
  assert.equal(isAllowedReason('harassment'), true);
  assert.equal(isAllowedReason('revenge'), false);
});

test('unknown scopes fall back to "other" instead of being trusted', () => {
  const result = validateReport({ kind: 'user', targetUser: 'x', reason: 'spam', scope: 'galaxy' });
  assert.equal(result.report.scope, 'other');
});

test('snippets and details are capped', () => {
  const result = validateReport({
    kind: 'user', targetUser: 'x', reason: 'spam',
    snippet: 's'.repeat(1000), details: 'd'.repeat(5000)
  });
  assert.ok(result.report.snippet.length <= 300);
  assert.ok(result.report.details.length <= 2000);
});

test('the catalogue carries the moderation reasons the site needs', () => {
  const ids = REASONS.map(reason => reason.id);
  ['harassment', 'hate', 'spam', 'minor', 'other'].forEach(id => {
    assert.ok(ids.includes(id), `expected ${id}`);
  });
});

test('summarizeForDispatch writes one webhook-friendly line', () => {
  const line = summarizeForDispatch({
    _id: '66f1aaaaaaaaaaaaaaaaaaaa',
    reporter: 'alpha',
    targetUser: 'bravo',
    reason: 'harassment',
    room: 'penthouse'
  });
  assert.match(line, /Report #aaaaaa/);
  assert.match(line, /by alpha/);
  assert.match(line, /about @bravo/);
  assert.match(line, /\(harassment in penthouse\)/);
});

test('serializeReport shows the open/closed state', () => {
  const out = serializeReport({ _id: 'r1', reporter: 'a', reason: 'spam', status: 'open' });
  assert.equal(out.status, 'open');
  assert.equal(out.resolution, '');
});
