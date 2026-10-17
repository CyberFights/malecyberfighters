(function (factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") {
    window.WrestlingGame = api;
    window.wrestlingGame = api;
    window.Wrestling = api;
    window.Gym = api;
    window.gym = api;
  }
})(function () {
  "use strict";
'use strict';

/**
 * Wrestling game — shared rules.
 *
 * Pure logic used by both the browser page and any server-side tests:
 *   - the five trainable stats (strength, agility, stamina, skill, charisma)
 *   - creating a wrestler (custom name + image + stats)
 *   - training a stat at the gym
 *   - picking a random opponent from the roster
 *   - resolving a turn-based match
 */

const STATS = ['strength', 'agility', 'stamina', 'skill', 'charisma'];
const STAT_MIN = 0;
const STAT_MAX = 100;
const STARTING_STAT = 5;
const MAX_STAT = 100;
const TRAIN_AMOUNT = 1;

// ---- Gym energy system ----
// Energy regenerates over time. Training costs energy that scales with the
// current value of the stat being trained — higher stats need more recovery.
const GYM_ENERGY_MAX = 10;
const GYM_ENERGY_REGEN_MS = 5 * 60 * 1000; // 1 energy every 5 minutes
const GYM_ENERGY_START = GYM_ENERGY_MAX;   // new users start full

function trainCost(statValue) {
  // 1 energy up to 24, 2 up to 49, 3 up to 74, 4 from 75+
  const v = Math.max(0, Math.min(STAT_MAX, Number(statValue) || 0));
  if (v >= 75) return 4;
  return 1 + Math.floor(v / 25);
}

// Returns { current, max, nextInMs } based on stored snapshot + elapsed time.
function gymEnergyState(statsObj, now) {
  const s = statsObj || {};
  const max = (typeof s.gymEnergyMax === 'number' && s.gymEnergyMax > 0) ? s.gymEnergyMax : GYM_ENERGY_MAX;
  const nowTs = (typeof now === 'number') ? now : Date.now();
  let current = (typeof s.gymEnergy === 'number') ? s.gymEnergy : GYM_ENERGY_START;
  let last = (typeof s.gymEnergyAt === 'number') ? s.gymEnergyAt : nowTs;
  if (current < 0) current = 0;
  if (current > max) current = max;
  if (last > nowTs) last = nowTs;
  if (current < max) {
    const elapsed = nowTs - last;
    const gained = Math.floor(elapsed / GYM_ENERGY_REGEN_MS);
    if (gained > 0) {
      current = Math.min(max, current + gained);
      last = last + gained * GYM_ENERGY_REGEN_MS;
    }
  } else {
    last = nowTs;
  }
  const nextInMs = (current >= max) ? 0 : Math.max(0, GYM_ENERGY_REGEN_MS - (nowTs - last));
  return { current: current, max: max, lastAt: last, nextInMs: nextInMs };
}

const ACTIONS = ['strike', 'grapple', 'taunt', 'block', 'rest'];

function defaultStats() {
  const out = {};
  STATS.forEach(function (s) { out[s] = STARTING_STAT; });
  // seed gym energy at full, timestamped now so regen works from "first visit"
  out.gymEnergy = GYM_ENERGY_START;
  out.gymEnergyMax = GYM_ENERGY_MAX;
  out.gymEnergyAt = Date.now();
  return out;
}

function cleanName(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 40);
}

function normalizeStats(value) {
  const out = defaultStats();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.wrestler && typeof value.wrestler === 'object') out.wrestler = value.wrestler;
    // Preserve gym energy fields if present and valid, otherwise leave defaults
    if (typeof value.gymEnergy === 'number' && isFinite(value.gymEnergy)) {
      out.gymEnergy = Math.max(0, Math.min(out.gymEnergyMax, value.gymEnergy));
    }
    if (typeof value.gymEnergyMax === 'number' && isFinite(value.gymEnergyMax) && value.gymEnergyMax > 0) {
      out.gymEnergyMax = Math.max(1, Math.round(value.gymEnergyMax));
      if (out.gymEnergy > out.gymEnergyMax) out.gymEnergy = out.gymEnergyMax;
    }
    if (typeof value.gymEnergyAt === 'number' && isFinite(value.gymEnergyAt)) {
      out.gymEnergyAt = value.gymEnergyAt;
    }
    STATS.forEach(function (stat) {
      if (Object.prototype.hasOwnProperty.call(value, stat)) {
        const n = Number(value[stat]);
        if (isFinite(n)) {
          out[stat] = Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round(n)));
        }
      }
    });
  }
  return out;
}

