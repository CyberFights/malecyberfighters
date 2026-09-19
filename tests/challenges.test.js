/**
 * Challenges — the pre-match terms enforcement. The beginner's guide makes
 * agreeing terms the point of a challenge; the module makes it a checklist
 * the server actually checks before the offer exists.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateChallenge, serializeChallenge, TERMS } = require('../challenges.js');
const matchStyles = require('../public/js/match-styles.js');

const ALL_TERMS = TERMS.map(term => term.id);

function validBody() {
  return { to: 'opponent', styles: ['pro'], terms: ALL_TERMS.slice(), bestOf: 3, stakes: 'bragging rights', note: '' };
}

test('a complete challenge passes', () => {
  const result = validateChallenge(validBody(), matchStyles);
  assert.equal(result.ok, true);
  assert.deepEqual(result.challenge.styles, ['pro']);
  assert.deepEqual(result.challenge.terms, ALL_TERMS);
  assert.equal(result.challenge.bestOf, 3);
});

test('styles are required', () => {
  const body = validBody();
  body.styles = [];
  assert.equal(validateChallenge(body, matchStyles).error, 'missing_styles');
});

test('unknown style ids are dropped, not trusted', () => {
  const body = validBody();
  body.styles = ['pro', 'madeup'];
  const result = validateChallenge(body, matchStyles);
  assert.deepEqual(result.challenge.styles, ['pro']);
});

test('terms are required — the point of the feature', () => {
  const body = validBody();
  body.terms = ALL_TERMS.slice(0, ALL_TERMS.length - 1);
  const result = validateChallenge(body, matchStyles);
  assert.equal(result.error, 'terms_not_agreed');
});

test('missing terms are exactly what the error reports', () => {
  const body = validBody();
  body.terms = ['style', 'limits', 'stakes', 'finish'];
  const result = validateChallenge(body, matchStyles);
  assert.equal(result.error, 'terms_not_agreed');
  assert.deepEqual(result.missing, ['safeword']);
});

test('unknown term ids do not count as agreed', () => {
  const body = validBody();
  body.terms = [...ALL_TERMS.slice(1), 'trust_me'];
  const result = validateChallenge(body, matchStyles);
  assert.equal(result.error, 'terms_not_agreed');
  assert.deepEqual(result.missing, ['style']);
});

test('best-of defaults to a single fall when not one of the offered lengths', () => {
  [-1, 0, 2, 7, 'three'].forEach(value => {
    const body = validBody();
    body.bestOf = value;
    assert.equal(validateChallenge(body, matchStyles).challenge.bestOf, 1, `bestOf=${value}`);
  });
});

test('stakes and notes are cleaned and capped', () => {
  const body = validBody();
  body.stakes = ' x \r\n y '.padEnd(500, 'z');
  body.note = 'q'.repeat(500);
  const result = validateChallenge(body, matchStyles);
  assert.ok(result.challenge.stakes.length <= 200);
  assert.ok(result.challenge.note.length <= 300);
  assert.ok(!result.challenge.stakes.includes('\r'));
});

test('serializeChallenge keeps the public face and hides internals', () => {
  const doc = {
    _id: 'abc123',
    from: 'me',
    to: 'you',
    styles: ['pro'],
    terms: ALL_TERMS.slice(),
    bestOf: 1,
    stakes: 'none',
    note: '',
    status: 'pending',
    room: 'room-1',
    rematchOf: null,
    createdAt: new Date('2026-09-19T00:00:00Z'),
    respondedAt: null
  };
  const out = serializeChallenge(doc);
  assert.equal(out._id, 'abc123');
  assert.equal(out.from, 'me');
  assert.equal(out.room, 'room-1');
  assert.ok(!('updatedAt' in out));
});
