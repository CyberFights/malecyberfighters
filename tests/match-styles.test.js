/**
 * Match styles catalogue — the shared vocabulary of the LFG board, the
 * challenge form and the match record. Storage never sees a label, so the
 * important things to pin are the ids and what normalize() does with
 * whatever a client sends.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const matchStyles = require('../public/js/match-styles.js');

test('the catalogue exposes the styles the features were specced with', () => {
  const ids = matchStyles.catalogue().map(style => style.id);
  ['pro', 'submission', 'dice', 'freeform'].forEach(id => {
    assert.ok(ids.includes(id), `expected ${id} in the catalogue`);
  });
});

test('normalize keeps known ids, drops unknown ones and collapses duplicates', () => {
  const result = matchStyles.normalize(['pro', 'pro', 'nope', 'dice']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.styles, ['pro', 'dice']);
});

test('normalize caps a selection at MAX_STYLES', () => {
  const every = matchStyles.catalogue().map(style => style.id);
  const result = matchStyles.normalize(every);
  assert.equal(result.ok, true);
  assert.ok(result.styles.length <= matchStyles.MAX_STYLES);
  // and the cap keeps the first picks, in order
  assert.deepEqual(result.styles, every.slice(0, matchStyles.MAX_STYLES));
});

test('normalize accepts a comma-separated string', () => {
  const result = matchStyles.normalize('pro, dice ,FREEFORM');
  assert.equal(result.ok, true);
  assert.deepEqual(result.styles, ['pro', 'dice', 'freeform']);
});

test('normalize rejects a shape that is not a selection', () => {
  assert.equal(matchStyles.normalize(42).ok, false);
  assert.equal(matchStyles.normalize({ pro: true }).ok, false);
});

test('null and empty are valid (empty) selections', () => {
  assert.deepEqual(matchStyles.normalize(null).styles, []);
  assert.deepEqual(matchStyles.normalize([]).styles, []);
});

test('labels and icons resolve for stored ids', () => {
  assert.equal(matchStyles.label('pro'), 'Pro');
  assert.equal(typeof matchStyles.icon('dice'), 'string');
  assert.equal(matchStyles.label('not-a-style'), 'not-a-style');
});