function createWrestler(payload) {
  const body = payload || {};
  const name = cleanName(body.name || body.username || 'Wrestler');
  const image = typeof body.image === 'string' ? body.image : (typeof body.imageUrl === 'string' ? body.imageUrl : '');
  return {
    name: name || 'Wrestler',
    image: image,
    stats: normalizeStats(body.stats),
    createdAt: new Date().toISOString()
  };
}

function fromProfile(user) {
  const u = user || {};
  const stats = normalizeStats(u.stats || u);
  // If the profile only carries atk/def, seed a couple of stats from them.
  if (u.atk != null && (!u.stats || u.stats.strength == null)) {
    stats.strength = Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round((Number(u.atk) || 0) * 10)));
  }
  if (u.def != null && (!u.stats || u.stats.stamina == null)) {
    stats.stamina = Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round((Number(u.def) || 0) * 10)));
  }
  return createWrestler({ name: u.display || u.username, image: u.imageUrl, stats: stats });
}

function train(stats, stat, amount) {
  const s = normalizeStats(stats);
  const target = String(stat || '').trim().toLowerCase();
  if (STATS.indexOf(target) === -1) {
    return { ok: false, error: 'invalid_stat' };
  }
  const amt = isFinite(Number(amount)) ? Number(amount) : TRAIN_AMOUNT;
  if (amt <= 0) return { ok: false, error: 'invalid_amount' };
  s[target] = Math.min(STAT_MAX, s[target] + Math.round(amt));
  return { ok: true, stats: s, stat: target, amount: Math.round(amt) };
}

// Spend gym energy to train. `now` defaults to Date.now() on the server/browser.
// Rejects with error 'no_energy' (and returns retryAfterMs) when the user doesn't
// have enough energy even after regen. Career mode calls the free `train()`
// directly, bypassing gym energy.
function gymTrain(stats, stat, amount, now) {
  const target = String(stat || '').trim().toLowerCase();
  if (STATS.indexOf(target) === -1) return { ok: false, error: 'invalid_stat' };
  const nowTs = (typeof now === 'number') ? now : Date.now();
  // Apply regen to get current energy state from stored values
  const regen = gymEnergyState(stats, nowTs);
  const s = normalizeStats(stats);
  // Carry regen-calculated current energy forward as the new starting point
  s.gymEnergy = regen.current;
  s.gymEnergyAt = regen.lastAt;
  // Cost is based on the stat value BEFORE increment
  const beforeVal = s[target];
  if (beforeVal >= STAT_MAX) return { ok: false, error: 'stat_max' };
  const cost = trainCost(beforeVal);
  if (s.gymEnergy < cost) {
    // Compute how long until enough energy regens
    const need = cost - s.gymEnergy;
    const retryAfterMs = (need > 0 ? need : 1) * GYM_ENERGY_REGEN_MS - (nowTs - regen.lastAt);
    return { ok: false, error: 'no_energy', cost: cost, gymEnergy: s.gymEnergy, gymEnergyMax: s.gymEnergyMax, retryAfterMs: Math.max(0, retryAfterMs) };
  }
  // Apply the stat gain
  const amt = isFinite(Number(amount)) ? Math.round(Number(amount)) : TRAIN_AMOUNT;
  if (amt <= 0) return { ok: false, error: 'invalid_amount' };
  s[target] = Math.min(STAT_MAX, beforeVal + amt);
  // Spend energy. If the stat crossed a cost tier this very train, we still
  // charged the pre-tier cost, which is fine (one-time grace).
  s.gymEnergy = Math.max(0, s.gymEnergy - cost);
  return {
    ok: true,
    stats: s,
    stat: target,
    amount: amt,
    cost: cost,
    gymEnergy: s.gymEnergy,
    gymEnergyMax: s.gymEnergyMax,
    nextEnergyInMs: (s.gymEnergy >= s.gymEnergyMax) ? 0 : GYM_ENERGY_REGEN_MS - (nowTs - s.gymEnergyAt)
  };
}

