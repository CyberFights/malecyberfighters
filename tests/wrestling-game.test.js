const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WG = require('../wrestlingGame.js');

test('move catalogs and categories are defined and complete', () => {
  assert.ok(Array.isArray(WG.HOLDS) && WG.HOLDS.length >= 5);
  assert.ok(Array.isArray(WG.POWER_MOVES) && WG.POWER_MOVES.length >= 5);
  assert.ok(Array.isArray(WG.SUBMISSIONS) && WG.SUBMISSIONS.length >= 5);
  assert.ok(Array.isArray(WG.TACTICS) && WG.TACTICS.length >= 4);

  assert.deepEqual(WG.HOLDS, ['sleeper-hold', 'bearhug', 'headlock', 'full-nelson', 'hammerlock']);
  assert.deepEqual(WG.POWER_MOVES, ['suplex', 'powerbomb', 'chokeslam', 'spinebuster', 'piledriver']);
  assert.deepEqual(WG.SUBMISSIONS, ['boston-crab', 'figure-four', 'armbar', 'sharpshooter', 'triangle-choke']);

  WG.HOLDS.forEach(id => {
    assert.equal(WG.MOVES[id].category, 'hold');
  });
  WG.POWER_MOVES.forEach(id => {
    assert.equal(WG.MOVES[id].category, 'power');
  });
  WG.SUBMISSIONS.forEach(id => {
    assert.equal(WG.MOVES[id].category, 'submission');
  });
});

