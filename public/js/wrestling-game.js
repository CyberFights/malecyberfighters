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

/**
 * Wrestling game — shared rules and expanded combat engine.
 *
 * Core capabilities:
 *   - Five trainable stats: strength, agility, stamina, skill, charisma
 *   - Gym energy training with regeneration
 *   - Rich move arsenal: Holds, Power Moves, Submissions, Tactics
 *   - Authentic submission tap-out mechanics & critical slams
 *   - Action imagery and commentary for every move
 *   - Tactical opponent AI
 */

const STATS = ['strength', 'agility', 'stamina', 'skill', 'charisma'];
const STAT_MIN = 0;
const STAT_MAX = 100;
const STARTING_STAT = 5;
const MAX_STAT = 100;
const TRAIN_AMOUNT = 1;

// ---- Gym energy system ----
const GYM_ENERGY_MAX = 10;
const GYM_ENERGY_REGEN_MS = 5 * 60 * 1000; // 1 energy every 5 minutes
const GYM_ENERGY_START = GYM_ENERGY_MAX;

function trainCost(statValue) {
  const v = Math.max(0, Math.min(STAT_MAX, Number(statValue) || 0));
  if (v >= 75) return 4;
  return 1 + Math.floor(v / 25);
}

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

// ---- Move Arsenal Definitions ----
const MOVE_CATEGORIES = {
  hold: 'Hold',
  power: 'Power Move',
  submission: 'Submission',
  basic: 'Tactics & Defense'
};

const HOLDS = ['sleeper-hold', 'bearhug', 'headlock', 'full-nelson', 'hammerlock'];
const POWER_MOVES = ['suplex', 'powerbomb', 'chokeslam', 'spinebuster', 'piledriver'];
const SUBMISSIONS = ['boston-crab', 'figure-four', 'armbar', 'sharpshooter', 'triangle-choke'];
const TACTICS = ['strike', 'block', 'taunt', 'rest'];