function trainAll(stats, amount) {
  const s = normalizeStats(stats);
  const amt = isFinite(Number(amount)) ? Number(amount) : TRAIN_AMOUNT;
  STATS.forEach(function (st) { s[st] = Math.min(STAT_MAX, s[st] + Math.round(amt)); });
  return { ok: true, stats: s };
}

function pickOpponent(roster, exclude) {
  const list = Array.isArray(roster) ? roster : [];
  const candidates = list.filter(function (u) {
    return !exclude || (u && u.username !== exclude);
  });
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function opponentWrestler(user) {
  const u = user || {};
  let stats = normalizeStats(u.stats);
  // derive from atk/def when stats are empty/default
  const allDefault = STATS.every(function (s) { return stats[s] === STARTING_STAT; });
  if (allDefault) {
    if (u.atk != null) stats.strength = Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round((Number(u.atk) || 0) * 10)));
    if (u.def != null) stats.stamina = Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round((Number(u.def) || 0) * 10)));
    stats.agility = Math.max(STAT_MIN, Math.min(STAT_MAX, stats.agility + Math.round((Number(u.atk) || 0) * 2)));
    stats.skill = Math.max(STAT_MIN, Math.min(STAT_MAX, stats.skill + Math.round((Number(u.def) || 0) * 2)));
  }
  return createWrestler({ name: u.display || u.username || 'Opponent', image: u.imageUrl, stats: stats });
}

function hpFor(stats) {
  const s = normalizeStats(stats);
  return 80 + Math.round(s.stamina * 0.4 + s.strength * 0.2);
}

function staminaFor(stats) {
  const s = normalizeStats(stats);
  return 60 + Math.round(s.stamina * 0.4);
}

function chooseOpponentAction(opp, state) {
  const s = opp.stats || defaultStats();
  const hp = state.opponent.hp;
  const maxHp = state.opponent.maxHp;
  const ratio = maxHp ? hp / maxHp : 1;
  if (ratio < 0.25) return 'rest';
  if (ratio < 0.4) return 'block';
  if (s.stamina > 60 && Math.random() < 0.5) return 'strike';
  if (s.skill > 60 && Math.random() < 0.4) return 'grapple';
  if (s.charisma > 60 && Math.random() < 0.3) return 'taunt';
  return 'strike';
}

function actionDamage(action, attacker, defender) {
  const a = normalizeStats(attacker.stats);
  const d = normalizeStats(defender.stats);
  let base = 0;
  if (action === 'strike') base = a.strength * 1.2 + a.skill * 0.4;
  else if (action === 'grapple') base = a.skill * 1.3 + a.strength * 0.3;
  else if (action === 'taunt') base = a.charisma * 0.6;
  else base = 0;
  // defense mitigation
  const mit = 1 + d.agility * 0.02 + d.stamina * 0.01;
  let dmg = Math.max(1, Math.round(base / mit));
  if (action === 'taunt') dmg = Math.max(0, Math.round(base / mit));
  return dmg;
}

function applyAction(state, who, action) {
  const attacker = who === 'player' ? state.player : state.opponent;
  const defender = who === 'player' ? state.opponent : state.player;
  const key = who;
  const oppKey = who === 'player' ? 'opponent' : 'player';

  let logLine = '';
  if (action === 'rest') {
    const gain = 10 + Math.round(attacker.stats.stamina * 0.1);
    attacker.stamina = Math.min(attacker.maxStamina, attacker.stamina + gain);
    logLine = attacker.name + ' rests and recovers ' + gain + ' stamina.';
  } else if (action === 'block') {
    attacker.blocking = true;
    logLine = attacker.name + ' braces for impact.';
  } else {
    let dmg = actionDamage(action, attacker, defender);
    if (defender.blocking) {
      dmg = Math.max(1, Math.round(dmg * 0.4));
      defender.blocking = false;
    }
    defender.hp = Math.max(0, defender.hp - dmg);
    // stamina cost
    const cost = action === 'grapple' ? 12 : (action === 'strike' ? 8 : 5);
    attacker.stamina = Math.max(0, attacker.stamina - cost);
    logLine = attacker.name + ' uses ' + action + ' for ' + dmg + ' damage.';
    if (action === 'taunt') {
      // charisma bonus: small hp drain already counted; add stamina drain to opponent
      defender.stamina = Math.max(0, defender.stamina - Math.round(attacker.stats.charisma * 0.2));
    }
  }
  state.log = state.log || [];
  state.log.push(logLine);
  return state;
}

