/**
 * Discord invite rewriting for chat text.
 *
 * An invite URL posted on the site poaches members from the site's own
 * Discord, so every chat message — public chat, custom rooms, and DMs — is
 * rewritten: any Discord invite URL it contains is replaced with the site's
 * official invite before the text is persisted, translated, bridged to the
 * Discord webhook, or delivered to other users. (One replacement target
 * means running the rewrite twice is the same as running it once, so edits
 * re-sanitise safely.)
 *
 * Recognised invite forms (scheme and leading "www." optional, matching is
 * case-insensitive):
 *   discord.gg/<code>
 *   discord.com/invite/<code>
 *   discordapp.com/invite/<code>   (legacy app domain)
 *
 * Everything else a user might post — bare "discord.gg", channel links, CDN
 * attachment URLs, non-invite domains — is left untouched.
 */

// The single invite the whole site points at. Overridable so rotating the
// invite (revoked link, changed vanity code) is a config edit, not a deploy.
const OFFICIAL_INVITE_URL =
  process.env.DISCORD_INVITE_URL || 'https://discord.gg/CBetKKfyR9';

// An invite code is a run of letters, digits, hyphens and underscores, which
// naturally stops the match before trailing sentence punctuation or query
// strings ("...discord.gg/abc!).". The lookbehind keeps a match from starting
// inside a longer hostname (e.g. "notdiscord.gg/abc" is not an invite).
const INVITE_URL =
  /(?<![\w.-])(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9_-]+/gi;

/**
 * Replace every Discord invite URL in `text` with the official invite.
 * Non-strings pass through unchanged so callers can feed optional fields.
 */
function rewriteDiscordInvites(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(INVITE_URL, OFFICIAL_INVITE_URL);
}

module.exports = { OFFICIAL_INVITE_URL, rewriteDiscordInvites };
