/**
 * Reactions — the toggle rules and the aggregate shape. A toggle, not a set:
 * re-sending your own current emoji removes it; sending a different one
 * switches it. Anything outside the allowed emoji never touches storage.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveToggle, aggregate, validTarget, isAllowedEmoji, ALLOWED_EMOJI } = require('../reactions.js');

test('resolveToggle: setting a new emoji', () => {
  assert.deepEqual(resolveToggle({ current: null, emoji: '🔥' }), { op: 'set', emoji: '🔥' });
  assert.deepEqual(resolveToggle({ current: '👍', emoji: '🔥' }), { op: 'set', emoji: '🔥' });
});

test('resolveToggle: re-sending your own emoji removes it', () => {
  assert.deepEqual(resolveToggle({ current: '🔥', emoji: '🔥' }), { op: 'remove' });
});

test('resolveToggle: an empty emoji clears whatever is set', () => {
  assert.deepEqual(resolveToggle({ current: '🔥', emoji: '' }), { op: 'remove' });
  assert.deepEqual(resolveToggle({ current: '🔥', emoji: null }), { op: 'remove' });
  assert.deepEqual(resolveToggle({ current: null, emoji: null }), { op: 'none' });
});

test('resolveToggle: unknown emoji are rejected before storage', () => {
  assert.deepEqual(resolveToggle({ current: null, emoji: '漢' }), { op: 'invalid' });
  assert.deepEqual(resolveToggle({ current: null, emoji: '👍👍' }), { op: 'invalid' });
});

test('isAllowedEmoji accepts the shipped set and nothing else', () => {
  ALLOWED_EMOJI.forEach(emoji => assert.equal(isAllowedEmoji(emoji), true));
  assert.equal(isAllowedEmoji('x'), false);
});

test('aggregate produces counts and a byUser map (last reaction wins per user)', () => {
  const result = aggregate([
    { emoji: '🔥', username: 'alpha' },
    { emoji: '🔥', username: 'bravo' },
    { emoji: '👍', username: 'charlie' },
    { emoji: '💪', username: 'alpha' } // alpha switched — the count must not double
  ]);
  assert.deepEqual(result.counts, { '🔥': 2, '👍': 1, '💪': 1 });
  assert.deepEqual(result.byUser, { alpha: '💪', bravo: '🔥', charlie: '👍' });
});

test('aggregate drops garbage rows instead of throwing', () => {
  const result = aggregate([null, { emoji: 'nope', username: 'x' }, { emoji: '🔥' }]);
  assert.deepEqual(result.counts, { '🔥': 1 });
});

test('validTarget: arena needs a message id, rooms also need a room', () => {
  assert.equal(validTarget({ scope: 'public', messageId: 'm1' }), true);
  assert.equal(validTarget({ scope: 'public' }), false);
  assert.equal(validTarget({ scope: 'room', room: 'r1', messageId: 'm1' }), true);
  assert.equal(validTarget({ scope: 'room', messageId: 'm1' }), false);
  assert.equal(validTarget({ scope: 'dm', messageId: 'm1' }), false);
  assert.equal(validTarget({ scope: 'public', room: 'r1' }), false);
});
