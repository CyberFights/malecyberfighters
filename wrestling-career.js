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

// Character portraits used by the story engine and career UI.
const CHAR_IMG = {
  trainer:        '/images/career/trainer.png',
  sparring:       '/images/career/sparring-partner.png',
  viper:          '/images/career/viper.png',
  veteran:        '/images/career/veteran.png',
  gatekeeper:     '/images/career/gatekeeper.png',
  champion:       '/images/career/champion.png',
  fan_favorite:   '/images/career/fan-favorite.png',
  tag_champs:     '/images/career/tag-champs.png',
  promoter:      '/images/career/promoter.png',
  legend:        '/images/career/legend.png',
  enforcer:      '/images/career/enforcer.png',
  el_rayo:       '/images/career/el-rayo.png',
  vyxen:         '/images/career/vyxen.png',
  doctor:        '/images/career/doctor.png',
  announcer:     '/images/career/announcer.png',
  promoter:      '/images/career/promoter.png',
  legend:        '/images/career/legend.png',
  enforcer:      '/images/career/enforcer.png',
  el_rayo:       '/images/career/el-rayo.png',
  vyxen:         '/images/career/vyxen.png',
  doctor:        '/images/career/doctor.png',
  announcer:     '/images/career/announcer.png',
  challenger:     '/images/career/challenger.png'
};

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
    portrait: CHAR_IMG.trainer,
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
    portrait: CHAR_IMG.trainer,
    title: 'Backyard Roots',
    type: 'story',
    text: 'The trainer nods. "Raw power. We can work with that. First, you need to learn to take a hit." He pairs you with a sparring partner.',
    choices: [{ id: 'continue', label: 'Step into the ring.', next: 'match_debut' }]
  },
  {
    id: 'train_student',
    chapter: 1,
    portrait: CHAR_IMG.trainer,
    title: 'Student of the Game',
    type: 'story',
    text: 'The trainer smiles. "A thinker. Good — the ring rewards brains as much as brawn." He pairs you with a sparring partner.',
    choices: [{ id: 'continue', label: 'Step into the ring.', next: 'match_debut' }]
  },
  {
    id: 'train_athlete',
    chapter: 1,
    portrait: CHAR_IMG.trainer,
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
    opponent: { name: 'Sparring Partner', image: CHAR_IMG.sparring, stats: { strength: 4, agility: 4, stamina: 5, skill: 4, charisma: 3 } },
    onWin: 'debut_win',
    onLoss: 'debut_loss'
  },
  {
    id: 'debut_win',
    chapter: 1,
    portrait: CHAR_IMG.trainer,
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
    portrait: CHAR_IMG.trainer,
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
    portrait: CHAR_IMG.trainer,
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
    portrait: CHAR_IMG.viper,
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
    opponent: { name: 'Viper', image: CHAR_IMG.viper, stats: { strength: 6, agility: 7, stamina: 6, skill: 6, charisma: 7 } },
    onWin: 'rival_win',
    onLoss: 'rival_loss'
  },
  {
    id: 'rival_win',
    chapter: 2,
    portrait: CHAR_IMG.viper,
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
    portrait: CHAR_IMG.viper,
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
    portrait: CHAR_IMG.trainer,
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
    opponent: { name: 'Veteran', image: CHAR_IMG.veteran, stats: { strength: 7, agility: 5, stamina: 7, skill: 7, charisma: 5 } },
    onWin: 'contender_win',
    onLoss: 'contender_loss'
  },
  {
    id: 'contender_win',
    chapter: 2,
    portrait: CHAR_IMG.veteran,
    title: 'Contender',
    type: 'story',
    text: 'You beat the veteran. The bookers notice. A title shot is within reach.',
    choices: [{ id: 'continue', label: 'Prepare for the title.', next: 'mid_career', effects: { reputation: 5, money: 40 } }]
  },
  {
    id: 'contender_loss',
    chapter: 2,
    portrait: CHAR_IMG.veteran,
    title: 'Not Yet',
    type: 'story',
    text: 'The veteran schools you. "Not yet, kid." Back to the grind.',
    choices: [{ id: 'continue', label: 'Train and return.', next: 'camp_2', effects: { stats: { skill: 2 } } }]
  },
  {
    id: 'mid_career',
    chapter: 3,
    portrait: CHAR_IMG.trainer,
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
    portrait: CHAR_IMG.trainer,
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
    opponent: { name: 'The Gatekeeper', image: CHAR_IMG.gatekeeper, stats: { strength: 8, agility: 6, stamina: 8, skill: 8, charisma: 6 } },
    onWin: 'title_shot',
    onLoss: 'title_denied'
  },
  {
    id: 'title_shot',
    chapter: 3,
    title: 'Championship Match',
    type: 'match',
    text: 'The champion awaits. Everything you\'ve worked for.',
    opponent: { name: 'The Champion', image: CHAR_IMG.champion, stats: { strength: 9, agility: 7, stamina: 9, skill: 9, charisma: 8 } },
    onWin: 'champion',
    onLoss: 'title_loss'
  },
  {
    id: 'title_loss',
    chapter: 3,
    title: 'So Close',
    type: 'story',
    portrait: CHAR_IMG.champion,
    text: 'You fall short. The champion respects you, though. "Rematch anytime." But your knee throbs as you leave the ring.',
    choices: [
      { id: 'rematch', label: 'Demand a rematch NOW.', next: 'title_shot', effects: { reputation: 2 } },
      { id: 'rebuild', label: 'Rebuild and return stronger.', next: 'camp_3', effects: { stats: { stamina: 2, skill: 2 } } },
      { id: 'see_doc', label: 'Get the knee checked first.', next: 'injury_scene' }
    ]
  },
  {
    id: 'camp_3',
    chapter: 3,
    portrait: CHAR_IMG.trainer,
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
    portrait: CHAR_IMG.gatekeeper,
    title: 'Denied',
    type: 'story',
    text: 'The Gatekeeper stops you. The title shot slips away.',
    choices: [{ id: 'continue', label: 'Climb back up.', next: 'mid_career', effects: { reputation: -1 } }]
  },
  {
    id: 'champion',
    chapter: 4,
    portrait: CHAR_IMG.champion,
    title: 'Champion!',
    type: 'story',
    text: 'You are the Champion! The belt is yours. The crowd erupts.',
    choices: [
      { id: 'defend', label: 'Defend the title — become a legend.', next: 'celebration', effects: { title: 'Champion', reputation: 10, money: 100 } },
      { id: 'retire', label: 'Retire on top.', next: 'ending_retire', effects: { title: 'Champion', reputation: 8 } }
    ]
  },
  {
    id: 'title_defense',
    chapter: 4,
    title: 'Title Defense',
    type: 'match',
    portrait: CHAR_IMG.challenger,
    text: 'An impromptu open challenge! A mystery opponent storms the ring — and if your rivalry with Viper turned bitter, it\'s him. Defend your belt.',
    opponent: { name: 'Mystery Challenger', image: CHAR_IMG.challenger, stats: { strength: 9, agility: 8, stamina: 9, skill: 9, charisma: 8 } },
    onWin: 'title_defense_win',
    onLoss: 'injury_scene'
  },
  {
    id: 'title_defense_win',
    chapter: 4,
    title: 'Standing Tall',
    type: 'story',
    portrait: CHAR_IMG.announcer,
    text: 'You win the open challenge! The crowd is electric. But the promoter is watching from the ramp, and he doesn\'t look happy about you stealing the show.',
    choices: [
      { id: 'politics', label: 'Go deal with the promoter.', next: 'promoter_visit', effects: { reputation: 3 } },
      { id: 'legend_path', label: 'Seek out the legend for advice.', next: 'legend_scene', effects: { flag: 'mentor', reputation: 2 } }
    ]
  },
  {
    id: 'tag_intro',
    chapter: 3,
    portrait: CHAR_IMG.tag_champs,
    title: 'Tag Team',
    type: 'story',
    text: 'You find a partner and chase tag gold.',
    choices: [{ id: 'continue', label: 'Enter the tag division.', next: 'tag_partner', effects: { flag: 'tag_team' } }]
  },
  {
    id: 'match_tag',
    chapter: 3,
    title: 'Tag Title Match',
    type: 'match',
    text: 'A tag title match. Your partner has your back.',
    opponent: { name: 'Tag Champions', image: CHAR_IMG.tag_champs, stats: { strength: 8, agility: 7, stamina: 8, skill: 7, charisma: 6 } },
    onWin: 'ending_tag_champs',
    onLoss: 'ending_tag_loss'
  },
  {
    id: 'heel_intro',
    chapter: 3,
    portrait: CHAR_IMG.fan_favorite,
    title: 'Heel Turn',
    type: 'story',
    text: 'You embrace the boos. The crowd hates you — and pays to see you lose. But winning as a villain hits different.',
    choices: [{ id: 'continue', label: 'Lean into the heat.', next: 'vyxen_offer', effects: { stats: { charisma: 2 }, reputation: -3 } }]
  },
  {
    id: 'match_heel',
    chapter: 3,
    title: 'Heel Showcase',
    type: 'match',
    portrait: CHAR_IMG.fan_favorite,
    text: 'A showcase match to establish your new persona. The boos are music to your ears.',
    opponent: { name: 'Fan Favorite', image: CHAR_IMG.fan_favorite, stats: { strength: 7, agility: 7, stamina: 7, skill: 7, charisma: 8 } },
    onWin: 'heel_aftermath',
    onLoss: 'ending_heel_loss'
  },
  {
    id: 'heel_aftermath',
    chapter: 3,
    title: 'Heat',
    type: 'story',
    portrait: 'promoter',
    text: 'You destroy the Fan Favorite after the bell. The boos are deafening. The promoter finds you backstage, grinning. "I like you, kid. I can make you RICH."',
    choices: [
      { id: 'deal', label: 'Hear him out.', next: 'promoter_visit', effects: { reputation: -3, money: 50 } },
      { id: 'own_path', label: 'Reject him. You do your own thing.', next: 'mid_career', effects: { reputation: 3 } }
    ]
  },
  // endings
  {
    id: 'ending_retire',
    chapter: 4,
    portrait: CHAR_IMG.champion,
    title: 'Retired on Top',
    type: 'ending',
    text: 'You walk away as champion. A short career, but a perfect one. The crowd will remember you.',
    ending: 'legend'
  },
  {
    id: 'ending_champion',
    chapter: 4,
    portrait: CHAR_IMG.champion,
    title: 'Dynasty',
    type: 'ending',
    text: 'You defend the title and cement your legacy as a dominant champion. A dynasty begins.',
    ending: 'dynasty'
  },
  {
    id: 'ending_lost_title',
    chapter: 4,
    portrait: CHAR_IMG.champion,
    title: 'Fallen Champion',
    type: 'ending',
    text: 'You lose the title. The crowd turns. But the fire to reclaim it burns bright.',
    ending: 'fallen'
  },
  {
    id: 'ending_tag_champs',
    chapter: 4,
    portrait: CHAR_IMG.tag_champs,
    title: 'Tag Team Champions',
    type: 'ending',
    text: 'You and your partner win tag gold. Together, you\'re unstoppable.',
    ending: 'tag_champs'
  },
  {
    id: 'ending_tag_loss',
    chapter: 4,
    portrait: CHAR_IMG.tag_champs,
    title: 'Tag Team Setback',
    type: 'ending',
    text: 'The tag title eludes you. But the partnership endures.',
    ending: 'tag_setback'
  },
  {
    id: 'ending_heel',
    chapter: 4,
    portrait: CHAR_IMG.fan_favorite,
    title: 'The Villain',
    type: 'ending',
    text: 'You win as the heel. Boos rain down — and you love every second. A new era of villainy begins.',
    ending: 'villain'
  },
  {
    id: 'ending_heel_loss',
    chapter: 4,
    portrait: CHAR_IMG.fan_favorite,
    title: 'Heel Humbled',
    type: 'ending',
    text: 'The fan favorite beats you. The crowd cheers. You\'re left to rethink your path.',
    ending: 'humbled'
  },
  {
    id: "tag_partner",
    chapter: 3,
    title: "Meeting El Rayo",
    type: "story",
    portrait: CHAR_IMG.el_rayo,
    text: "Backstage you meet \"El Rayo\" — a high-flying luchador with lightning-fast moves and a thousand-watt smile. \"Amigo! We would tear the tag division apart,\" he says, offering a hand.",
    choices: [
      { id: "team_up", label: "Shake on it — form a real team.", next: "tag_camp", effects: {flag:"tag_loyal",reputation:2,stats:{agility:1}} },
      { id: "use_him", label: "Use him as a stepping stone. You don't need partners.", next: "tag_camp", effects: {flag:"tag_scheming",stats:{charisma:1}} }
    ]
  },
  {
    id: "tag_camp",
    chapter: 3,
    title: "Tag Training",
    type: "training",
    portrait: CHAR_IMG.el_rayo,
    text: "You and your partner drill double-team moves for weeks. Choose what to focus on.",
    statOptions: ["agility","skill","stamina"],
    amount: 3,
    next: "match_tag_open"
  },
  {
    id: "match_tag_open",
    chapter: 3,
    title: "Tag Openers — The Wrecking Crew",
    type: "match",
    portrait: CHAR_IMG.tag_champs,
    text: "Your first match as a team is against a couple of ruthless brawlers called The Wrecking Crew. The crowd loves the new combo.",
    opponent: { name: "Wrecking Crew", image: CHAR_IMG.tag_champs, stats: {"strength":8,"agility":5,"stamina":7,"skill":6,"charisma":5} },
    onWin: "tag_momentum",
    onLoss: "tag_loss_open"
  },
  {
    id: "tag_momentum",
    chapter: 3,
    title: "On A Roll",
    type: "story",
    portrait: CHAR_IMG.el_rayo,
    text: "The wins keep coming. El Rayo grins. \"We're ready for the gold.\" But the promoter eyes you suspiciously — the champs are his hand-picked team.",
    choices: [
      { id: "continue", label: "Challenge for the titles.", next: "match_tag", effects: {reputation:3} }
    ]
  },
  {
    id: "tag_loss_open",
    chapter: 3,
    title: "Setback",
    type: "story",
    portrait: CHAR_IMG.el_rayo,
    text: "Your opponents cheat to win. El Rayo slaps the mat. \"Again, partner. We train harder.\"",
    choices: [
      { id: "continue", label: "Hit the gym and come back.", next: "tag_camp", effects: {stats:{stamina:2}} }
    ]
  },
  {
    id: "vyxen_offer",
    chapter: 3,
    title: "An Offer From Vyxen",
    type: "story",
    portrait: CHAR_IMG.vyxen,
    text: "Backstage, a sharp woman in a black suit — Vyxen, a notorious manager — slides you her card. \"You've got the look. Let me make you a star... and rich.\"",
    choices: [
      { id: "hire", label: "Sign with Vyxen. Let her run the show.", next: "match_heel", effects: {flag:"vyxen_manager",reputation:-1,stats:{charisma:3}} },
      { id: "refuse", label: "Walk alone. You don't need a manager.", next: "match_heel", effects: {reputation:2} }
    ]
  },
  {
    id: "celebration",
    chapter: 5,
    title: "After the Bell",
    type: "story",
    portrait: CHAR_IMG.announcer,
    text: "Confetti rains down. The announcer bellows your name. Backstage, three paths open up.",
    choices: [
      { id: "quick_defense", label: "Issue an open challenge — right now!", next: "title_defense", effects: {reputation:4} },
      { id: "keep_defending", label: "Build a long reign — navigate the politics.", next: "promoter_visit", effects: {reputation:3} },
      { id: "legend_visit", label: "Seek out the retired legend for wisdom.", next: "legend_scene", effects: {flag:"mentor"} },
      { id: "hollywood", label: "Take the Hollywood movie deal.", next: "hollywood_offer", effects: {flag:"hollywood",money:200} }
    ]
  },
  {
    id: "promoter_visit",
    chapter: 5,
    title: "The Promoter's Office",
    type: "story",
    portrait: CHAR_IMG.promoter,
    text: "The promoter pours you a drink. \"Kid, you're gold. Next week — you face The Enforcer. And you... lie down for him. The office needs a new monster. You'll be paid. Handsomely.\"",
    choices: [
      { id: "refuse", label: "No. I fight to win.", next: "enforcer_threat", effects: {reputation:5,flag:"refused_fix"} },
      { id: "accept", label: "Take the money. Business is business.", next: "fix_match", effects: {money:500,reputation:-10,flag:"took_dive"} }
    ]
  },
  {
    id: "enforcer_threat",
    chapter: 5,
    title: "Threats",
    type: "story",
    portrait: CHAR_IMG.promoter,
    text: "The promoter's smile fades. \"Then you face The Enforcer... and he won't be paid to miss.\" Vyxen slides into the room at his side. \"Last chance, champ.\"",
    choices: [
      { id: "fight", label: "Bring him on.", next: "match_enforcer", effects: {reputation:5} },
      { id: "accept_late", label: "On second thought... (take the deal).", next: "fix_match", effects: {money:300,reputation:-8,flag:"took_dive"} }
    ]
  },
  {
    id: "fix_match",
    chapter: 5,
    title: "The Dive",
    type: "match",
    portrait: CHAR_IMG.enforcer,
    text: "The fix is in. You're supposed to lose. But as the bell rings, the crowd is screaming your name...",
    opponent: { name: "The Enforcer", image: CHAR_IMG.enforcer, stats: {"strength":10,"agility":5,"stamina":9,"skill":7,"charisma":6} },
    onWin: "double_cross",
    onLoss: "corporate_champ"
  },
  {
    id: "double_cross",
    chapter: 5,
    title: "The Double Cross",
    type: "story",
    portrait: CHAR_IMG.enforcer,
    text: "You double-cross the promoter — you BEAT The Enforcer clean! The arena erupts. The promoter is purple with rage. The crowd carries you on their shoulders.",
    choices: [
      { id: "continue", label: "You're the people's champion.", next: "ending_hero", effects: {reputation:15,money:0} }
    ]
  },
  {
    id: "corporate_champ",
    chapter: 5,
    title: "The Corporate Champion",
    type: "story",
    portrait: CHAR_IMG.promoter,
    text: "You take the dive. The Enforcer wins the belt. The promoter slips you an envelope of cash. The boos are deafening... but your bank account is fat.",
    choices: [
      { id: "continue", label: "Easy money.", next: "ending_corporate", effects: {reputation:-5} }
    ]
  },
  {
    id: "match_enforcer",
    chapter: 5,
    title: "No DQ — The Enforcer",
    type: "match",
    portrait: CHAR_IMG.enforcer,
    text: "A no-disqualification war. The Enforcer brings chairs, chains, and fury. Survive.",
    opponent: { name: "The Enforcer", image: CHAR_IMG.enforcer, stats: {"strength":10,"agility":6,"stamina":9,"skill":7,"charisma":5} },
    onWin: "ending_hero",
    onLoss: "injury_scene"
  },
  {
    id: "legend_scene",
    chapter: 5,
    title: "Wisdom",
    type: "story",
    portrait: CHAR_IMG.legend,
    text: "You find the retired legend in a quiet bar, watching old tapes. \"Kid,\" he says, \"the belt tarnishes. The money fades. But the moments people remember? Those are forever. So what will YOUR moment be?\"",
    choices: [
      { id: "defend", label: "I'll be the greatest fighting champion ever.", next: "promoter_visit", effects: {reputation:4} },
      { id: "pass_torch", label: "I want to lift others up, like you lifted me.", next: "mentor_young", effects: {flag:"mentor_ending",reputation:8} }
    ]
  },
  {
    id: "mentor_young",
    chapter: 5,
    title: "Passing the Torch",
    type: "story",
    portrait: CHAR_IMG.legend,
    text: "You spend your remaining years running camps, training the next generation, and occasionally showing up to put over the next big star. The ring is in good hands.",
    choices: [
      { id: "continue", label: "Your legacy is secure.", next: "ending_mentor" }
    ]
  },
  {
    id: "hollywood_offer",
    chapter: 5,
    title: "Hollywood Calls",
    type: "story",
    portrait: CHAR_IMG.promoter,
    text: "A movie deal on the table. Big money, bright lights — but it means walking away from the ring at your peak.",
    choices: [
      { id: "take_it", label: "Hollywood, baby!", next: "ending_hollywood", effects: {money:1000} },
      { id: "stay", label: "The ring is where I belong.", next: "promoter_visit", effects: {reputation:4} }
    ]
  },
  {
    id: "injury_scene",
    chapter: 5,
    title: "The Doctor",
    type: "story",
    portrait: CHAR_IMG.doctor,
    text: "You wake up in the trainer's room. The doctor frowns. \"That's a torn shoulder. You could rehab... or you could take the hint and walk away.\"",
    choices: [
      { id: "rehab", label: "I'm coming back.", next: "comeback_camp", effects: {stats:{stamina:-3}} },
      { id: "retire_hurt", label: "Maybe it's time.", next: "ending_forced_retire", effects: {reputation:2} }
    ]
  },
  {
    id: "comeback_camp",
    chapter: 5,
    title: "The Long Comeback",
    type: "training",
    portrait: CHAR_IMG.legend,
    text: "Months of rehab and grinding. The legend even shows up to coach you. Choose what to rebuild.",
    statOptions: ["strength","stamina","skill"],
    amount: 5,
    next: "match_comeback"
  },
  {
    id: "match_comeback",
    chapter: 5,
    title: "Redemption Match",
    type: "match",
    portrait: CHAR_IMG.enforcer,
    text: "The Enforcer stands across the ring again. One more shot. Everything to win.",
    opponent: { name: "The Enforcer", image: CHAR_IMG.enforcer, stats: {"strength":9,"agility":6,"stamina":9,"skill":7,"charisma":6} },
    onWin: "ending_comeback",
    onLoss: "ending_lost_title"
  },
  {
    id: "title_loss_deep",
    chapter: 4,
    title: "So Close (reprise)",
    type: "story",
    portrait: CHAR_IMG.champion,
    text: "The champion respects you. \"Rematch anytime.\" But you feel something pop in your knee on the way out.",
    choices: [
      { id: "rematch_imm", label: "Demand a rematch NOW.", next: "title_shot", effects: {reputation:2} },
      { id: "rebuild", label: "Rebuild and return stronger.", next: "camp_3", effects: {stats:{stamina:2,skill:2}} },
      { id: "see_doc", label: "Get the knee checked first.", next: "injury_scene" }
    ]
  },
  {
    id: "ending_hero",
    chapter: 5,
    title: "The People's Champion",
    type: "ending",
    portrait: CHAR_IMG.announcer,
    text: "You beat the machine. You beat the fix. The people's champion — the kind that gets statues and documentaries. They'll tell stories about you forever.",
    ending: "hero"
  },
  {
    id: "ending_corporate",
    chapter: 5,
    title: "Corporate Sellout",
    type: "ending",
    portrait: CHAR_IMG.promoter,
    text: "You took the money. The belt is gone, but the bank account is full. The fans boo. You tell yourself you don't care. Late at night... sometimes you do.",
    ending: "corporate"
  },
  {
    id: "ending_mentor",
    chapter: 5,
    title: "The Mentor",
    type: "ending",
    portrait: CHAR_IMG.legend,
    text: "Your name isn't on every marquee anymore — but when your students lift the belt, you know: legacy isn't what you win. It's what you give away.",
    ending: "mentor"
  },
  {
    id: "ending_hollywood",
    chapter: 5,
    title: "Lights! Camera! Wrestling!",
    type: "ending",
    portrait: CHAR_IMG.announcer,
    text: "You become a movie star. The wrestling purists grumble, but your face is on billboards and your catchphrase becomes a meme. A different kind of legend.",
    ending: "hollywood"
  },
  {
    id: "ending_comeback",
    chapter: 5,
    title: "The Comeback Kid",
    type: "ending",
    portrait: CHAR_IMG.announcer,
    text: "Months of rehab. All the doubt. All the critics. And you climbed back to the top of the mountain. The greatest comeback story the business ever saw.",
    ending: "comeback"
  },
  {
    id: "ending_forced_retire",
    chapter: 5,
    title: "Shoulder to the Wheel",
    type: "ending",
    portrait: CHAR_IMG.doctor,
    text: "You walk away before the business breaks you. Not the ending you wanted, but your body thanks you. You find peace away from the ring.",
    ending: "retired_hurt"
  },
  {
    id: "ending_tag_betrayal",
    chapter: 4,
    title: "Betrayal",
    type: "ending",
    portrait: CHAR_IMG.el_rayo,
    text: "You turned on El Rayo mid-match for a quick payoff from the promoter. The tag gold is yours — briefly — but no one wants to team with you ever again. A short, lonely title reign.",
    ending: "tag_betrayal"
  },
  {
    id: "tag_betray_win",
    chapter: 4,
    title: "Bitter Gold",
    type: "story",
    portrait: CHAR_IMG.el_rayo,
    text: "Your betrayal worked. The tag titles are yours — but the locker room hates you, El Rayo swears revenge, and the gold feels heavy.",
    choices: [
      { id: "continue", label: "Take the heat.", next: "ending_tag_betrayal", effects: {reputation:-8,money:100} }
    ]
  }
];

