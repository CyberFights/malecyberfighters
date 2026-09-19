/**
 * Mentions — @name extraction and resolution. The rules that matter: a
 * sender never pings themselves, and a member who blocked the sender is
 * never pinged by them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractMentionTokens, resolveMentions } = require('../mentions.js');

function fakeUser(users) {
  return {
    find: query => ({
      select: () => ({
        lean: async () => users.filter(user => (query.username.$in || []).includes(user.username))
      })
    })
  };
}

test('extraction finds @names in the username character set', () => {
  assert.deepEqual(
    extractMentionTokens('hey @Jax and @ring.king_99, watch this'),
    ['jax', 'ring.king_99']
  );
});

test('extraction is case-insensitive and deduplicated', () => {
  assert.deepEqual(extractMentionTokens('@Jax @jax @JAX'), ['jax']);
});

test('an email address does produce a token — resolution is the real gate', () => {
  // The extractor is deliberately cheap: "@site.com" parses as a candidate
  // because '.' belongs to the username charset. The database lookup is what
  // decides it is a mention (a member actually named site.com would be one).
  assert.deepEqual(extractMentionTokens('jax@site.com'), ['site.com']);
  assert.deepEqual(extractMentionTokens('trailing @ and @@ nothing'), []);
});

test('extraction ignores single characters', () => {
  assert.deepEqual(extractMentionTokens('a @ b @c'), []);
});

test('resolveMentions drops the sender and blocked members', async () => {
  const User = fakeUser([
    { username: 'jax', blockedUsers: [] },
    { username: 'blocked', blockedUsers: ['alpha'] },
    { username: 'site.com', blockedUsers: [] } // the email's candidate token
  ]);
  const mentions = await resolveMentions({ text: 'hey @JAX, @blocked — jax@site.com', from: 'alpha', User });
  // jax is pinged, blocked blocked alpha so is not, and site.com is a real
  // member here so the email address does resolve as a mention
  assert.deepEqual(mentions, ['jax', 'site.com']);
});

test('the sender never pings themselves', async () => {
  const User = fakeUser([{ username: 'alpha', blockedUsers: [] }]);
  const mentions = await resolveMentions({ text: 'I am @alpha', from: 'alpha', User });
  assert.deepEqual(mentions, []);
});

test('a message with no @s makes no database call', async () => {
  let queried = false;
  const User = { find: () => { queried = true; throw new Error('should not be called'); } };
  const mentions = await resolveMentions({ text: 'plain text', from: 'alpha', User });
  assert.deepEqual(mentions, []);
  assert.equal(queried, false);
});

test('a database error resolves to no mentions, never a thrown one', async () => {
  const User = { find: () => { throw new Error('db down'); } };
  const mentions = await resolveMentions({ text: 'hey @jax', from: 'alpha', User });
  assert.deepEqual(mentions, []);
});