test('every move references an image file that exists in public/images/moves/', () => {
  const movesDir = path.join(__dirname, '..', 'public');
  Object.keys(WG.MOVES).forEach(id => {
    const move = WG.MOVES[id];
    assert.ok(move.image, `Move ${id} must specify an image`);
    const filePath = path.join(movesDir, move.image.replace(/^\//, ''));
    assert.ok(fs.existsSync(filePath), `Image file for ${id} must exist at ${filePath}`);
  });
});

test('holds deal steady control damage and drain opponent stamina', () => {
  const p = WG.createWrestler({ name: 'Grappler', stats: { strength: 60, skill: 70, stamina: 60, agility: 50, charisma: 40 } });
  const o = WG.createWrestler({ name: 'Brawler', stats: { strength: 50, skill: 40, stamina: 50, agility: 40, charisma: 40 } });

  const match = WG.newMatch(p, o);
  const oppInitialStamina = match.opponent.stamina;

  WG.resolveTurn(match, 'sleeper-hold');

  assert.ok(match.opponent.hp < match.opponent.maxHp, 'Opponent should take damage from sleeper hold');
  assert.ok(match.opponent.stamina < oppInitialStamina, 'Opponent stamina should be drained');
  assert.equal(match.player.lastMove.category, 'hold');
  assert.equal(match.player.lastMove.name, 'Sleeper Hold');
  assert.ok(match.player.lastMove.image.includes('sleeper-hold'));
});

test('power moves deal high impact damage with critical slam chance', () => {
  const p = WG.createWrestler({ name: 'Powerhouse', stats: { strength: 80, skill: 60, stamina: 70, agility: 50, charisma: 50 } });
  const o = WG.createWrestler({ name: 'Opponent', stats: { strength: 40, skill: 40, stamina: 40, agility: 30, charisma: 30 } });

  const match = WG.newMatch(p, o);
  WG.resolveTurn(match, 'powerbomb');

  assert.equal(match.player.lastMove.category, 'power');
  assert.equal(match.player.lastMove.name, 'Powerbomb');
  assert.ok(match.player.lastMove.damage >= 20, 'Powerbomb should deal heavy damage');
});

test('submissions inflict damage and can trigger tap-out victory on weakened foes', () => {
  const p = WG.createWrestler({ name: 'Submissionist', stats: { strength: 75, skill: 85, stamina: 70, agility: 60, charisma: 50 } });
  const o = WG.createWrestler({ name: 'Target', stats: { strength: 30, skill: 30, stamina: 30, agility: 30, charisma: 30 } });

  // 1. When opponent is full health, submission does damage without immediate tap-out
  const matchHealthy = WG.newMatch(p, o);
  WG.resolveTurn(matchHealthy, 'boston-crab');
  assert.ok(matchHealthy.opponent.hp > 0, 'Healthy opponent should not immediately tap out');
  assert.equal(matchHealthy.player.lastMove.category, 'submission');
  assert.equal(matchHealthy.player.lastMove.name, 'Boston Crab');

  // 2. When opponent is low on HP and stamina, submission triggers tap out
  let tapOutHappened = false;
  for (let i = 0; i < 20; i++) {
    const matchWeak = WG.newMatch(p, o);
    matchWeak.opponent.hp = 10;
    matchWeak.opponent.stamina = 5;
    WG.resolveTurn(matchWeak, 'armbar');
    if (matchWeak.status === 'player_win' && matchWeak.winType === 'submission') {
      tapOutHappened = true;
      assert.ok(matchWeak.log.some(l => l.includes('TAP OUT')), 'Log should record tap out event');
      break;
    }
  }
  assert.ok(tapOutHappened, 'A weakened opponent must be capable of tapping out to a submission');
});

test('tactics (block, taunt, rest) function as tactical utility moves', () => {
  const p = WG.createWrestler({ name: 'Tactician', stats: { strength: 50, skill: 50, stamina: 50, agility: 50, charisma: 80 } });
  const o = WG.createWrestler({ name: 'Opponent', stats: { strength: 50, skill: 50, stamina: 50, agility: 50, charisma: 40 } });

  const match = WG.newMatch(p, o);

  // Test Taunt: drains opponent stamina and uses charisma
  const initOppStam = match.opponent.stamina;
  WG.resolveTurn(match, 'taunt');
  assert.ok(match.opponent.stamina < initOppStam);

  // Test Rest: recovers stamina
  match.player.stamina = 10;
  WG.resolveTurn(match, 'rest');
  assert.ok(match.player.stamina > 10, 'Player should recover stamina after resting');

  // Test Block: mitigates incoming attack
  match.player.blocking = true;
  const rawDmg = WG.actionDamage('strike', match.opponent, match.player);
  WG.applyAction(match, 'opponent', 'strike');
  assert.ok(match.opponent.lastMove.blocked, 'Move should be recorded as blocked');
});

test('opponent AI selects varied moves including holds, power moves, and submissions', () => {
  const p = WG.createWrestler({ name: 'Player', stats: { strength: 60, skill: 60, stamina: 60, agility: 60, charisma: 60 } });
  const o = WG.createWrestler({ name: 'AI Opponent', stats: { strength: 70, skill: 70, stamina: 70, agility: 60, charisma: 60 } });

  const chosenMoves = new Set();
  for (let i = 0; i < 80; i++) {
    const match = WG.newMatch(p, o);
    const action = WG.chooseOpponentAction(match.opponent, match);
    chosenMoves.add(action);
  }

  // Ensure AI explores multiple move types
  assert.ok(chosenMoves.size >= 3, 'AI should choose among multiple different moves');
  const hasHoldOrPowerOrSub = [...chosenMoves].some(m =>
    WG.HOLDS.includes(m) || WG.POWER_MOVES.includes(m) || WG.SUBMISSIONS.includes(m)
  );
  assert.ok(hasHoldOrPowerOrSub, 'AI should execute holds, power moves, or submissions');
});

test('legacy action names remain backwards compatible', () => {
  const p = WG.createWrestler({ name: 'P1', stats: {} });
  const o = WG.createWrestler({ name: 'P2', stats: {} });
  const match = WG.newMatch(p, o);

  // Legacy 'grapple' action
  WG.resolveTurn(match, 'grapple');
  assert.ok(match.player.lastMove, 'Legacy grapple should resolve cleanly');

  // Legacy 'strike' action
  WG.resolveTurn(match, 'strike');
  assert.ok(match.player.lastMove, 'Legacy strike should resolve cleanly');
});
