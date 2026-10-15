(function (factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") { window.WrestlingCareer = api; window.CareerMode = api; }
})(function () {
  "use strict";
'use strict';

/**
 * Wrestling Career Mode — interactive story engine.
 *
 * A branching, choice-driven career for your wrestler: debut, rivalries,
 * training camps, title shots and multiple endings. Pure logic, shared by
 * the browser page and tests.
 */

const WG = (typeof require === 'function') ? (function () {
  try { return require('./wrestlingGame.js'); } catch (e) { return (typeof window !== 'undefined' ? window.WrestlingGame : null); }
})() : (typeof window !== 'undefined' ? window.WrestlingGame : null);

const STATS = ['strength', 'agility', 'stamina', 'skill', 'charisma'];

function defaultCareer(playerName, stats) {
  const base = (WG && WG.normalizeStats) ? WG.normalizeStats(stats || {}) : (stats || {});
  STATS.forEach(function (s) { if (base[s] == null) base[s] = 5; });
  return {
    playerName: String(playerName || 'Wrestler').trim().slice(0, 40) || 'Wrestler',
    stats: base,
    reputation: 0,
    money: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    flags: {},
    currentNode: 'intro',
    history: [],
    finished: false,
    ending: null,
    rival: null,
    title: null,
    chapter: 1
  };
}

// ---------- STORY NODES ----------
// type: 'story' | 'match' | 'training' | 'ending'
const STORY = [
  {
    id: 'intro',
    chapter: 1,
    title: 'The Beginning',
    type: 'story',
    text: 'You stand at the threshold of the Cyber Wrestling Academy. The smell of sweat and canvas fills the air. A trainer looks you over and asks: "So, kid — what kind of fighter are you?"',
    choices: [
      { id: 'backyard', label: 'I learned in a backyard ring — I hit hard.', next: 'train_backyard', effects: { stats: { strength: 2 }, flag: 'backyard' } },
      { id: 'student', label: 'I studied tape of the greats — I know the craft.', next: 'train_student', effects: { stats: { skill: 2 }, flag: 'student' } },
      { id: 'athlete', label: 'I\'m a natural athlete — speed is my game.', next: 'train_athlete', effects: { stats: { agility: 2 }, flag: 'athlete' } }
    ]
  },
  {
    id: 'train_backyard',
    chapter: 1,
    title: 'Backyard Roots',
    type: 'story',
    text: 'The trainer nods. "Raw power. We can work with that. First, you need to learn to take a hit." He pairs you with a sparring partner.',
    choices: [{ id: 'continue', label: 'Step into the ring.', next: 'match_debut' }]
  },
  {
    id: 'train_student',
    chapter: 1,
    title: 'Student of the Game',
    type: 'story',
    text: 'The trainer smiles. "A thinker. Good — the ring rewards brains as much as brawn." He pairs you with a sparring partner.',
    choices: [{ id: 'continue', label: 'Step into the ring.', next: 'match_debut' }]
  },
  {
    id: 'train_athlete',
    chapter: 1,
    title: 'Natural Athlete',
    type: 'story',
    text: 'The trainer grins. "Fast feet win matches. Let\'s see if you can use them." He pairs you with a sparring partner.',
    choices: [{ id: 'continue', label: 'Step into the ring.', next: 'match_debut' }]
  },
  {
    id: 'match_debut',
    chapter: 1,
    title: 'Debut Match — Sparring Partner',
    type: 'match',
    text: 'Your first match. The sparring partner is friendly but doesn\'t hold back. Show what you\'ve got.',
    opponent: { name: 'Sparring Partner', image: '', stats: { strength: 4, agility: 4, stamina: 5, skill: 4, charisma: 3 } },
    onWin: 'debut_win',
    onLoss: 'debut_loss'
  },
  {
    id: 'debut_win',
    chapter: 1,
    title: 'First Victory',
    type: 'story',
    text: 'You win your debut. The trainer claps. "Not bad. You\'ve got potential. Now the real work begins."',
    choices: [
      { id: 'train_str', label: 'Hit the weights — build strength.', next: 'camp_1', effects: { stats: { strength: 2 }, reputation: 2 } },
      { id: 'train_agi', label: 'Drills and sprints — build agility.', next: 'camp_1', effects: { stats: { agility: 2 }, reputation: 2 } }
    ]
  },
  {
    id: 'debut_loss',
    chapter: 1,
    title: 'First Defeat',
    type: 'story',
    text: 'You lose your debut. It stings. The trainer shrugs. "Everyone starts somewhere. Dust off and train harder."',
    choices: [
      { id: 'train_sta', label: 'Conditioning — build stamina.', next: 'camp_1', effects: { stats: { stamina: 2 } } },
      { id: 'train_ski', label: 'Study technique — build skill.', next: 'camp_1', effects: { stats: { skill: 2 } } }
    ]
  },
  {
    id: 'camp_1',
    chapter: 2,
    title: 'Training Camp',
    type: 'training',
    text: 'A month of hard training. Pick a focus for this camp.',
    statOptions: STATS,
    amount: 3,
    next: 'rival_intro'
  },
  {
    id: 'rival_intro',
    chapter: 2,
    title: 'A Rival Appears',
    type: 'story',
    text: 'A cocky newcomer named "Viper" calls you out in the locker room. "You? A contender? Please." The crowd wants to see it.',
    choices: [
      { id: 'accept', label: 'Accept the challenge — make it personal.', next: 'match_rival', effects: { flag: 'rival_accepted', reputation: 3 } },
      { id: 'decline', label: 'Decline — focus on your own path.', next: 'match_contender', effects: { reputation: -1 } }
    ]
  },
  {
    id: 'match_rival',
    chapter: 2,
    title: 'Rivalry Match — Viper',
    type: 'match',
    text: 'Viper is quick and arrogant. The crowd is hot. This one matters.',
    opponent: { name: 'Viper', image: '', stats: { strength: 6, agility: 7, stamina: 6, skill: 6, charisma: 7 } },
    onWin: 'rival_win',
    onLoss: 'rival_loss'
  },
  {
    id: 'rival_win',
    chapter: 2,
    title: 'Viper Silenced',
    type: 'story',
    text: 'You beat Viper clean. The crowd chants your name. Viper stares, then nods — respect earned. A rivalry is born.',
    choices: [
      { id: 'respect', label: 'Offer a handshake.', next: 'mid_career', effects: { flag: 'rival_respect', reputation: 5, money: 50 } },
      { id: 'taunt', label: 'Taunt him — make it bitter.', next: 'mid_career', effects: { flag: 'rival_bitter', reputation: 3, money: 30 } }
    ]
  },
  {
    id: 'rival_loss',
    chapter: 2,
    title: 'Viper Victorious',
    type: 'story',
    text: 'Viper beats you. He laughs. "Come back when you\'re ready." The crowd boos him — but the loss stings.',
    choices: [
      { id: 'train_harder', label: 'Vow revenge — train harder.', next: 'camp_2', effects: { stats: { strength: 1, stamina: 1 }, flag: 'revenge' } },
      { id: 'move_on', label: 'Move on — bigger goals await.', next: 'mid_career', effects: { reputation: -2 } }
    ]
  },
  {
    id: 'camp_2',
    chapter: 2,
    title: 'Revenge Camp',
    type: 'training',
    text: 'A grueling camp focused on closing the gap with Viper.',
    statOptions: STATS,
    amount: 4,
    next: 'mid_career'
  },
  {
    id: 'match_contender',
    chapter: 2,
    title: 'Contender\'s Match',
    type: 'match',
    text: 'Skipping the rivalry, you enter a contender\'s match against a veteran.',
    opponent: { name: 'Veteran', image: '', stats: { strength: 7, agility: 5, stamina: 7, skill: 7, charisma: 5 } },
    onWin: 'contender_win',
    onLoss: 'contender_loss'
  },
  {
    id: 'contender_win',
    chapter: 2,
    title: 'Contender',
    type: 'story',
    text: 'You beat the veteran. The bookers notice. A title shot is within reach.',
    choices: [{ id: 'continue', label: 'Prepare for the title.', next: 'mid_career', effects: { reputation: 5, money: 40 } }]
  },
  {
    id: 'contender_loss',
    chapter: 2,
    title: 'Not Yet',
    type: 'story',
    text: 'The veteran schools you. "Not yet, kid." Back to the grind.',
    choices: [{ id: 'continue', label: 'Train and return.', next: 'camp_2', effects: { stats: { skill: 2 } } }]
  },
  {
    id: 'mid_career',
    chapter: 3,
    title: 'The Mid-Card',
    type: 'story',
    text: 'You\'re a regular on the roster now. The crowd knows your name. A promoter offers you a choice of paths.',
    choices: [
      { id: 'title_path', label: 'Chase the Championship.', next: 'title_build', effects: { reputation: 2 } },
      { id: 'tag_path', label: 'Form a tag team.', next: 'tag_intro', effects: { flag: 'tag_team', reputation: 1 } },
      { id: 'heel_turn', label: 'Turn heel — become the villain.', next: 'heel_intro', effects: { flag: 'heel', stats: { charisma: 2 }, reputation: -2 } }
    ]
  },
  {
    id: 'title_build',
    chapter: 3,
    title: 'Building Momentum',
    type: 'training',
    text: 'A focused camp before your title run.',
    statOptions: STATS,
    amount: 3,
    next: 'match_title_elim'
  },
  {
    id: 'match_title_elim',
    chapter: 3,
    title: 'Title Eliminator',
    type: 'match',
    text: 'Win this and you earn a title shot.',
    opponent: { name: 'The Gatekeeper', image: '', stats: { strength: 8, agility: 6, stamina: 8, skill: 8, charisma: 6 } },
    onWin: 'title_shot',
    onLoss: 'title_denied'
  },
  {
    id: 'title_shot',
    chapter: 3,
    title: 'Championship Match',
    type: 'match',
    text: 'The champion awaits. Everything you\'ve worked for.',
    opponent: { name: 'The Champion', image: '', stats: { strength: 9, agility: 7, stamina: 9, skill: 9, charisma: 8 } },
    onWin: 'champion',
    onLoss: 'title_loss'
  },
  {
    id: 'title_loss',
    chapter: 3,
    title: 'So Close',
    type: 'story',
    text: 'You fall short. The champion respects you, though. "Rematch anytime."',
    choices: [
      { id: 'rematch', label: 'Demand a rematch.', next: 'title_shot', effects: { reputation: 2 } },
      { id: 'rebuild', label: 'Rebuild and return stronger.', next: 'camp_3', effects: { stats: { stamina: 2, skill: 2 } } }
    ]
  },
  {
    id: 'camp_3',
    chapter: 3,
    title: 'Rebuild Camp',
    type: 'training',
    text: 'A long camp to rebuild.',
    statOptions: STATS,
    amount: 5,
    next: 'title_shot'
  },
  {
    id: 'title_denied',
    chapter: 3,
    title: 'Denied',
    type: 'story',
    text: 'The Gatekeeper stops you. The title shot slips away.',
    choices: [{ id: 'continue', label: 'Climb back up.', next: 'mid_career', effects: { reputation: -1 } }]
  },
  {
    id: 'champion',
    chapter: 4,
    title: 'Champion!',
    type: 'story',
    text: 'You are the Champion! The belt is yours. The crowd erupts.',
    choices: [
      { id: 'defend', label: 'Defend the title — become a legend.', next: 'title_defense', effects: { title: 'Champion', reputation: 10, money: 100 } },
      { id: 'retire', label: 'Retire on top.', next: 'ending_retire', effects: { title: 'Champion', reputation: 8 } }
    ]
  },
  {
    id: 'title_defense',
    chapter: 4,
    title: 'Title Defense',
    type: 'match',
    text: 'A new challenger emerges — and it\'s Viper, if you let the rivalry fester. Defend your belt.',
    opponent: { name: 'Challenger', image: '', stats: { strength: 9, agility: 8, stamina: 9, skill: 9, charisma: 8 } },
    onWin: 'ending_champion',
    onLoss: 'ending_lost_title'
  },
  {
    id: 'tag_intro',
    chapter: 3,
    title: 'Tag Team',
    type: 'story',
    text: 'You find a partner and chase tag gold.',
    choices: [{ id: 'continue', label: 'Enter the tag division.', next: 'match_tag', effects: { flag: 'tag_team' } }]
  },
  {
    id: 'match_tag',
    chapter: 3,
    title: 'Tag Title Match',
    type: 'match',
    text: 'A tag title match. Your partner has your back.',
    opponent: { name: 'Tag Champions', image: '', stats: { strength: 8, agility: 7, stamina: 8, skill: 7, charisma: 6 } },
    onWin: 'ending_tag_champs',
    onLoss: 'ending_tag_loss'
  },
  {
    id: 'heel_intro',
    chapter: 3,
    title: 'Heel Turn',
    type: 'story',
    text: 'You embrace the boos. The crowd hates you — and pays to see you lose. But winning as a villain hits different.',
    choices: [{ id: 'continue', label: 'Lean into the heat.', next: 'match_heel', effects: { stats: { charisma: 2 }, reputation: -3 } }]
  },
  {
    id: 'match_heel',
    chapter: 3,
    title: 'Heel Showcase',
    type: 'match',
    text: 'A showcase match to establish your new persona.',
    opponent: { name: 'Fan Favorite', image: '', stats: { strength: 7, agility: 7, stamina: 7, skill: 7, charisma: 8 } },
    onWin: 'ending_heel',
    onLoss: 'ending_heel_loss'
  },
  // endings
  {
    id: 'ending_retire',
    chapter: 4,
    title: 'Retired on Top',
    type: 'ending',
    text: 'You walk away as champion. A short career, but a perfect one. The crowd will remember you.',
    ending: 'legend'
  },
  {
    id: 'ending_champion',
    chapter: 4,
    title: 'Dynasty',
    type: 'ending',
    text: 'You defend the title and cement your legacy as a dominant champion. A dynasty begins.',
    ending: 'dynasty'
  },
  {
    id: 'ending_lost_title',
    chapter: 4,
    title: 'Fallen Champion',
    type: 'ending',
    text: 'You lose the title. The crowd turns. But the fire to reclaim it burns bright.',
    ending: 'fallen'
  },
  {
    id: 'ending_tag_champs',
    chapter: 4,
    title: 'Tag Team Champions',
    type: 'ending',
    text: 'You and your partner win tag gold. Together, you\'re unstoppable.',
    ending: 'tag_champs'
  },
  {
    id: 'ending_tag_loss',
    chapter: 4,
    title: 'Tag Team Setback',
    type: 'ending',
    text: 'The tag title eludes you. But the partnership endures.',
    ending: 'tag_setback'
  },
  {
    id: 'ending_heel',
    chapter: 4,
    title: 'The Villain',
    type: 'ending',
    text: 'You win as the heel. Boos rain down — and you love every second. A new era of villainy begins.',
    ending: 'villain'
  },
  {
    id: 'ending_heel_loss',
    chapter: 4,
    title: 'Heel Humbled',
    type: 'ending',
    text: 'The fan favorite beats you. The crowd cheers. You\'re left to rethink your path.',
    ending: 'humbled'
  }
];

const NODES = {};
STORY.forEach(function (n) { NODES[n.id] = n; });

function getNode(id) { return NODES[id] || null; }

function applyEffects(state, effects) {
  if (!effects) return state;
  const s = state;
  if (effects.stats) {
    STATS.forEach(function (st) {
      if (effects.stats[st] != null) {
        s.stats[st] = Math.max(0, Math.min(100, (s.stats[st] || 0) + effects.stats[st]));
      }
    });
  }
  if (effects.reputation != null) s.reputation += effects.reputation;
  if (effects.money != null) s.money += effects.money;
  if (effects.flag) s.flags[effects.flag] = true;
  if (effects.title) s.title = effects.title;
  return s;
}

function makeChoice(state, choiceId) {
  const node = getNode(state.currentNode);
  if (!node || node.type !== 'story') return { ok: false, error: 'not_story_node' };
  const choice = (node.choices || []).find(function (c) { return c.id === choiceId; });
  if (!choice) return { ok: false, error: 'invalid_choice' };
  applyEffects(state, choice.effects);
  state.history.push({ node: state.currentNode, choice: choiceId });
  state.currentNode = choice.next;
  const next = getNode(state.currentNode);
  if (next && next.type === 'ending') {
    state.finished = true;
    state.ending = next.ending;
  }
  return { ok: true, state: state, next: next };
}

function resolveMatch(state, won) {
  const node = getNode(state.currentNode);
  if (!node || node.type !== 'match') return { ok: false, error: 'not_match_node' };
  if (won) { state.wins += 1; state.reputation += 3; }
  else { state.losses += 1; state.reputation -= 1; }
  state.history.push({ node: state.currentNode, result: won ? 'win' : 'loss' });
  const nextId = won ? node.onWin : node.onLoss;
  state.currentNode = nextId;
  const next = getNode(nextId);
  if (next && next.type === 'ending') {
    state.finished = true;
    state.ending = next.ending;
  }
  return { ok: true, state: state, next: next };
}

function trainStat(state, stat, amount) {
  const node = getNode(state.currentNode);
  if (!node || node.type !== 'training') return { ok: false, error: 'not_training_node' };
  const s = String(stat || '').trim().toLowerCase();
  if (STATS.indexOf(s) === -1) return { ok: false, error: 'invalid_stat' };
  const opts = node.statOptions || STATS;
  if (opts.indexOf(s) === -1) return { ok: false, error: 'stat_not_allowed' };
  const amt = amount || node.amount || 1;
  state.stats[s] = Math.max(0, Math.min(100, (state.stats[s] || 0) + amt));
  // training node auto-advances after one pick
  state.history.push({ node: state.currentNode, trained: s, amount: amt });
  state.currentNode = node.next;
  const next = getNode(state.currentNode);
  if (next && next.type === 'ending') {
    state.finished = true;
    state.ending = next.ending;
  }
  return { ok: true, state: state, next: next, stat: s, amount: amt };
}

function currentNode(state) { return getNode(state.currentNode); }

function isFinished(state) { return !!(state && state.finished); }

function summary(state) {
  return {
    playerName: state.playerName,
    record: state.wins + '-' + state.losses,
    reputation: state.reputation,
    money: state.money,
    title: state.title,
    ending: state.ending,
    finished: state.finished
  };
}

function serialize(state) { return JSON.stringify(state); }
function deserialize(json) {
  try {
    const s = JSON.parse(json);
    if (!s || typeof s !== 'object') return null;
    // ensure stats
    STATS.forEach(function (st) { if (s.stats[st] == null) s.stats[st] = 5; });
    return s;
  } catch (e) { return null; }
}

const api = {
  STATS: STATS,
  STORY: STORY,
  NODES: NODES,
  defaultCareer: defaultCareer,
  getNode: getNode,
  applyEffects: applyEffects,
  makeChoice: makeChoice,
  resolveMatch: resolveMatch,
  trainStat: trainStat,
  currentNode: currentNode,
  isFinished: isFinished,
  summary: summary,
  serialize: serialize,
  deserialize: deserialize
};
  return api;
});
