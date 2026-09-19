/**
 * Achievements — the catalogue predicates. Everything is a pure function of
 * (user document, event, context): no database, no sockets, nothing for a
 * client to forge.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { CATALOGUE, evaluate, catalogueView, catalogueEntry } = require('../achievements.js');

function member(fields = {}) {
  return { username: 'alpha', wins: 0, achievements: [], ...fields };
}

test('the first recorded match unlocks First Bell', () => {
  const fresh = evaluate({ user: member(), event: 'match_recorded', context: { match: { winner: 'alpha' } } });
  assert.deepEqual(fresh, ['first_match']);
});

test('an already-held achievement is never re-awarded', () => {
  const held = member({ achievements: [{ id: 'first_match', unlockedAt: new Date() }] });
  const fresh = evaluate({ user: held, event: 'match_recorded', context: {} });
  assert.deepEqual(fresh, []);
});

test('win milestones unlock at 10 and 25 wins', () => {
  const atTen = evaluate({ user: member({ wins: 10 }), event: 'match_recorded', context: {} });
  assert.deepEqual(atTen, ['first_match', 'wins_10']);

  const atTwentyFive = evaluate({ user: member({ wins: 25, achievements: [{ id: 'first_match' }, { id: 'wins_10' }] }), event: 'match_recorded', context: {} });
  assert.deepEqual(atTwentyFive, ['wins_25']);
});

test('Ironman needs a win that closed under 10 HP', () => {
  const comeback = evaluate({
    user: member({ achievements: [{ id: 'first_match' }] }),
    event: 'match_recorded',
    context: { match: { winner: 'alpha', closingHp: 8 } }
  });
  assert.ok(comeback.includes('ironman'));

  const dominant = evaluate({
    user: member({ achievements: [{ id: 'first_match' }] }),
    event: 'match_recorded',
    context: { match: { winner: 'alpha', closingHp: 42 } }
  });
  assert.ok(!dominant.includes('ironman'));

  // only the winner earns it
  const loser = evaluate({
    user: member({ achievements: [{ id: 'first_match' }] }),
    event: 'match_recorded',
    context: { match: { winner: 'bravo', closingHp: 3 } }
  });
  assert.ok(!loser.includes('ironman'));
});

test('a rivalry unlocks at three matches with the same opponent', () => {
  const fresh = evaluate({
    user: member({ achievements: [{ id: 'first_match' }] }),
    event: 'match_recorded',
    context: { opponentMatches: 3 }
  });
  assert.ok(fresh.includes('rival'));

  const notYet = evaluate({
    user: member({ achievements: [{ id: 'first_match' }] }),
    event: 'match_recorded',
    context: { opponentMatches: 2 }
  });
  assert.ok(!notYet.includes('rival'));
});

test('stories unlock at one and five publications', () => {
  const first = evaluate({ user: member(), event: 'story_published', context: { storyCount: 1 } });
  assert.deepEqual(first, ['first_story']);

  const fifth = evaluate({
    user: member({ achievements: [{ id: 'first_story' }] }),
    event: 'story_published',
    context: { storyCount: 5 }
  });
  assert.deepEqual(fifth, ['stories_5']);
});

test('the one-shot events unlock on their own event', () => {
  assert.deepEqual(evaluate({ user: member(), event: 'challenge_sent', context: {} }), ['challenger']);
  assert.deepEqual(evaluate({ user: member(), event: 'relationship_approved', context: {} }), ['allied']);
  assert.deepEqual(evaluate({ user: member(), event: 'forum_posted', context: {} }), ['first_post']);
});

test('unknown events unlock nothing', () => {
  assert.deepEqual(evaluate({ user: member(), event: 'something_else', context: {} }), []);
  assert.deepEqual(evaluate({ user: null, event: 'match_recorded', context: {} }), []);
});

test('catalogueView splits held from locked and keeps totals honest', () => {
  const user = member({ achievements: [{ id: 'first_match', unlockedAt: new Date('2026-01-01') }] });
  const view = catalogueView(user);
  assert.equal(view.total, CATALOGUE.length);
  assert.equal(view.unlocked.length, 1);
  assert.equal(view.unlocked[0].id, 'first_match');
  assert.ok(view.unlocked[0].unlockedAt);
  assert.equal(view.locked.length, CATALOGUE.length - 1);
  assert.ok(view.locked.every(entry => entry.unlockedAt === null));
});

test('a stored id with no catalogue entry stops being displayed', () => {
  const user = member({ achievements: [{ id: 'retired_badge' }, { id: 'first_match' }] });
  const view = catalogueView(user);
  assert.deepEqual(view.unlocked.map(entry => entry.id), ['first_match']);
  // and it is not shown as locked-again either (it is simply gone)
  assert.ok(!view.locked.some(entry => entry.id === 'retired_badge'));
});

test('catalogueEntry resolves ids', () => {
  assert.equal(catalogueEntry('first_match').title, 'First Bell');
  assert.equal(catalogueEntry('nope'), null);
});