const MOVES = {
  // === HOLDS ===
  'sleeper-hold': {
    id: 'sleeper-hold',
    name: 'Sleeper Hold',
    category: 'hold',
    staminaCost: 9,
    image: '/images/moves/sleeper-hold.png',
    desc: 'Applies carotid pressure from behind to drain opponent stamina and oxygen.',
    primaryStat: 'skill',
    secondaryStat: 'stamina',
    staminaDrain: 14,
    effect: 'Drains heavy opponent stamina'
  },
  'bearhug': {
    id: 'bearhug',
    name: 'Bearhug',
    category: 'hold',
    staminaCost: 12,
    image: '/images/moves/bearhug.png',
    desc: 'Squeezes opponent midsection in a crushing embrace to fracture ribs and knock out breath.',
    primaryStat: 'strength',
    secondaryStat: 'stamina',
    staminaDrain: 8,
    effect: 'Heavy torso crush & stamina drain'
  },
  'headlock': {
    id: 'headlock',
    name: 'Side Headlock',
    category: 'hold',
    staminaCost: 6,
    image: '/images/moves/headlock.png',
    desc: 'Fundamental grappling headlock maintaining tight head and neck control.',
    primaryStat: 'skill',
    secondaryStat: 'strength',
    staminaDrain: 6,
    effect: 'Low cost steady control'
  },
  'full-nelson': {
    id: 'full-nelson',
    name: 'Full Nelson',
    category: 'hold',
    staminaCost: 11,
    image: '/images/moves/full-nelson.png',
    desc: 'Hooks both arms under opponent armpits and locks behind neck, neutralizing defense.',
    primaryStat: 'strength',
    secondaryStat: 'skill',
    staminaDrain: 10,
    bypassesBlock: true,
    effect: 'Bypasses opponent block'
  },
  'hammerlock': {
    id: 'hammerlock',
    name: 'Hammerlock',
    category: 'hold',
    staminaCost: 8,
    image: '/images/moves/hammerlock.png',
    desc: 'Wrenches opponent arm sharply up their spine, attacking shoulder mobility.',
    primaryStat: 'skill',
    secondaryStat: 'agility',
    staminaDrain: 8,
    effect: 'Shoulder wrench & stamina drain'
  },

  // === POWER MOVES ===
  'suplex': {
    id: 'suplex',
    name: 'German Suplex',
    category: 'power',
    staminaCost: 15,
    image: '/images/moves/suplex.png',
    desc: 'Waist-lock release bridging throw dumping opponent violently onto their neck and shoulders.',
    primaryStat: 'strength',
    secondaryStat: 'agility',
    critChance: 0.25,
    effect: 'High impact throw with 25% crit chance'
  },
  'powerbomb': {
    id: 'powerbomb',
    name: 'Powerbomb',
    category: 'power',
    staminaCost: 18,
    image: '/images/moves/powerbomb.png',
    desc: 'Hoists opponent onto shoulders before driving them down with earth-shattering impact.',
    primaryStat: 'strength',
    secondaryStat: 'strength',
    critChance: 0.20,
    effect: 'Massive raw impact damage'
  },
  'chokeslam': {
    id: 'chokeslam',
    name: 'Chokeslam',
    category: 'power',
    staminaCost: 16,
    image: '/images/moves/chokeslam.png',
    desc: 'Gripping the throat, lifts opponent with one hand and hurls them flat onto the canvas.',
    primaryStat: 'strength',
    secondaryStat: 'stamina',
    staminaDrain: 8,
    critChance: 0.15,
    effect: 'High vertical slam & stamina shock'
  },
  'spinebuster': {
    id: 'spinebuster',
    name: 'Spinebuster',
    category: 'power',
    staminaCost: 13,
    image: '/images/moves/spinebuster.png',
    desc: 'Catches opponent in mid-stride and turns around to plant them hard on their spine.',
    primaryStat: 'strength',
    secondaryStat: 'agility',
    critChance: 0.15,
    effect: 'Explosive drive planting opponent flat'
  },
  'piledriver': {
    id: 'piledriver',
    name: 'Piledriver',
    category: 'power',
    staminaCost: 20,
    image: '/images/moves/piledriver.png',
    desc: 'Tucks opponent head between thighs and drops straight down for maximum cranial impact.',
    primaryStat: 'strength',
    secondaryStat: 'skill',
    critChance: 0.30,
    effect: 'Highest damage power move, 30% crit'
  },

  // === SUBMISSIONS ===
  'boston-crab': {
    id: 'boston-crab',
    name: 'Boston Crab',
    category: 'submission',
    staminaCost: 14,
    image: '/images/moves/boston-crab.png',
    desc: 'Steps over a prone opponent, turns them onto stomach, and leans deep into their lower back.',
    primaryStat: 'skill',
    secondaryStat: 'strength',
    subThreshold: 0.35,
    effect: 'Deadly lower back arch, forces tap out'
  },
  'figure-four': {
    id: 'figure-four',
    name: 'Figure-Four Leglock',
    category: 'submission',
    staminaCost: 13,
    image: '/images/moves/figure-four.png',
    desc: 'Crosses and twists the opponent legs in a geometric knot that shreds knee ligaments.',
    primaryStat: 'skill',
    secondaryStat: 'agility',
    subThreshold: 0.35,
    effect: 'Knee ligament torque, forces tap out'
  },
  'armbar': {
    id: 'armbar',
    name: 'Cross Armbar',
    category: 'submission',
    staminaCost: 12,
    image: '/images/moves/armbar.png',
    desc: 'Pivots hips around opponent arm and hyperextends the elbow joint across the pelvic fulcrum.',
    primaryStat: 'skill',
    secondaryStat: 'agility',
    subThreshold: 0.35,
    effect: 'Elbow hyperextension, high tap out chance'
  },
  'sharpshooter': {
    id: 'sharpshooter',
    name: 'Sharpshooter',
    category: 'submission',
    staminaCost: 15,
    image: '/images/moves/sharpshooter.png',
    desc: 'Crosses opponent legs, steps through, and rolls them over into an inescapable spine arch.',
    primaryStat: 'skill',
    secondaryStat: 'strength',
    subThreshold: 0.38,
    effect: 'Legendary submission hold, high tap out risk'
  },
  'triangle-choke': {
    id: 'triangle-choke',
    name: 'Triangle Choke',
    category: 'submission',
    staminaCost: 11,
    image: '/images/moves/triangle-choke.png',
    desc: 'Wraps legs in a figure-four around neck and one arm, cutting blood supply to the brain.',
    primaryStat: 'skill',
    secondaryStat: 'agility',
    staminaDrain: 12,
    subThreshold: 0.32,
    effect: 'Suffocating choke with quick tap out danger'
  },

  // === TACTICS / FUNDAMENTALS ===
  'strike': {
    id: 'strike',
    name: 'Strike',
    category: 'basic',
    staminaCost: 8,
    image: '/images/moves/strike.png',
    desc: 'Crisp punch, forearm smash, or roundhouse kick.',
    primaryStat: 'strength',
    secondaryStat: 'skill',
    effect: 'Quick, reliable blunt hit'
  },
  'grapple': { // legacy alias
    id: 'grapple',
    name: 'Grapple',
    category: 'basic',
    staminaCost: 10,
    image: '/images/moves/headlock.png',
    desc: 'Classic collar-and-elbow tie-up and grapple takedown.',
    primaryStat: 'skill',
    secondaryStat: 'strength',
    effect: 'Fundamental grapple takedown'
  },
  'block': {
    id: 'block',
    name: 'Block',
    category: 'basic',
    staminaCost: 0,
    image: '/images/moves/block.png',
    desc: 'Braces behind an iron guard to absorb 60% of incoming damage.',
    effect: 'Mitigates 60% incoming damage'
  },
  'taunt': {
    id: 'taunt',
    name: 'Taunt',
    category: 'basic',
    staminaCost: 5,
    image: '/images/moves/taunt.png',
    desc: 'Pumps up the crowd with charisma, building momentum and draining opponent stamina.',
    primaryStat: 'charisma',
    staminaDrain: 10,
    effect: 'Drains opponent stamina & builds momentum'
  },
  'rest': {
    id: 'rest',
    name: 'Rest',
    category: 'basic',
    staminaCost: 0,
    image: '/images/moves/rest.png',
    desc: 'Catches breath in the corner and regains stamina.',
    effect: 'Recovers 14+ stamina'
  }
};