const NODES = {};
STORY.forEach(function (n) { NODES[n.id] = n; });

function getNode(id) { return NODES[id] || null; }

// Resolve a node for the given state — clones it and applies any dynamic
// context (e.g. title-defense opponent changes based on career flags).
function resolveNode(id, state) {
  const base = NODES[id];
  if (!base) return null;
  const node = Object.assign({}, base);
  if (id === 'title_defense' && state && state.flags && state.flags.rival_bitter) {
    node.opponent = Object.assign({}, base.opponent, {
      name: 'Viper',
      image: CHAR_IMG.viper
    });
    node.portrait = CHAR_IMG.viper;
    node.title = 'Title Defense — Viper Returns';
    node.text = 'The bitter rivalry reignites. Viper has earned his shot and he wants your belt. Defend it.';
  }
  // Tag team betrayal arc: if player chose "use him", add post-win betrayal option path
  if (id === 'match_tag' && state && state.flags && state.flags.tag_scheming) {
    node.onWin = 'tag_betray_win';
    node.text = 'The tag titles are on the line. You could win clean... or turn on El Rayo mid-match for a fat promoter payout.';
  }
  // Respectful Viper: if player offered handshake, Viper returns as ally for enforcer feud
  if (id === 'enforcer_threat' && state && state.flags && state.flags.rival_respect) {
    node.text = 'The promoter\'s smile fades. "Then you face The Enforcer... and he won\'t be paid to miss." The door swings open — Viper steps in. "Hey champ. I owe you one. Let\'s even the odds."';
  }
  return node;
}

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
  const node = resolveNode(state.currentNode, state);
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

function currentNode(state) { return resolveNode(state.currentNode, state); }

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
  resolveNode: resolveNode,
  CHAR_IMG: CHAR_IMG,
  CELEBRATION_NODE: "celebration",
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
