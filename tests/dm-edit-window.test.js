/**
 * DM edit/delete windows. Editing: author-only, text messages only, inside a
 * 15 minute window (a clock skew of up to a minute is forgiven). Deleting:
 * author-only, no time limit — on an 18+ site "take that back" is a safety
 * feature; the tombstone keeps the thread honest.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { canEditDM, canDeleteDM, DM_EDIT_WINDOW_MS } = require('../dmDelivery.js');

const NOW = new Date('2026-09-19T12:00:00Z').getTime();

function dm(fields = {}) {
  return { from: 'alpha', to: 'bravo', text: 'hello', time: new Date(NOW - 60 * 1000).toISOString(), ...fields };
}

test('the author can edit their own fresh text message', () => {
  assert.equal(canEditDM(dm(), 'alpha', NOW), true);
});

test('nobody but the author edits anything', () => {
  assert.equal(canEditDM(dm(), 'bravo', NOW), false);
  assert.equal(canEditDM(dm(), 'charlie', NOW), false);
});

test('the edit window is fifteen minutes and not one second more', () => {
  assert.equal(DM_EDIT_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(canEditDM(dm({ time: new Date(NOW - DM_EDIT_WINDOW_MS + 1000).toISOString() }), 'alpha', NOW), true);
  assert.equal(canEditDM(dm({ time: new Date(NOW - DM_EDIT_WINDOW_MS - 1000).toISOString() }), 'alpha', NOW), false);
});

test('deleted messages and attachments cannot be edited', () => {
  assert.equal(canEditDM(dm({ deleted: true }), 'alpha', NOW), false);
  assert.equal(canEditDM(dm({ imageUrl: 'x.png' }), 'alpha', NOW), false);
  assert.equal(canEditDM(dm({ clipUrl: 'x.webm' }), 'alpha', NOW), false);
});

test('a message with no parseable time is not editable', () => {
  assert.equal(canEditDM({ from: 'alpha', text: 'x' }, 'alpha', NOW), false);
});

test('clock skew up to a minute in the future is forgiven', () => {
  assert.equal(canEditDM(dm({ time: new Date(NOW + 30 * 1000).toISOString() }), 'alpha', NOW), true);
  assert.equal(canEditDM(dm({ time: new Date(NOW + 5 * 60 * 1000).toISOString() }), 'alpha', NOW), false);
});

test('the author can always delete their own message — no time limit', () => {
  assert.equal(canDeleteDM(dm({ time: new Date(NOW - 90 * 24 * 60 * 60 * 1000).toISOString() }), 'alpha'), true);
});

test('deleting is author-only and once-only', () => {
  assert.equal(canDeleteDM(dm(), 'bravo'), false);
  assert.equal(canDeleteDM(dm({ deleted: true }), 'alpha'), false);
  assert.equal(canDeleteDM(null, 'alpha'), false);
});