function newMatch(playerWrestler, opponentWrestlerObj) {
  const p = playerWrestler;
  const o = opponentWrestlerObj;
  const player = {
    name: p.name, image: p.image, stats: normalizeStats(p.stats),
    hp: hpFor(p.stats), maxHp: hpFor(p.stats),
    stamina: staminaFor(p.stats), maxStamina: staminaFor(p.stats),
    blocking: false
  };
  const opponent = {
    name: o.name, image: o.image, stats: normalizeStats(o.stats),
    hp: hpFor(o.stats), maxHp: hpFor(o.stats),
    stamina: staminaFor(o.stats), maxStamina: staminaFor(o.stats),
    blocking: false
  };
  return {
    player: player,
    opponent: opponent,
    turn: 1,
    log: ['Match starts!'],
    status: 'ongoing'
  };
}

function resolveTurn(state, playerAction) {
  if (!state || state.status !== 'ongoing') return state;
  const action = ACTIONS.indexOf(playerAction) === -1 ? 'strike' : playerAction;
  // player acts
  applyAction(state, 'player', action);
  if (state.opponent.hp <= 0) {
    state.status = 'player_win';
    state.log.push(state.player.name + ' wins!');
    return state;
  }
  // opponent acts
  const oppAction = chooseOpponentAction(state.opponent, state);
  applyAction(state, 'opponent', oppAction);
  if (state.player.hp <= 0) {
    state.status = 'opponent_win';
    state.log.push(state.opponent.name + ' wins!');
    return state;
  }
  // regen stamina small
  state.player.stamina = Math.min(state.player.maxStamina, state.player.stamina + 3);
  state.opponent.stamina = Math.min(state.opponent.maxStamina, state.opponent.stamina + 3);
  state.player.blocking = false;
  state.opponent.blocking = false;
  state.turn += 1;
  if (state.turn > 40) {
    // draw by timeout
    state.status = state.player.hp >= state.opponent.hp ? 'player_win' : 'opponent_win';
  }
  return state;
}

function isFinished(state) {
  return !!state && state.status !== 'ongoing';
}


// ---------- aliases for alternate naming ----------
function randomOpponent(roster, exclude) { return pickOpponent(roster, exclude); }
function selectOpponent(roster, exclude) { return pickOpponent(roster, exclude); }
function createMatch(player, opponent) { return newMatch(player, opponent); }
function startMatch(player, opponent) { return newMatch(player, opponent); }
function playTurn(state, action) { return resolveTurn(state, action); }
function takeTurn(state, action) { return resolveTurn(state, action); }
function doTurn(state, action) { return resolveTurn(state, action); }
function trainStat(stats, stat, amount) { return train(stats, stat, amount); }

const api = {
  STATS: STATS,
  ACTIONS: ACTIONS,
  STAT_MIN: STAT_MIN,
  STAT_MAX: STAT_MAX,
  STARTING_STAT: STARTING_STAT,
  MAX_STAT: MAX_STAT,
  TRAIN_AMOUNT: TRAIN_AMOUNT,
  GYM_ENERGY_MAX: GYM_ENERGY_MAX,
  GYM_ENERGY_REGEN_MS: GYM_ENERGY_REGEN_MS,
  defaultStats: defaultStats,
  normalizeStats: normalizeStats,
  cleanName: cleanName,
  createWrestler: createWrestler,
  fromProfile: fromProfile,
  train: train,
  trainAll: trainAll,
  gymTrain: gymTrain,
  trainCost: trainCost,
  gymEnergyState: gymEnergyState,
  pickOpponent: pickOpponent,
  opponentWrestler: opponentWrestler,
  hpFor: hpFor,
  staminaFor: staminaFor,
  chooseOpponentAction: chooseOpponentAction,
  actionDamage: actionDamage,
  newMatch: newMatch,
  resolveTurn: resolveTurn,
  isFinished: isFinished,
  randomOpponent: randomOpponent,
  selectOpponent: selectOpponent,
  createMatch: createMatch,
  startMatch: startMatch,
  playTurn: playTurn,
  takeTurn: takeTurn,
  doTurn: doTurn,
  trainStat: trainStat,
  createCustomWrestler: createWrestler,
  STAT_NAMES: STATS,
  STATS_LIST: STATS
};
  return api;
});
