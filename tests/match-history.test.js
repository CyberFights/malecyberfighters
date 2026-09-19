/**
 * Match record — logged-match validation, head-to-head summaries and the
 * rivalry list. Draws move no counter; rivals need 3+ meetings.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateLoggedMatch, summarize, serializeMatch, RIVAL_THRESHOLD } = require('../matchHistory.js');
const matchStyles = require('../public/js/match-styles.js');

function engineMatch(fields = {}) {
  return {
    _id: 'm1',
    winner: 'alpha',
    loser: 'bravo',
    draw: false,
    styles: ['pro'],
    bestOf: 1,
    source: 'engine',
    status: 'confirmed',
    createdAt: new Date('2026-09-19T00:00:00Z'),
    ...fields
  };
}

test('validateLoggedMatch requires a boolean outcome and at least one style', () => {
  assert.equal(validateLoggedMatch({ styles: [] }, matchStyles).error, 'missing_styles');
  assert.equal(validateLoggedMatch({ styles: ['pro'], won: 'yes' }, matchStyles).error, 'missing_outcome');
  assert.equal(validateLoggedMatch({ styles: ['pro'] }, matchStyles).error, 'missing_outcome');
});

test('validateLoggedMatch normalizes styles and caps notes', () => {
  const result = validateLoggedMatch(
    { styles: ['pro', 'nope'], won: true, notes: 'z'.repeat(900) },
    matchStyles
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.match.styles, ['pro']);
  assert.equal(result.match.won, true);
  assert.ok(result.match.notes.length <= 500);
});

test('summarize counts outcomes from the viewer side and finds rivals', () => {
  const matches = [
    engineMatch(), // alpha beats bravo
    engineMatch({ winner: 'bravo', loser: 'alpha' }),
    engineMatch(),
    engineMatch({ winner: 'alpha', loser: 'charlie' }),
    engineMatch({ winner: 'charlie', loser: 'alpha' })
  ];
  const summary = summarize(matches, 'alpha');
  assert.equal(summary.matches, 5);
  assert.equal(summary.wins, 3);
  assert.equal(summary.losses, 2);
  assert.equal(summary.draws, 0);
  // bravo has 3 meetings → a rivalry; charlie only 2
  assert.deepEqual(summary.rivals.map(row => row.opponent), ['bravo']);
  assert.equal(summary.rivals[0].wins, 2);
  assert.equal(summary.rivals[0].losses, 1);
});

test('draws count as meetings but move no counter', () => {
  const matches = [
    engineMatch({ draw: true }),
    engineMatch({ draw: true }),
    engineMatch({ draw: true })
  ];
  const summary = summarize(matches, 'alpha');
  assert.equal(summary.matches, 3);
  assert.equal(summary.draws, 3);
  assert.equal(summary.wins, 0);
  assert.equal(summary.losses, 0);
  // three drawn meetings is still a rivalry — with no W/L either way
  assert.deepEqual(summary.rivals, [{ opponent: 'bravo', matches: 3, wins: 0, losses: 0 }]);
});

test('pending records never reach the summary', () => {
  const summary = summarize([engineMatch({ status: 'pending' })], 'alpha');
  assert.equal(summary.matches, 0);
});

test('matches the viewer is not part of are ignored', () => {
  const summary = summarize([engineMatch()], 'zeta');
  assert.equal(summary.matches, 0);
});

test('serializeMatch reports the outcome from the viewer\'s corner', () => {
  const mine = serializeMatch(engineMatch(), 'alpha');
  assert.equal(mine.outcome, 'win');
  assert.equal(mine.opponent, 'bravo');

  const theirs = serializeMatch(engineMatch(), 'bravo');
  assert.equal(theirs.outcome, 'loss');
  assert.equal(theirs.opponent, 'alpha');

  const drawn = serializeMatch(engineMatch({ draw: true }), 'alpha');
  assert.equal(drawn.outcome, 'draw');
});

test('the rivalry threshold is three meetings', () => {
  assert.equal(RIVAL_THRESHOLD, 3);
});
