# Discord DM Bridge — Setup

Forwards a short "you have a new message" notification into a user's **real Discord DMs**
when they receive a site DM while offline.

A Discord *webhook* can only post into a channel, so this uses a **bot** plus **OAuth2
account linking**.

## 1. Create the Discord application

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Add Bot** → copy the **token** (`DISCORD_BOT_TOKEN`).
3. **OAuth2** tab → copy **Client ID** and **Client Secret**.
4. **OAuth2 → Redirects** → add exactly:
   `https://your-domain.tld/auth/discord/callback`

## 2. Invite the bot to your server

Discord only lets a bot DM users who **share a guild with it**. Generate an invite URL:

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot&permissions=0
```

Invite it to your community server and tell members they must be in that server
(and have "Allow direct messages from server members" enabled) to receive notifications.

## 3. Environment variables

```env
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_BOT_TOKEN=...
PUBLIC_BASE_URL=https://your-domain.tld
# optional overrides
DISCORD_OAUTH_REDIRECT=https://your-domain.tld/auth/discord/callback
DISCORD_STATE_SECRET=<random string; falls back to ADMIN_KEY>
```

Without `DISCORD_CLIENT_ID/SECRET` the settings section shows "not configured" and
nothing breaks. Without `DISCORD_BOT_TOKEN`, linking still works but no DMs are sent.

## 4. What was added

**Server (`index.js`)**

| Piece | Purpose |
|---|---|
| `discordId`, `discordTag`, `discordDmOptIn`, `discordDmError` on `userSchema` | link state per user |
| `GET /auth/discord?username=` | starts OAuth (HMAC-signed, 15-min `state`) |
| `GET /auth/discord/callback` | exchanges the code, stores the snowflake, sends a confirmation DM |
| `GET /api/discord/status?username=` | powers the settings UI |
| `POST /api/discord/opt-in` | toggle forwarding |
| `POST /api/discord/unlink` | password-confirmed unlink |
| `sendDiscordDM(user, text)` | opens/reuses a DM channel, posts the message |
| `notifyDiscordOfSiteDM(to, from, {preview})` | short preview + site link |

Hooked into the **offline** branches of `POST /api/send-dm` and the socket
`privateMessage` handler (text + image), so online users are unaffected.

**Client**

- `public/js/discord.js` — settings section logic (shared desktop/mobile)
- "Discord Notifications" block added to the Account Settings modal in
  `public/index.html` and `public/mobile.html`

## 5. Safeguards built in

- **Opt-in only** — nothing is forwarded unless the user linked *and* toggled it on.
- **Preview, not full content** — only ~180 chars, images become `[image]`.
- `allowed_mentions: { parse: [] }` — a site message can never ping `@everyone` on Discord.
- **DM channel cache** — avoids hammering the strict `/users/@me/channels` rate limit.
- **429 handling** and 403 handling — a 403 ("cannot send messages to this user") is
  recorded in `discordDmError` and surfaced in the UI instead of being retried forever.
- One Discord account can only be attached to one site account at a time.

## 6. Abuse warning

Mass-DMing users who never interact with your bot is a fast route to a Discord
account/bot ban. Keep it to genuine, opt-in notifications only.
