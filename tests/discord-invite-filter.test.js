/**
 * Tests for discordInviteFilter.js — every Discord invite URL sent in a room
 * must come out as the site's official invite, everything else passes through.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const OFFICIAL = 'https://discord.gg/CBetKKfyR9';
const { OFFICIAL_INVITE_URL, rewriteDiscordInvites } = require('../discordInviteFilter');

test('official invite defaults to the site invite', () => {
  assert.equal(OFFICIAL_INVITE_URL, OFFICIAL);
});

test('rewrites bare discord.gg invite links', () => {
  assert.equal(
    rewriteDiscordInvites('come join discord.gg/abc123 we are better'),
    `come join ${OFFICIAL} we are better`
  );
});

test('rewrites invite links with scheme and www', () => {
  for (const raw of [
    'https://discord.gg/abc123',
    'http://discord.gg/abc123',
    'www.discord.gg/abc123',
    'https://www.discord.gg/abc123'
  ]) {
    assert.equal(rewriteDiscordInvites(raw), OFFICIAL, raw);
  }
});

test('rewrites discord.com and legacy discordapp.com invite links', () => {
  for (const raw of [
    'https://discord.com/invite/abc123',
    'http://www.discord.com/invite/abc123',
    'https://discordapp.com/invite/abc123',
    'discord.com/invite/abc123'
  ]) {
    assert.equal(rewriteDiscordInvites(raw), OFFICIAL, raw);
  }
});

test('is case-insensitive', () => {
  assert.equal(rewriteDiscordInvites('DISCORD.GG/AbC'), OFFICIAL);
  assert.equal(rewriteDiscordInvites('Discord.Com/Invite/AbC'), OFFICIAL);
});

test('rewrites every invite in a message, keeping surrounding text and punctuation', () => {
  assert.equal(
    rewriteDiscordInvites('join https://discord.gg/aaa, or discord.gg/bbb? seriously.'),
    `join ${OFFICIAL}, or ${OFFICIAL}? seriously.`
  );
});

test('the official invite itself is untouched (rewriting is idempotent)', () => {
  assert.equal(rewriteDiscordInvites(OFFICIAL), OFFICIAL);
  const once = rewriteDiscordInvites('discord.gg/zzz');
  assert.equal(rewriteDiscordInvites(once), once);
});

test('leaves non-invite Discord URLs alone', () => {
  const left = [
    'discord.gg',                       // host with no code
    'https://discord.com/invite',       // no code
    'https://discord.com/channels/1/2',
    'https://cdn.discordapp.com/attachments/1/2/a.png',
    'https://media.discordapp.net/attachments/1/2/a.png'
  ];
  for (const raw of left) {
    assert.equal(rewriteDiscordInvites(raw), raw, raw);
  }
});

test('does not match inside a longer hostname', () => {
  assert.equal(rewriteDiscordInvites('notdiscord.gg/abc'), 'notdiscord.gg/abc');
  assert.equal(
    rewriteDiscordInvites('see https://discord.gg.evil.co/x'),
    'see https://discord.gg.evil.co/x'
  );
});

test('non-string input passes through unchanged', () => {
  assert.equal(rewriteDiscordInvites(null), null);
  assert.equal(rewriteDiscordInvites(undefined), undefined);
  assert.equal(rewriteDiscordInvites(''), '');
  assert.equal(rewriteDiscordInvites(42), 42);
});

test('DISCORD_INVITE_URL env var overrides the replacement', async () => {
  const modulePath = require.resolve('../discordInviteFilter');
  const cached = require.cache[modulePath];
  process.env.DISCORD_INVITE_URL = 'https://discord.gg/custom-vanity';
  try {
    delete require.cache[modulePath];
    const fresh = require('../discordInviteFilter');
    assert.equal(fresh.OFFICIAL_INVITE_URL, 'https://discord.gg/custom-vanity');
    assert.equal(fresh.rewriteDiscordInvites('discord.gg/abc'), 'https://discord.gg/custom-vanity');
  } finally {
    delete process.env.DISCORD_INVITE_URL;
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }
  assert.equal(rewriteDiscordInvites('discord.gg/abc'), OFFICIAL);
});