const ACTIONS = Object.keys(MOVES);

function defaultStats() {
  const out = {};
  STATS.forEach(function (s) { out[s] = STARTING_STAT; });
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

function gymTrain(stats, stat, amount, now) {
  const target = String(stat || '').trim().toLowerCase();
  if (STATS.indexOf(target) === -1) return { ok: false, error: 'invalid_stat' };
  const nowTs = (typeof now === 'number') ? now : Date.now();
  const regen = gymEnergyState(stats, nowTs);
  const s = normalizeStats(stats);
  s.gymEnergy = regen.current;
  s.gymEnergyAt = regen.lastAt;
  const beforeVal = s[target];
  if (beforeVal >= STAT_MAX) return { ok: false, error: 'stat_max' };
  const cost = trainCost(beforeVal);
  if (s.gymEnergy < cost) {
    const need = cost - s.gymEnergy;
    const retryAfterMs = (need > 0 ? need : 1) * GYM_ENERGY_REGEN_MS - (nowTs - regen.lastAt);
    return { ok: false, error: 'no_energy', cost: cost, gymEnergy: s.gymEnergy, gymEnergyMax: s.gymEnergyMax, retryAfterMs: Math.max(0, retryAfterMs) };
  }
  const amt = isFinite(Number(amount)) ? Math.round(Number(amount)) : TRAIN_AMOUNT;
  if (amt <= 0) return { ok: false, error: 'invalid_amount' };
  s[target] = Math.min(STAT_MAX, beforeVal + amt);
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

// ---- Combat Calculations ----
function moveDamage(moveId, attacker, defender) {
  const move = MOVES[moveId] || MOVES.strike;
  const a = normalizeStats(attacker.stats);
  const d = normalizeStats(defender.stats);

  if (move.category === 'basic') {
    if (moveId === 'strike') {
      const base = a.strength * 1.2 + a.skill * 0.4;
      const mit = 1 + d.agility * 0.02 + d.stamina * 0.01;
      return Math.max(2, Math.round(base / mit));
    }
    if (moveId === 'grapple') {
      const base = a.skill * 1.3 + a.strength * 0.3;
      const mit = 1 + d.agility * 0.02 + d.stamina * 0.01;
      return Math.max(2, Math.round(base / mit));
    }
    if (moveId === 'taunt') {
      const base = a.charisma * 0.6;
      const mit = 1 + d.agility * 0.02 + d.stamina * 0.01;
      return Math.max(0, Math.round(base / mit));
    }
    return 0;
  }

  if (move.category === 'hold') {
    const pVal = a[move.primaryStat] || 5;
    const sVal = a[move.secondaryStat] || 5;
    const base = pVal * 1.0 + sVal * 0.4 + 4;
    const mit = 1 + d.stamina * 0.015 + d.strength * 0.008;
    return Math.max(3, Math.round(base / mit));
  }

  if (move.category === 'power') {
    const pVal = a[move.primaryStat] || 5;
    const sVal = a[move.secondaryStat] || 5;
    let base = pVal * 1.45 + sVal * 0.55 + 8;
    const isCrit = Math.random() < (move.critChance || 0.15);
    if (isCrit) base *= 1.45;
    const mit = 1 + d.stamina * 0.014 + d.agility * 0.01;
    const dmg = Math.max(5, Math.round(base / mit));
    return { dmg: dmg, isCrit: isCrit };
  }

  if (move.category === 'submission') {
    const pVal = a[move.primaryStat] || 5;
    const sVal = a[move.secondaryStat] || 5;
    const base = pVal * 1.1 + sVal * 0.45 + 5;
    const mit = 1 + d.stamina * 0.015 + d.skill * 0.01;
    return Math.max(4, Math.round(base / mit));
  }

  return 5;
}

function actionDamage(action, attacker, defender) {
  const res = moveDamage(action, attacker, defender);
  return typeof res === 'object' ? res.dmg : res;
}

function checkSubmissionTapOut(move, attacker, defender) {
  if (move.category !== 'submission') return false;
  const a = normalizeStats(attacker.stats);
  const d = normalizeStats(defender.stats);
  const hpRatio = defender.maxHp ? (defender.hp / defender.maxHp) : 1;
  const staminaRatio = defender.maxStamina ? (defender.stamina / defender.maxStamina) : 1;

  const threshold = move.subThreshold || 0.35;
  if (hpRatio <= threshold || (hpRatio <= 0.45 && staminaRatio <= 0.2)) {
    const attackPower = (a.skill * 0.7 + a.strength * 0.3) / 100;
    const defendResist = (d.stamina * 0.5 + d.skill * 0.5) / 100;
    const weakness = (1 - hpRatio) * 0.6 + (1 - staminaRatio) * 0.4;
    const tapChance = Math.min(0.85, Math.max(0.25, 0.35 + attackPower * 0.25 - defendResist * 0.2 + weakness * 0.35));
    return Math.random() < tapChance;
  }
  return false;
}

function chooseOpponentAction(opp, state) {
  const s = normalizeStats(opp.stats);
  const hp = state.opponent.hp;
  const maxHp = state.opponent.maxHp;
  const hpRatio = maxHp ? hp / maxHp : 1;
  const stamina = state.opponent.stamina;
  const maxStam = state.opponent.maxStamina || 60;
  const stamRatio = maxStam ? stamina / maxStam : 1;

  const playerHp = state.player.hp;
  const playerMaxHp = state.player.maxHp || 100;
  const playerHpRatio = playerMaxHp ? playerHp / playerMaxHp : 1;

  // 1. Critical stamina recovery or defensive block
  if (stamRatio < 0.15 || (hpRatio < 0.22 && Math.random() < 0.5)) {
    return 'rest';
  }
  if (hpRatio < 0.35 && Math.random() < 0.35) {
    return 'block';
  }

  // 2. Submission finisher if player is hurt and AI has stamina
  if (playerHpRatio <= 0.40 && stamina >= 12) {
    if (s.skill >= 35 || Math.random() < 0.6) {
      return SUBMISSIONS[Math.floor(Math.random() * SUBMISSIONS.length)];
    }
  }

  // 3. Power moves if strong and enough stamina
  if (stamina >= 16 && (s.strength >= 30 || Math.random() < 0.4)) {
    return POWER_MOVES[Math.floor(Math.random() * POWER_MOVES.length)];
  }

  // 4. Holds if skilled
  if (stamina >= 8 && (s.skill >= 20 || Math.random() < 0.45)) {
    return HOLDS[Math.floor(Math.random() * HOLDS.length)];
  }

  // 5. Taunt if high charisma
  if (s.charisma >= 50 && stamina >= 5 && Math.random() < 0.25) {
    return 'taunt';
  }

  return Math.random() < 0.6 ? 'strike' : 'headlock';
}

function applyAction(state, who, action) {
  const attacker = who === 'player' ? state.player : state.opponent;
  const defender = who === 'player' ? state.opponent : state.player;

  let move = MOVES[action];
  if (!move) {
    move = MOVES.strike;
    action = 'strike';
  }

  let logLine = '';
  const moveResult = {
    who: who,
    attackerName: attacker.name,
    defenderName: defender.name,
    action: action,
    move: move,
    name: move.name,
    category: move.category,
    image: move.image,
    damage: 0,
    isCrit: false,
    isTapOut: false,
    blocked: false,
    exhausted: false,
    staminaCost: move.staminaCost || 0
  };

  if (action === 'rest') {
    const gain = 14 + Math.round(attacker.stats.stamina * 0.15);
    attacker.stamina = Math.min(attacker.maxStamina, attacker.stamina + gain);
    logLine = attacker.name + ' takes a breather in the corner, catching wind for +' + gain + ' stamina.';
  } else if (action === 'block') {
    attacker.blocking = true;
    logLine = attacker.name + ' braces behind an iron guard, ready to absorb incoming attacks.';
  } else if (action === 'taunt') {
    const drain = 8 + Math.round(attacker.stats.charisma * 0.25);
    defender.stamina = Math.max(0, defender.stamina - drain);
    attacker.stamina = Math.min(attacker.maxStamina, attacker.stamina + 5);
    const dmg = actionDamage('taunt', attacker, defender);
    defender.hp = Math.max(0, defender.hp - dmg);
    moveResult.damage = dmg;
    logLine = attacker.name + ' taunts the crowd! The arena roars, rattling ' + defender.name + ' (-' + drain + ' stamina).';
  } else {
    const cost = move.staminaCost || 8;
    let isExhausted = false;
    if (attacker.stamina < cost) {
      isExhausted = true;
      attacker.stamina = 0;
      moveResult.exhausted = true;
    } else {
      attacker.stamina = Math.max(0, attacker.stamina - cost);
    }

    const dmgCalc = moveDamage(action, attacker, defender);
    let dmg = typeof dmgCalc === 'object' ? dmgCalc.dmg : dmgCalc;
    const isCrit = typeof dmgCalc === 'object' ? dmgCalc.isCrit : false;
    if (isExhausted) {
      dmg = Math.max(1, Math.round(dmg * 0.55));
    }
    moveResult.isCrit = isCrit;

    // Defender block
    if (defender.blocking && !move.bypassesBlock) {
      dmg = Math.max(1, Math.round(dmg * 0.4));
      defender.blocking = false;
      moveResult.blocked = true;
    } else if (move.bypassesBlock && defender.blocking) {
      defender.blocking = false;
    }

    // Stamina drain from holds/submissions
    if (move.staminaDrain) {
      const extraDrain = Math.round(move.staminaDrain * (1 + (attacker.stats.skill || 5) * 0.005));
      defender.stamina = Math.max(0, defender.stamina - extraDrain);
    }

    // Submission tap out check
    let tapped = false;
    if (move.category === 'submission') {
      tapped = checkSubmissionTapOut(move, attacker, defender);
    }

    if (tapped) {
      defender.hp = 0;
      moveResult.isTapOut = true;
      moveResult.damage = dmg;
      logLine = '🚨 TAP OUT! ' + attacker.name + ' locks in the ' + move.name + ' with excruciating torque! ' + defender.name + ' frantically taps the mat to submit!';
    } else {
      defender.hp = Math.max(0, defender.hp - dmg);
      moveResult.damage = dmg;

      if (move.category === 'power') {
        const critText = isCrit ? '💥 CRITICAL SLAM! ' : '';
        logLine = critText + attacker.name + ' executes a thunderous ' + move.name + ' on ' + defender.name + ' for ' + dmg + ' damage!' + (moveResult.blocked ? ' (Partially blocked!)' : '');
      } else if (move.category === 'submission') {
        logLine = '🔒 ' + attacker.name + ' cranks on the ' + move.name + ', wrenching ' + defender.name + ' for ' + dmg + ' damage!';
      } else if (move.category === 'hold') {
        logLine = '🥋 ' + attacker.name + ' traps ' + defender.name + ' in a grinding ' + move.name + ' for ' + dmg + ' damage (-' + (move.staminaDrain || 6) + ' stamina)!';
      } else {
        logLine = attacker.name + ' connects with ' + move.name + ' for ' + dmg + ' damage!' + (moveResult.blocked ? ' (Blocked!)' : '');
      }
    }
  }

  state.log = state.log || [];
  state.log.push(logLine);
  state.lastMove = moveResult;
  attacker.lastMove = moveResult;
  return state;
}

function newMatch(playerWrestler, opponentWrestlerObj) {
  const p = playerWrestler;
  const o = opponentWrestlerObj;
  const player = {
    name: p.name, image: p.image, stats: normalizeStats(p.stats),
    hp: hpFor(p.stats), maxHp: hpFor(p.stats),
    stamina: staminaFor(p.stats), maxStamina: staminaFor(p.stats),
    blocking: false,
    lastMove: null
  };
  const opponent = {
    name: o.name, image: o.image, stats: normalizeStats(o.stats),
    hp: hpFor(o.stats), maxHp: hpFor(o.stats),
    stamina: staminaFor(o.stats), maxStamina: staminaFor(o.stats),
    blocking: false,
    lastMove: null
  };
  return {
    player: player,
    opponent: opponent,
    turn: 1,
    log: ['Match starts! Step between the ropes and make your move.'],
    status: 'ongoing',
    lastMove: null,
    winType: null
  };
}

function resolveTurn(state, playerAction) {
  if (!state || state.status !== 'ongoing') return state;
  const action = (playerAction && MOVES[playerAction]) ? playerAction : (ACTIONS.indexOf(playerAction) === -1 ? 'strike' : playerAction);

  // Player turn
  applyAction(state, 'player', action);
  if (state.opponent.hp <= 0) {
    state.status = 'player_win';
    if (state.lastMove && state.lastMove.isTapOut) {
      state.winType = 'submission';
      state.log.push('🏆 ' + state.player.name + ' wins by SUBMISSION!');
    } else {
      state.winType = 'pinfall';
      state.log.push('🏆 ' + state.player.name + ' scores the 3-count pinfall victory!');
    }
    return state;
  }

  // Opponent turn
  const oppAction = chooseOpponentAction(state.opponent, state);
  applyAction(state, 'opponent', oppAction);
  if (state.player.hp <= 0) {
    state.status = 'opponent_win';
    if (state.lastMove && state.lastMove.isTapOut) {
      state.winType = 'submission';
      state.log.push('❌ ' + state.opponent.name + ' wins by SUBMISSION! ' + state.player.name + ' tapped out.');
    } else {
      state.winType = 'pinfall';
      state.log.push('❌ ' + state.opponent.name + ' scores the pinfall victory!');
    }
    return state;
  }

  // Regain a little stamina
  state.player.stamina = Math.min(state.player.maxStamina, state.player.stamina + 3);
  state.opponent.stamina = Math.min(state.opponent.maxStamina, state.opponent.stamina + 3);
  state.player.blocking = false;
  state.opponent.blocking = false;
  state.turn += 1;
  if (state.turn > 40) {
    state.status = state.player.hp >= state.opponent.hp ? 'player_win' : 'opponent_win';
    state.winType = 'decision';
    state.log.push('⏱️ Time limit expired! Winner by decision: ' + (state.status === 'player_win' ? state.player.name : state.opponent.name));
  }
  return state;
}

function isFinished(state) {
  return !!state && state.status !== 'ongoing';
}

// Aliases
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
  MOVE_CATEGORIES: MOVE_CATEGORIES,
  MOVES: MOVES,
  HOLDS: HOLDS,
  POWER_MOVES: POWER_MOVES,
  SUBMISSIONS: SUBMISSIONS,
  TACTICS: TACTICS,
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
  moveDamage: moveDamage,
  actionDamage: actionDamage,
  checkSubmissionTapOut: checkSubmissionTapOut,
  chooseOpponentAction: chooseOpponentAction,
  applyAction: applyAction,
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
