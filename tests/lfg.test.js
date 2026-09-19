/**
 * LFG board — server-side validation. The interesting rule: a member who
 * switches themselves off keeps nothing but the timestamp of the switch, so
 * the board never shows stale styles or notes from a previous session.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeStatus, boardEntry } = require('../lfg.js');
const matchStyles = require('../public/js/match-styles.js');

function baseUser() {
  return {
    username: 'grappler',
    display: 'The Grappler',
    imageUrl: '',
    online: true,
    lastSeenAt: new Date('2026-09-19T10:00:00Z'),
    lfg: { looking: true, styles: ['pro', 'dice'], note: 'best of 3 tonight', updatedAt: new Date() }
  };
}

test('normalizeStatus stores a cleaned note and normalized styles', () => {
  const result = normalizeStatus({ looking: true, styles: ['pro', 'pro', 'bogus'], note: '  pro match, send an invite ' }, matchStyles);
  assert.equal(result.ok, true);
  assert.deepEqual(result.status, {
    looking: true,
    styles: ['pro'],
    note: 'pro match, send an invite',
    updatedAt: result.status.updatedAt
  });
});

test('looking: false wipes styles and note', () => {
  const result = normalizeStatus({ looking: false, styles: ['pro'], note: 'catch me never' }, matchStyles);
  assert.equal(result.ok, true);
  assert.deepEqual(result.status, { looking: false, styles: [], note: '', updatedAt: result.status.updatedAt });
});

test('notes are capped and control characters stripped', () => {
  const result = normalizeStatus({ looking: true, note: 'a'.repeat(300) + '\x00' }, matchStyles);
  assert.equal(result.status.note.length, 140);
  assert.ok(!result.status.note.includes('\x00'));
});

test('styles are capped at the shared MAX_STYLES', () => {
  const result = normalizeStatus({ looking: true, styles: ['pro', 'submission', 'dice', 'freeform'] }, matchStyles);
  assert.ok(result.status.styles.length <= matchStyles.MAX_STYLES);
});

test('a bogus styles payload is rejected, not silently emptied', () => {
  assert.equal(normalizeStatus({ looking: true, styles: 42 }, matchStyles).ok, false);
  assert.equal(normalizeStatus({ looking: true, styles: { pro: true } }, matchStyles).ok, false);
  // the shared comma-separated form is fine — the LFG toggle sends it
  assert.equal(normalizeStatus({ looking: true, styles: 'pro, dice' }, matchStyles).ok, true);
});

test('boardEntry carries only what the board renders', () => {
  const entry = boardEntry(baseUser());
  assert.deepEqual(Object.keys(entry).sort(), [
    'color', 'display', 'height', 'imageUrl', 'lastSeenAt', 'note', 'online',
    'styles', 'updatedAt', 'username', 'weight'
  ].sort());
  assert.equal(entry.username, 'grappler');
  assert.deepEqual(entry.styles, ['pro', 'dice']);
});

test('boardEntry returns null for a member not looking', () => {
  assert.equal(boardEntry({ username: 'newguy' }), null);
  assert.equal(boardEntry({ username: 'newguy', lfg: { looking: false } }), null);
});
