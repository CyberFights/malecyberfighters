/**
 * Achievements — badges for milestones a member actually crosses.
 *
 * Cheap to compute, cheap to store: the catalogue is a list of predicates over
 * facts the server already knows (matches recorded, stories published,
 * challenges sent, relationships approved, forum posts), and a member's
 * unlocked set is an array of `{ id, unlockedAt }` on their own document.
 *
 * Everything is evaluated server-side on the events that could change the
 * answer, so there is nothing for a client to forge — the worst a broken
 * client can do is not see a badge.
 *
 * The evaluator is a pure function of (user document, event, context), which
 * is what makes it testable without a database — see tests/achievements.test.js.
 */
'use strict';

/**
 * The catalogue. `icon` is an emoji so no asset needs to ship; `title` and
 * `description` are what the popup shows. Ids are stable strings — never
 * rename one, retire it instead (a stored id with no catalogue entry simply
 * stops being displayed).
 */
const CATALOGUE = [
  {
    id: 'first_match',
    icon: '🥊',
    title: 'First Bell',
    description: 'Complete your first recorded match.'
  },
  {
    id: 'wins_10',
    icon: '🏅',
    title: 'Ten Pack',
    description: 'Reach 10 confirmed wins.'
  },
  {
    id: 'wins_25',
    icon: '👑',
    title: 'Card Main Event',
    description: 'Reach 25 confirmed wins.'
  },
  {
    id: 'ironman',
    icon: '🩸',
    title: 'Ironman',
    description: 'Win a dice match from under 10 HP.'
  },
  {
    id: 'first_story',
    icon: '📖',
    title: 'Storyteller',
    description: 'Publish your first story to the Archives.'
  },
  {
    id: 'stories_5',
    icon: '📚',
    title: 'Anthology',
    description: 'Publish five stories to the Archives.'
  },
  {
    id: 'challenger',
    icon: '📮',
    title: 'The Callout',
    description: 'Send your first formal challenge.'
  },
  {
    id: 'rival',
    icon: '⚔️',
    title: 'Rivalry',
    description: 'Fight the same opponent three times.'
  },
  {
    id: 'allied',
    icon: '🤝',
    title: 'Allies',
    description: 'Have an approved relationship with another member.'
  },
  {
    id: 'first_post',
    icon: '📣',
    title: 'Mic Check',
    description: 'Start your first forum thread.'
  }
];

const byId = new Map(CATALOGUE.map(entry => [entry.id, entry]));

const catalogueEntry = id => byId.get(String(id || '')) || null;

const unlockedIds = user =>
  new Set((user && Array.isArray(user.achievements) ? user.achievements : [])
    .map(entry => entry && entry.id)
    .filter(Boolean));

/**
 * Which achievements an event just unlocked for a member.
 *
 * @param {object} args
 * @param {object} args.user      the member's document (achievements, wins, …)
 * @param {string} args.event     what just happened
 * @param {object} [args.context] extra facts (match, storyCount, …)
 * @returns {string[]} catalogue ids newly unlocked (never already-held ones)
 */
function evaluate({ user, event, context = {} }) {
  if (!user) return [];
  const held = unlockedIds(user);
  const fresh = [];

  const unlock = id => {
    if (!held.has(id) && byId.has(id) && !fresh.includes(id)) fresh.push(id);
  };

  const wins = Number(user.wins) || 0;

  switch (event) {
    case 'match_recorded': {
      unlock('first_match');
      if (wins >= 10) unlock('wins_10');
      if (wins >= 25) unlock('wins_25');
      // Ironman: the engine knows the winner's closing HP; a win from under
      // 10 is the comeback badge.
      const match = context.match || {};
      if (match.winner === user.username && match.closingHp != null && match.closingHp < 10) {
        unlock('ironman');
      }
      // Rivalry: three matches against one opponent.
      if (context.opponentMatches >= 3) unlock('rival');
      break;
    }

    case 'story_published': {
      unlock('first_story');
      if ((Number(context.storyCount) || 0) >= 5) unlock('stories_5');
      break;
    }

    case 'challenge_sent':
      unlock('challenger');
      break;

    case 'relationship_approved':
      unlock('allied');
      break;

    case 'forum_posted':
      unlock('first_post');
      break;

    default:
      break;
  }

  return fresh;
}

/**
 * The achievements view for a member: the catalogue with held/unheld marked,
 * so the popup can show locked badges as goals rather than hiding them.
 */
function catalogueView(user) {
  const held = unlockedIds(user);
  const unlockedList = (user && Array.isArray(user.achievements) ? user.achievements : [])
    .filter(entry => entry && entry.id && byId.has(entry.id));

  return {
    unlocked: unlockedList.map(entry => ({
      ...catalogueEntry(entry.id),
      unlockedAt: entry.unlockedAt || null
    })),
    locked: CATALOGUE
      .filter(entry => !held.has(entry.id))
      .map(entry => ({ ...entry, unlockedAt: null })),
    total: CATALOGUE.length
  };
}

module.exports = { CATALOGUE, catalogueEntry, catalogueView, evaluate, unlockedIds };
