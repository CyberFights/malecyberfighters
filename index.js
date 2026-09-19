require('dotenv').config();
const FormData = require('form-data');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cors = require("cors");
const { sendMail, mailerConfigured, MAIL_FROM, escapeHtml } = require('./mailer');
const { sendDiscordDM, discordEvents } = require('./discordBot');
const { rewriteDiscordInvites } = require('./discordInviteFilter');
const { createDmDelivery } = require('./dmDelivery');
const { createStoryRouter } = require('./storyRoutes');
const { createSessionManager, cookieOptions, safeEqual, COOKIE_NAME } = require('./sessions');
const { createRetentionJob, configFromEnv } = require('./retention');
const { createPushNotifier } = require('./pushNotifications');
const assets = require('./assets');
const { pagingRequest, pageEnvelope } = require('./historyPaging');
const {
  buildWebhookPayload,
  publicBaseUrlFromSocket,
  resolveWebhookAvatarUrl,
  avatarInitial,
  renderInitialsAvatarPng
} = require('./discordWebhook');
// ---------- FEATURE MODULES ----------
// Each is split out of this file the way dmDelivery.js / storyRoutes.js were,
// so its rules can run under tests without a server: the LFG board, formal
// challenges, the match record, message reactions, mention pings, bookmarks,
// moderation reports, achievements, and per-kind notification preferences.
const { createLfgRouter } = require('./lfg');
const { createChallengeRouter } = require('./challenges');
const { createMatchHistoryRouter } = require('./matchHistory');
const reactions = require('./reactions');
const { resolveMentions } = require('./mentions');
const { createReportsRouter, summarizeForDispatch } = require('./reports');
const achievements = require('./achievements');
const notificationPrefs = require('./notificationPrefs');
const { canEditDM, canDeleteDM } = require('./dmDelivery');
// The match style catalogue lives in public/js so the browser pickers and the
// API validation can never drift apart — same rule as physique.js / tags.js.
const matchStyles = require('./public/js/match-styles.js');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cyberfights';
if (!process.env.MONGO_URI) console.warn('Warning: MONGO_URI not set — defaulting to mongodb://127.0.0.1:27017/cyberfights (may fail if Mongo is not running)');
const ADMIN_KEY = process.env.ADMIN_KEY;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_PROXIED_IMAGE_SIZE = 12 * 1024 * 1024;
const IMAGE_PROXY_TIMEOUT_MS = 15 * 1000;
const MAX_EXTRA_PROFILE_PHOTOS = 10;

// Short video clips + GIFs sent in DMs / custom rooms and attached to
// stories. These are stored on the local disk (ImgBB is images-only) and
// served back from the /clips static route.
const MAX_GIF_SIZE = 25 * 1024 * 1024;        // 25 MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;      // 50 MB
const MAX_UPLOADS_TOTAL_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB hard cap for all clips
const ALLOWED_CLIP_MIME = {
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm'
};
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'clips');

const DISCORD_WEBHOOK_URL = process.env.Discord_webhook || null;
const DISCORD_SUPPORT_URL = process.env.Discord_Support || null;
const EMAIL_ADMIN_ALERTS = String(process.env.EMAIL_ADMIN_ALERTS || 'false').toLowerCase() === 'true';

// Shared secret for POST /api/chatMessage, the ingress the Discord bridge uses
// to publish a channel message into the arena. Empty means the route accepts a
// member session only.
const CHAT_INGRESS_KEY = (process.env.CHAT_INGRESS_KEY || '').trim();

// Public base URL used when building the password-reset link in emails.
// Defaults to the request origin when not set (see getBaseUrl()).
const APP_BASE_URL = process.env.APP_BASE_URL || null;
// How long a password-reset link stays valid.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// A DM window opens on the most recent page of the conversation and can ask
// for the page before it. Unbounded history meant one request pulled every
// message two members had ever exchanged.
const DM_HISTORY_PAGE = 200;
const DM_HISTORY_MAX = 500;

// The arena feed behaves the same way: it opens on the newest page and scrolls
// back a page at a time. Before this, "load the public messages" always meant
// "load the newest 200", so anything older was simply unreachable.
const PUBLIC_HISTORY_PAGE = 200;
const PUBLIC_HISTORY_MAX = 500;



// ---------- MIDDLEWARE ----------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://i.ibb.co", "https://ibb.co", "https://cdn.discordapp.com", "https://media.discordapp.net"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "data:"],
        frameAncestors: ["'self'"],
        frameSrc: ["'self'"],
        mediaSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    }
  })
);
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

function isMobileClient(req) {
  // Prefer Sec-CH-UA-Mobile when available (client hints). Browsers will provide this header
  // after they see an Accept-CH response header. Fall back to UA sniffing when the hint is absent.
  const mobileHint = req.headers['sec-ch-ua-mobile'];

  if (typeof mobileHint === 'string') {
    return mobileHint.trim() === '?1';
  }

  const ua = (req.headers['user-agent'] || '').toLowerCase();

  // Broader fallback regex that matches mobile phones and many tablets; more resilient across UAs.
  return /mobi|iphone|android|ipad|ipod|iemobile|opera mini|mobile/i.test(ua);
}

// The app shell, and the stylesheet tag injected into it. Both resolve through
// assets.js so a deploy that produced public/dist serves the minified,
// content-hashed bundle (cached immutably) while one that did not keeps
// serving the hand-written files — same page either way.
const appShellPath = () => assets.pageFile('index.html');
const stylesheetTag = cssFile =>
  `<link rel="stylesheet" href="${assets.assetUrl(`/css/${cssFile}`, 'css')}">`;

// The stylesheet regex matches both the source href (/css/desktop.css) and the
// built one (/dist/css/desktop.<hash>.css), so the mobile/desktop swap works
// whichever copy of the shell is being served.
const STYLESHEET_LINK_RE = /<link\s+rel=["']stylesheet["']\s+href=["'][^"']*\/css\/[^"']+["']\s*>/i;

app.get('/', (req, res, next) => {
  const cssFile = isMobileClient(req) ? 'mobile.css' : 'desktop.css';
  const indexPath = appShellPath();

  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return next(err);

    const page = html.replace(STYLESHEET_LINK_RE, stylesheetTag(cssFile));

    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Accept-CH': 'Sec-CH-UA-Mobile',
      'Vary': 'User-Agent, Sec-CH-UA-Mobile'
    });

    res.send(page);
  });
});

// ---------- STORY PERMALINKS ----------
// /story/<id> boots the app and lets public/js/story-ui.js open the story from
// the URL. Published stories get real social-preview tags so a link pasted
// into Discord shows the title and the opening lines; anything still awaiting
// approval is served the plain shell (and stays noindex, like every story page
// — these are member-written stories, not site content we invite crawlers to).
app.get('/story/:id', async (req, res, next) => {
  const cssFile = isMobileClient(req) ? 'mobile.css' : 'desktop.css';
  const indexPath = appShellPath();

  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.redirect('/');

  let story = null;
  try {
    // Only ask the database when it is actually connected: otherwise the query
    // buffers for five seconds before failing, and a link would crawl while the
    // database is away. The plain shell is served either way — the app fetches
    // the story itself once it is running.
    if (mongoose.connection.readyState === 1) {
      story = await Story.findOne({ _id: id, approved: true, declined: { $ne: true } })
        .select('title story owner partner approvedAt')
        .lean();
    }
  } catch (err) {
    console.error('Story permalink error:', err.message || err);
  }

  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return next(err);

    const title = story
      ? `${story.title || 'Untitled story'} — ${story.owner} & ${story.partner}`
      : 'Male Cyber Fighters';

    const description = story
      ? String(story.story || '').replace(/\s+/g, ' ').trim().slice(0, 180)
      : 'A story written on Male Cyber Fighters.';

    const page = html
      .replace(
        STYLESHEET_LINK_RE,
        stylesheetTag(cssFile)
      )
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`)
      .replace(/<head>/i, '<head>\n<meta name="robots" content="noindex, follow">')
      .replace(/(<meta\s+property=["']og:title["']\s+content=["'])[^"']*(["']>)/i, `$1${escapeHtml(title)}$2`)
      .replace(/(<meta\s+property=["']og:description["']\s+content=["'])[^"']*(["']>)/i, `$1${escapeHtml(description)}$2`)
      .replace(/(<meta\s+property=["']og:url["']\s+content=["'])[^"']*(["']>)/i, `$1/story/${id}$2`)
      .replace(/(<meta\s+name=["']twitter:title["']\s+content=["'])[^"']*(["']>)/i, `$1${escapeHtml(title)}$2`)
      .replace(/(<meta\s+name=["']twitter:description["']\s+content=["'])[^"']*(["']>)/i, `$1${escapeHtml(description)}$2`);

    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Accept-CH': 'Sec-CH-UA-Mobile',
      'Vary': 'User-Agent, Sec-CH-UA-Mobile'
    });

    res.send(page);
  });
});

// ---------- BEGINNER'S GUIDE ----------
// The public, indexable "How to Cyber Wrestle" guide. The same page feeds the
// in-app Beginner's Guide modal: public/js/guide.js fetches /guide and injects
// the #guideBody markup into #guideContent, so the modal and the page share a
// single copy of the content. (express.static also serves the file at
// /guide.html; robots.txt points crawlers at this canonical /guide URL.)
app.get('/guide', (req, res, next) => {
  const guidePath = assets.pageFile('guide.html');

  fs.readFile(guidePath, 'utf8', (err, html) => {
    if (err) return next(err);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
});

// ---------- HP DICE-MATCH API PROXY ----------
// The chat text bars support slash commands (/roll, /submit, /escape, ...)
// backed by the Hp stamina-bar service (https://github.com/CyberFights/Hp).
// That service does not send CORS headers, so the browser calls this proxy
// instead of the Hp server directly. When HP_API_URL is not configured the
// client falls back to its built-in local dice engine.
const HP_API_URL = (process.env.HP_API_URL || '').trim().replace(/\/+$/, '');
const HP_ALLOWED_ACTIONS = new Set([
  // server.js — stateless dice-match actions
  'roll', 'submit', 'escape', 'pin-escape', 'tease', 'recover',
  // server2.js — stateful game endpoints
  'create-game', 'join-game', 'dice-match', 'game-state', 'end-game', 'end-all-games'
]);
const HP_PROXY_TIMEOUT_MS = 8 * 1000;

app.get('/api/hp-config', (req, res) => {
  // True whenever /api/hp/* can resolve a command: the external Hp service
  // (remote: true) or the embedded engine below. Clients therefore always
  // talk to this server for match state, which is shared across every
  // player instead of living in one browser's localStorage.
  res.json({ configured: true, remote: !!HP_API_URL });
});

app.post('/api/hp/:action', async (req, res) => {
  const action = req.params.action;

  if (!HP_ALLOWED_ACTIONS.has(action)) {
    return res.status(404).json({ error: 'Unknown Hp action.' });
  }
  if (!HP_API_URL) {
    // No external Hp service — resolve the command with the embedded
    // in-process engine below so match state is shared between all
    // clients. (Previously this returned 503 and the client fell back to
    // a per-browser localStorage engine, so a second player on another
    // device could never find the first player's room and the match was
    // stuck on "waiting for second player".)
    let reply;
    try {
      reply = await hpEmbeddedAction(action, req.body || {});
    } catch (err) {
      console.error('Embedded Hp engine error:', err?.message || err);
      return res.status(500).json({ error: 'Internal server error.' });
    }
    return res.status(reply.status).json(reply.body);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HP_PROXY_TIMEOUT_MS);

    const upstream = await fetch(`${HP_API_URL}/api/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: controller.signal
    });
    clearTimeout(timer);

    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    return res.status(upstream.status).send(body);
  } catch (err) {
    console.error('Hp proxy error:', err?.message || err);
    return res.status(502).json({ error: 'Hp service unreachable.' });
  }
});

// ---------- WRESTLING MOVES API PROXY ----------
// The /get-move slash command looks up moves in the SlamDB pro wrestling
// move database (default: https://wrestling-moves-production.up.railway.app,
// API docs: GET /api/moves, GET /api/moves?limit=&offset=&q= and
// GET /api/moves/:slug). That API does not send CORS headers, so the
// browser calls this proxy instead of the moves server directly.
// MOVES_API_URL overrides the upstream base URL (tests / staging).
const MOVES_API_URL = (process.env.MOVES_API_URL || 'https://wrestling-moves-production.up.railway.app').trim().replace(/\/+$/, '');
const MOVES_PROXY_TIMEOUT_MS = 8 * 1000;

// "Stone Cold Stunner" → "stone-cold-stunner" (SlamDB slugs).
function movesSlugify(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function movesFetch(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MOVES_PROXY_TIMEOUT_MS);
  return fetch(`${MOVES_API_URL}${path}`, { signal: controller.signal })
    .then(upstream => {
      clearTimeout(timer);
      return upstream.json().catch(() => null)
        .then(data => ({ status: upstream.status, data }));
    }, err => {
      clearTimeout(timer);
      throw err;
    });
}

// A random move: read the total count, then page to one random offset.
async function movesRandomMove() {
  const first = await movesFetch('/api/moves?limit=1');
  const count = first.data && typeof first.data.count === 'number' ? first.data.count : 0;
  if (first.status !== 200 || !count) return null;
  const offset = Math.floor(Math.random() * count);
  const picked = await movesFetch(`/api/moves?limit=1&offset=${offset}`);
  const list = picked.data && picked.data.moves;
  return (picked.status === 200 && Array.isArray(list) && list.length) ? list[0] : null;
}

// The full move list: page through /api/moves (limit/offset) until every
// move has been collected.
async function movesListAll() {
  const all = [];
  const pageSize = 100;
  let offset = 0;
  while (true) {
    const page = await movesFetch(`/api/moves?limit=${pageSize}&offset=${offset}`);
    const data = page.data;
    if (page.status !== 200 || !data || !Array.isArray(data.moves)) break;
    all.push(...data.moves);
    const count = (typeof data.count === 'number') ? data.count : all.length;
    offset += pageSize;
    if (!data.moves.length || all.length >= count || data.moves.length < pageSize) break;
  }
  return all;
}

// A named move: exact slug lookup first (the upstream get-move endpoint is
// slug-only), then the API's ?q= search (first = best match).
async function movesNamedMove(name) {
  const slug = movesSlugify(name);
  if (slug) {
    const bySlug = await movesFetch(`/api/moves/${encodeURIComponent(slug)}`);
    if (bySlug.status === 200 && bySlug.data && bySlug.data.move) return bySlug.data.move;
  }
  const bySearch = await movesFetch(`/api/moves?q=${encodeURIComponent(name)}`);
  const list = bySearch.data && bySearch.data.moves;
  if (bySearch.status === 200 && Array.isArray(list) && list.length) return list[0];
  return null;
}

// GET /api/get-move?move=<name|slug>  → { move } (exact slug, then search)
// GET /api/get-move?move=random       → { move } (a random move)
// GET /api/get-move (no move param)   → { moves, count } (the full list)
app.get('/api/get-move', async (req, res) => {
  const query = String(req.query.move || '').trim();
  try {
    if (!query) {
      const moves = await movesListAll();
      if (!moves.length) {
        return res.status(404).json({ error: 'No moves available.' });
      }
      return res.json({ moves, count: moves.length });
    }
    const move = (query.toLowerCase() === 'random')
      ? await movesRandomMove()
      : await movesNamedMove(query);
    if (!move) {
      return res.status(404).json({
        error: query ? `No move found for "${query}".` : 'No moves available.'
      });
    }
    return res.json({ move });
  } catch (err) {
    console.error('Moves proxy error:', err?.message || err);
    return res.status(502).json({ error: 'Wrestling moves service unreachable.' });
  }
});

// ---------- EMBEDDED HP DICE ENGINE ----------
// In-process fallback for /api/hp/* when HP_API_URL is not set. The match
// commands (/create-game, /join-game, /move, /game-state, /end-game,
// /end-all-games) need game state that is shared between every player, so
// it lives here on the server instead of in each browser's localStorage.
//
// The math is a 1:1 port of CyberFights/Hp (stateless actions from
// server.js, stateful game flow from server2.js) with identical
// request/response shapes, so the chat client works unchanged. One
// deliberate deviation: a room whose last match has ended can host a new
// match (the Hp service blocks such rooms with "Room already exists."
// forever; the client's local engine — and players — expect the room to
// be reusable once the match is over).
const hpGames = new Map();

function hpRollDice(sides) {
  const n = (typeof sides === 'number' && sides >= 2) ? Math.floor(sides) : 6;
  return Math.floor(Math.random() * n) + 1;
}
function hpDiceSides(sides) {
  return (typeof sides === 'number' && sides >= 2) ? Math.floor(sides) : 6;
}
function hpClamp(value, min, max) { return Math.min(Math.max(value, min), max); }
// Damage for a landed blow: floor((roll*atk - def)/scale), floored at
// MIN_DAMAGE (a landed hit always chips at least 1) and capped at DAMAGE_CAP.
function hpDamage(raw, scale, cap, min) {
  return hpClamp(Math.floor(raw / scale), min, cap);
}
function hpIsNumber(v) { return typeof v === 'number' && isFinite(v); }
function hpPinAllowedRolls(currentHealth, maxHealth) {
  const hpPct = maxHealth > 0 ? (currentHealth / maxHealth) * 100 : 0;
  if (hpPct > 75) return [1, 2, 3, 4, 5, 6];
  if (hpPct > 50) return [1, 2, 3, 4, 5];
  if (hpPct > 25) return [1, 2, 3, 4];
  return [1, 6];
}
function hpCreatePlayerState() {
  return { health: 100, stamina: 100, attraction: 0, atkMultiplier: 1, defMultiplier: 1 };
}
function hpGameView(game) {
  return { id: game.id, players: Array.from(game.players), state: game.state, outcome: game.state.outcome };
}

// Port of CyberFights/Hp server2.js resolveMove().
//
// Damage uses the fighters' saved physique stats (userData), like the
// client's local engine: the actor's raw ATK (height (m) × √weight (kg))
// against the defender's raw DEF (weight (kg) / height (m)). The legacy-
// magnitude multipliers (atkMultiplier / defMultiplier) are only used for
// the non-damage lines (submission recoil, teasing).
async function hpResolveMove(game, playerId, payload) {
  if (game.state.finished) return { success: false, error: 'Match is already finished.' };
  if (!game.players.has(playerId)) return { success: false, error: 'Player is not in this game.' };

  const playerIds = Array.from(game.players);
  if (playerIds.indexOf(playerId) !== game.state.turnIndex % playerIds.length) {
    return { success: false, error: 'Not your turn.' };
  }

  const playerIndex = playerIds.indexOf(playerId);
  const selfKey = playerIndex === 0 ? 'p1' : 'p2';
  const oppKey = playerIndex === 0 ? 'p2' : 'p1';
  const self = game.state[selfKey];
  const opp = game.state[oppKey];

  const moveType = payload.moveType;
  const needsRecover = self.health < 5 || self.stamina < 5;
  if (needsRecover && moveType !== 'recover') {
    return { success: false, error: 'HP or stamina is below 5 — use /move recover.' };
  }
  if (!needsRecover && moveType === 'recover') {
    return { success: false, error: 'Recover is only available when HP or stamina is below 5.' };
  }

  // Resolve both fighters' stats from their user data so damage is the
  // actor's ATK against the opponent's DEF (stat-less fighters fight as
  // the baseline 5'11" / 185 lb fighter).
  const oppId = playerIds.find(id => id !== playerId) || null;
  const selfStats = await hpPlayerStats(playerId);
  const oppStats = oppId ? await hpPlayerStats(oppId) : selfStats;
  const atk = selfStats.atk;            // actor's raw ATK
  const def = oppStats.def;             // opponent's raw DEF
  const selfAtkMul = selfStats.atkMultiplier;
  const selfDefMul = selfStats.defMultiplier;
  const damageScale = physique.DAMAGE_SCALE > 0 ? physique.DAMAGE_SCALE : 1;

  const result = {
    playerId, playerIndex, moveType,
    // atk / def echo the stats used for this move so the chat line's
    // "(ATK x vs DEF y)" shows real values (the client formatter reads
    // these fields; the client's local engine sets the same pair).
    atk: atk, def: def,
    atkMultiplier: selfAtkMul, defMultiplier: selfDefMul,
    attackRoll: null, submissionRoll: null, selfDamageRoll: null,
    escapeRoll: null, teasingRoll: null, pinRoll: null,
    escaped: false, pinEscaped: false,
    damageDealt: 0, selfDamage: 0, staminaGained: 0, recoveryRolls: null,
    updatedHealth: self.health, updatedStamina: self.stamina, updatedAttraction: self.attraction,
    won: false, lost: false, tie: false, ko: false
  };

  if (moveType === 'attack') {
    const roll = hpRollDice();
    result.attackRoll = roll;
    const staminaCost = Math.floor(roll / 2);
    const damage = hpDamage(roll * atk - def, damageScale, physique.DAMAGE_CAP, physique.MIN_DAMAGE);
    result.damageDealt = damage;
    self.stamina = hpClamp(self.stamina - staminaCost, 0, 100);
    opp.health = hpClamp(opp.health - damage, 0, 100);
  }

  if (moveType === 'submission') {
    const submissionRoll = hpRollDice();
    const selfDamageRoll = hpRollDice();
    result.submissionRoll = submissionRoll;
    result.selfDamageRoll = selfDamageRoll;
    const staminaCost = Math.floor(submissionRoll / 2);
    const damage = hpDamage(submissionRoll * atk - def, damageScale, physique.DAMAGE_CAP, physique.MIN_DAMAGE);
    const selfDamage = Math.max(0, Math.floor(selfDamageRoll * selfDefMul));
    result.damageDealt = damage;
    result.selfDamage = selfDamage;
    self.stamina = hpClamp(self.stamina - staminaCost, 0, 100);
    opp.health = hpClamp(opp.health - damage, 0, 100);
    opp.attraction = hpClamp(opp.attraction + damage, 0, 100);
    self.health = hpClamp(self.health - selfDamage, 0, 100);
  }

  if (moveType === 'escape') {
    const escapeRoll = hpRollDice();
    result.escapeRoll = escapeRoll;
    result.escaped = escapeRoll % 2 === 0;
    const staminaCost = Math.floor(escapeRoll / 2);
    self.stamina = hpClamp(self.stamina - staminaCost, 0, 100);
    if (result.escaped) {
      const attackRoll = hpRollDice();
      result.attackRoll = attackRoll;
      const damage = hpDamage(attackRoll * atk - def, damageScale, physique.DAMAGE_CAP, physique.MIN_DAMAGE);
      result.damageDealt = damage;
      opp.health = hpClamp(opp.health - damage, 0, 100);
    }
  }

  if (moveType === 'teasing') {
    const teasingRoll = hpRollDice();
    result.teasingRoll = teasingRoll;
    const staminaCost = Math.floor(teasingRoll / 2);
    const attractionGain = Math.max(0, Math.floor(teasingRoll * selfAtkMul));
    self.stamina = hpClamp(self.stamina - staminaCost, 0, 100);
    opp.attraction = hpClamp(opp.attraction + attractionGain, 0, 100);
  }

  if (moveType === 'pin') {
    const pinRoll = hpRollDice();
    result.pinRoll = pinRoll;
    result.pinEscaped = hpPinAllowedRolls(self.health, 20).indexOf(pinRoll) !== -1;
  }

  if (moveType === 'recover') {
    const rolls = [hpRollDice(), hpRollDice(), hpRollDice(), hpRollDice()];
    const recoveryTotal = rolls.reduce((sum, r) => sum + r, 0);
    result.recoveryRolls = rolls;
    result.staminaGained = recoveryTotal;
    self.health = hpClamp(self.health + recoveryTotal, 0, 100);
    self.stamina = hpClamp(self.stamina + recoveryTotal, 0, 100);
  }

  self.health = hpClamp(self.health, 0, 100);
  self.stamina = hpClamp(self.stamina, 0, 100);
  self.attraction = hpClamp(self.attraction, 0, 100);
  opp.health = hpClamp(opp.health, 0, 100);
  opp.stamina = hpClamp(opp.stamina, 0, 100);
  opp.attraction = hpClamp(opp.attraction, 0, 100);

  result.updatedHealth = self.health;
  result.updatedStamina = self.stamina;
  result.updatedAttraction = self.attraction;

  const won = opp.health <= 0;
  const lost = self.health <= 0;
  const tie = self.health <= 0 && opp.health <= 0;

  result.won = won;
  result.lost = lost;
  result.tie = tie;
  result.ko = tie;

  if (moveType === 'pin' && !result.pinEscaped) {
    game.state.hold = { type: 'pin', holder: playerId, victim: oppId };
  } else if (moveType === 'submission') {
    game.state.hold = { type: 'submission', holder: playerId, victim: oppId };
  } else if (moveType === 'escape' && result.escaped) {
    game.state.hold = null;
  } else if (moveType === 'attack' || moveType === 'teasing' || (moveType === 'pin' && result.pinEscaped)) {
    game.state.hold = null;
  }

  if (tie) {
    game.state.finished = true; game.state.outcome = 'tie'; game.state.winner = null; game.state.hold = null;
  } else if (won) {
    game.state.finished = true; game.state.outcome = 'win'; game.state.winner = playerId; game.state.hold = null;
  } else if (lost) {
    game.state.finished = true; game.state.outcome = 'loss';
    game.state.winner = oppId;
    game.state.hold = null;
  }
  if (game.state.finished) game.finishedAt = Date.now();

  game.state.turnIndex = (game.state.turnIndex + 1) % playerIds.length;

  return { success: true, result, game: hpGameView(game) };
}

// Port of CyberFights/Hp server.js stateless actions + server2.js game
// endpoints. Returns { status, body } for the /api/hp/:action route.
async function hpEmbeddedAction(action, body) {
  body = body || {};
  switch (action) {
    case 'roll': {
      if (![body.atk, body.def, body.health, body.stamina].every(hpIsNumber)) {
        return { status: 400, body: { error: 'atk, def, health, and stamina must be numbers' } };
      }
      const sides = hpDiceSides(body.sides);
      const roll = hpRollDice(sides);
      const effectiveAttack = Math.max(body.atk - body.def, 0);
      const damage = hpClamp(roll * effectiveAttack, 0, 18);
      const staminaLoss = Math.floor(roll - 1);
      return {
        status: 200,
        body: {
          roll, sides, atk: body.atk, def: body.def, effectiveAttack, damage,
          healthBefore: body.health, healthAfter: Math.max(body.health - damage, 0),
          staminaBefore: body.stamina, staminaLoss, staminaAfter: Math.max(body.stamina - staminaLoss)
        }
      };
    }

    case 'submit': {
      if (![body.atk, body.def, body.health, body.stamina].every(hpIsNumber)) {
        return { status: 400, body: { error: 'atk, def, health, and stamina must be numbers' } };
      }
      const sides = hpDiceSides(body.sides);
      const rollTarget = hpRollDice(sides);
      const rollSelf = hpRollDice(sides);
      const effectiveAttack = Math.max(body.atk - body.def, 0);
      const damageToTarget = hpClamp(rollTarget * effectiveAttack, 0, 18);
      const damageToSelf = hpClamp(rollSelf * effectiveAttack, 0, 18);
      const staminaLoss = Math.floor(rollTarget - 1);
      const healthBeforeAttacker = hpIsNumber(body.attackerHealth) ? body.attackerHealth : body.health;
      return {
        status: 200,
        body: {
          rollTarget, rollSelf, sides, atk: body.atk, def: body.def, effectiveAttack,
          damageToTarget, healthBeforeTarget: body.health, healthAfterTarget: Math.max(body.health - damageToTarget),
          damageToSelf, healthBeforeAttacker, healthAfterAttacker: Math.max(healthBeforeAttacker - damageToSelf),
          staminaBefore: body.stamina, staminaLoss, staminaAfter: Math.max(body.stamina - staminaLoss)
        }
      };
    }

    case 'escape': {
      if (![body.atk, body.def, body.health, body.stamina, body.opponentHealth].every(hpIsNumber)) {
        return { status: 400, body: { error: 'atk, def, health, stamina, and opponentHealth must be numbers' } };
      }
      const sides = hpDiceSides(body.sides);
      const maxOppHealth = (hpIsNumber(body.opponentMaxHealth) && body.opponentMaxHealth > 0) ? body.opponentMaxHealth : 100;
      const baseChance = (hpIsNumber(body.baseEscapeChance) && body.baseEscapeChance >= 0 && body.baseEscapeChance <= 1) ? body.baseEscapeChance : 0.8;
      const healthFraction = Math.max(0, Math.min(1, body.health / maxOppHealth));
      const escapeChance = baseChance * healthFraction;
      const escapeRoll = Math.random();
      const escapeSuccess = escapeRoll < escapeChance;
      const effectiveAttack = Math.max(body.atk - body.def, 0);
      let attackRoll = null;
      let damageToOpponent = 0;
      let opponentHealthAfter = body.opponentHealth;
      let staminaLoss = 0;
      let staminaAfter = body.stamina;
      if (escapeSuccess) {
        attackRoll = hpRollDice(sides);
        damageToOpponent = hpClamp(attackRoll * effectiveAttack, 0, 18);
        opponentHealthAfter = Math.max(body.opponentHealth - damageToOpponent);
        staminaLoss = Math.floor(attackRoll - 1);
        staminaAfter = Math.max(body.stamina - staminaLoss);
      }
      return {
        status: 200,
        body: {
          atk: body.atk, def: body.def, effectiveAttack, health: body.health, opponentMaxHealth: maxOppHealth,
          opponentHealthBefore: body.opponentHealth, opponentHealthAfter, sides,
          baseEscapeChance: baseChance, healthFraction, escapeChance, escapeRoll, escapeSuccess,
          attackRoll, damageToOpponent, staminaBefore: body.stamina, staminaLoss, staminaAfter
        }
      };
    }

    case 'pin-escape': {
      if (![body.health, body.stamina, body.opponentHealth].every(hpIsNumber)) {
        return { status: 400, body: { error: 'health, stamina, and opponentHealth must be numbers' } };
      }
      const sides = hpDiceSides(body.sides);
      const maxOppHealth = (hpIsNumber(body.opponentMaxHealth) && body.opponentMaxHealth > 0) ? body.opponentMaxHealth : 100;
      const baseChance = (hpIsNumber(body.baseEscapeChance) && body.baseEscapeChance >= 0 && body.baseEscapeChance <= 1) ? body.baseEscapeChance : 0.8;
      const healthFraction = Math.max(0, Math.min(1, body.health / maxOppHealth));
      const escapeChancePerRoll = baseChance * healthFraction;
      const rolls = [];
      let anySuccess = false;
      for (let i = 0; i < 3; i++) {
        const rollValue = Math.random();
        const success = rollValue < escapeChancePerRoll;
        rolls.push({ rollValue, success });
        if (success) anySuccess = true;
      }
      return {
        status: 200,
        body: {
          health: body.health, opponentMaxHealth: maxOppHealth,
          opponentHealthBefore: body.opponentHealth, opponentHealthAfter: body.opponentHealth,
          sides, baseEscapeChance: baseChance, healthFraction, escapeChancePerRoll,
          rolls, escapeSuccess: anySuccess
        }
      };
    }

    case 'tease': {
      if (![body.atk, body.def, body.stamina, body.opponentAttraction].every(hpIsNumber)) {
        return { status: 400, body: { error: 'atk, def, stamina, and opponentAttraction must be numbers' } };
      }
      const sides = hpDiceSides(body.sides);
      const maxAttraction = (hpIsNumber(body.opponentMaxAttraction) && body.opponentMaxAttraction > 0) ? body.opponentMaxAttraction : null;
      const roll = hpRollDice(sides);
      const effectiveAttack = Math.max(body.atk - body.def, 0);
      const attractionIncrease = hpClamp(roll * effectiveAttack, 0, 18);
      let attractionAfter = body.opponentAttraction + attractionIncrease;
      if (maxAttraction !== null) attractionAfter = Math.min(attractionAfter, maxAttraction);
      attractionAfter = Math.max(attractionAfter);
      const staminaLoss = Math.floor(roll - 1);
      return {
        status: 200,
        body: {
          roll, sides, atk: body.atk, def: body.def, effectiveAttack,
          attractionIncrease, attractionBefore: body.opponentAttraction, attractionAfter,
          opponentMaxAttraction: maxAttraction, staminaBefore: body.stamina, staminaLoss,
          staminaAfter: Math.max(body.stamina - staminaLoss)
        }
      };
    }

    case 'recover': {
      if (![body.health, body.stamina].every(hpIsNumber)) {
        return { status: 400, body: { error: 'health and stamina must be numbers' } };
      }
      const sides = hpDiceSides(body.sides);
      const rolls = [hpRollDice(sides), hpRollDice(sides), hpRollDice(sides), hpRollDice(sides)];
      const recoveryTotal = rolls.reduce((sum, r) => sum + r, 0);
      const healthCap = (hpIsNumber(body.maxHealth) && body.maxHealth > 0) ? body.maxHealth : null;
      const staminaCap = (hpIsNumber(body.maxStamina) && body.maxStamina > 0) ? body.maxStamina : null;
      const healthAfter = healthCap !== null
        ? hpClamp(body.health + recoveryTotal, 0, healthCap)
        : Math.max(body.health + recoveryTotal, 0);
      const staminaAfter = staminaCap !== null
        ? hpClamp(body.stamina + recoveryTotal, 0, staminaCap)
        : Math.max(body.stamina + recoveryTotal, 0);
      return {
        status: 200,
        body: {
          rolls, sides, recoveryTotal,
          healthBefore: body.health, healthAfter,
          staminaBefore: body.stamina, staminaAfter,
          maxHealth: healthCap, maxStamina: staminaCap
        }
      };
    }

    case 'create-game': {
      const roomId = body.roomId ? String(body.roomId) : null;
      if (!roomId) return { status: 400, body: { error: 'Missing roomId.' } };
      const existing = hpGames.get(roomId);
      // A room with a still-running match cannot start a new one, but once
      // the previous match has ended the room is free to play again.
      if (existing && !existing.state.finished) {
        return { status: 400, body: { error: 'Room already exists.' } };
      }
      const game = {
        id: roomId,
        players: new Set(),
        state: {
          turnIndex: 0, finished: false, winner: null, outcome: null, hold: null,
          p1: hpCreatePlayerState(), p2: hpCreatePlayerState()
        }
      };
      hpGames.set(roomId, game);
      return { status: 200, body: { gameId: game.id } };
    }

    case 'join-game': {
      const game = hpGames.get(String(body.roomId || ''));
      if (!game) return { status: 404, body: { error: 'Room not found.' } };
      if (game.state.finished) return { status: 400, body: { error: 'The game is already finished.' } };
      if (game.players.size >= 2) return { status: 400, body: { error: 'Room is full.' } };
      game.players.add(body.playerId);
      return { status: 200, body: { success: true, gameId: game.id, players: Array.from(game.players) } };
    }

    case 'dice-match': {
      const game = hpGames.get(String(body.roomId || ''));
      if (!game) return { status: 404, body: { error: 'Game not found.' } };
      const outcome = await hpResolveMove(game, body.playerId, body);
      if (!outcome.success) return { status: 400, body: { success: false, error: outcome.error } };

      // The move decided the match: record it once (the flag keeps a second
      // finishing move — a race between two tabs — from double-counting) and
      // move both fighters' W/L counters. See recordEngineMatch for why only
      // engine-decided finishes are recorded.
      if (game.state.finished && !game.recorded) {
        game.recorded = true;
        recordEngineMatch(game, outcome.result);
      } else if (!game.state.finished) {
        // The turn passed: whoever moves next gets a nudge (a push too, if
        // they are not sitting on a live session).
        const playerIds = Array.from(game.players);
        if (playerIds.length === 2) {
          notifyMatchTurn(playerIds[game.state.turnIndex % playerIds.length], body.playerId);
        }
      }

      return { status: 200, body: { result: outcome.result, game: hpGameView(game) } };
    }

    case 'game-state': {
      const game = hpGames.get(String(body.roomId || ''));
      if (!game) return { status: 404, body: { error: 'Game not found.' } };
      return { status: 200, body: hpGameView(game) };
    }

    case 'end-game': {
      const game = hpGames.get(String(body.roomId || ''));
      if (!game) return { status: 404, body: { error: 'Game not found.' } };
      if (game.state.finished) return { status: 400, body: { error: 'The game is already finished.' } };
      game.state.finished = true;
      game.state.winner = body.winner || null;
      game.state.outcome = body.outcome || 'manually ended';
      game.finishedAt = Date.now();
      return { status: 200, body: { success: true, message: 'The game has been manually ended.', state: game.state } };
    }

    case 'end-all-games': {
      let endedGamesCount = 0;
      hpGames.forEach((game) => {
        if (!game.state.finished) {
          game.state.finished = true;
          game.state.winner = null;
          game.state.outcome = body.outcome || 'manually ended';
          game.finishedAt = Date.now();
          endedGamesCount++;
        }
      });
      return { status: 200, body: { success: true, message: 'All active games have been manually ended.', endedGamesCount } };
    }

    default:
      return { status: 404, body: { error: 'Unknown Hp action.' } };
  }
}

// Finished matches linger so late /game-state polls can still show the
// final result, then get swept so the map does not grow forever.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  hpGames.forEach((game, id) => {
    if (game.state.finished && game.finishedAt && game.finishedAt < cutoff) hpGames.delete(id);
  });
}, 10 * 60 * 1000);

// ---------- IMAGE PROXY ----------
// Remote image hosts (ImgBB / Discord CDN) sit behind Cloudflare and sometimes
// answer a hotlinked <img> request with an HTML challenge/error page or a
// redirect instead of image bytes. Firefox then refuses the response with
// "A resource is blocked by OpaqueResponseBlocking" (ORB blocks cross-origin
// no-cors responses whose body/Content-Type is not actually an image), and the
// Cloudflare "__cf_bm" cookie is rejected for an invalid domain along the way.
//
// Serving those images through our own origin fixes both: the browser sees a
// same-origin response with a guaranteed image/* Content-Type, so ORB never
// applies and no third-party cookie is involved.
const IMAGE_PROXY_HOSTS = new Set([
  'ibb.co',
  'i.ibb.co',
  'image.ibb.co',
  'cdn.discordapp.com',
  'media.discordapp.net'
]);

const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/svg+xml'
]);

// 1x1 transparent PNG, returned (with an image content type) when the upstream
// image cannot be fetched so the browser never receives an opaque/HTML body.
const TRANSPARENT_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function isProxyableImageHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return IMAGE_PROXY_HOSTS.has(host) || host.endsWith('.ibb.co');
}

function parseProxyTarget(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (url.protocol !== 'https:') return null;
    if (!isProxyableImageHost(url.hostname)) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function sendPlaceholderImage(res, status) {
  if (res.headersSent) return;
  res.status(status);
  res.set({
    'Content-Type': 'image/png',
    'Content-Length': String(TRANSPARENT_PIXEL.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });
  res.end(TRANSPARENT_PIXEL);
}

const imageProxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/img', imageProxyLimiter, async (req, res) => {
  const target = parseProxyTarget(req.query.u || req.query.url);
  if (!target) return sendPlaceholderImage(res, 400);

  const controller = new AbortController();
  let abortReason = null;
  const abortUpstream = reason => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
  };
  const onRequestAborted = () => abortUpstream('client');
  const onResponseClosed = () => {
    if (!res.writableEnded) abortUpstream('client');
  };

  // Stop opening the upstream connection if its browser tab has gone away.
  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClosed);

  const timeout = setTimeout(() => abortUpstream('timeout'), IMAGE_PROXY_TIMEOUT_MS);
  // This timer should never be the only thing keeping a shutting-down process alive.
  if (typeof timeout.unref === 'function') timeout.unref();

  try {
    const upstream = await fetch(target.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some CDNs reject requests without a browser-ish UA / Accept header.
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
        'User-Agent': 'Mozilla/5.0 (compatible; MaleCyberFighters/1.0; +https://male-cyber-fighters.com)'
      }
    });

    const contentType = String(upstream.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (!upstream.ok || !ALLOWED_IMAGE_TYPES.has(contentType)) {
      // Upstream returned an HTML error / Cloudflare challenge — swallow it and
      // hand back a real image so nothing gets ORB-blocked in the client.
      console.warn('image proxy rejected upstream response', {
        url: target.href,
        status: upstream.status,
        contentType: contentType || 'unknown'
      });
      if (upstream.body && typeof upstream.body.resume === 'function') upstream.body.resume();
      return sendPlaceholderImage(res, 502);
    }

    const contentLength = Number(upstream.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_PROXIED_IMAGE_SIZE) {
      if (upstream.body && typeof upstream.body.resume === 'function') upstream.body.resume();
      return sendPlaceholderImage(res, 502);
    }

    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer'
    });
    if (contentLength) res.set('Content-Length', String(contentLength));

    let streamed = 0;
    upstream.body.on('data', chunk => {
      streamed += chunk.length;
      if (streamed > MAX_PROXIED_IMAGE_SIZE) {
        upstream.body.destroy();
        res.destroy();
      }
    });
    upstream.body.on('error', err => {
      console.error('image proxy stream error', err.message || err);
      if (!res.headersSent) sendPlaceholderImage(res, 502);
      else res.destroy();
    });

    upstream.body.pipe(res);
  } catch (err) {
    // node-fetch describes every AbortController cancellation as "The user
    // aborted a request", including our own timeout. Classify it here so an
    // expected slow/unreachable CDN is not reported as an application error.
    const isAbortError = err && (
      err.name === 'AbortError' || err.type === 'aborted' || err.code === 'ABORT_ERR'
    );

    if (abortReason === 'client' || res.destroyed) return;

    if (abortReason === 'timeout' && isAbortError) {
      console.warn('image proxy upstream timed out', {
        host: target.hostname,
        timeoutMs: IMAGE_PROXY_TIMEOUT_MS
      });
    } else {
      console.error('image proxy error', err.message || err);
    }
    sendPlaceholderImage(res, 502);
  } finally {
    clearTimeout(timeout);
    req.removeListener('aborted', onRequestAborted);
    res.removeListener('close', onResponseClosed);
  }
});

// ---------- GENERATED FALLBACK AVATARS ----------
// The Discord webhook uses these as the avatar for senders who have not
// uploaded a photo, so their messages in the Discord channel still carry the
// same identity as in the website chat: their initial on their profile
// color. Rendered on the fly as a small PNG (no image library involved), so
// it is also usable by any client that wants the same fallback look.
const avatarLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false
});
app.get('/avatar/:username', avatarLimiter, async (req, res) => {
  try {
    let username;
    try {
      username = decodeURIComponent(req.params.username || '');
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'invalid_username' });
    }
    username = username.replace(/\.png$/i, '').trim().slice(0, 64);
    if (!username) return res.status(400).json({ ok: false, error: 'missing_username' });

    const user = await User.findOne({ username })
      .select('username display color')
      .lean();

    const png = renderInitialsAvatarPng(
      avatarInitial(user?.display, user?.username || username),
      user?.color
    );

    res.set({
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.send(png);
  } catch (err) {
    console.error('avatar render error', err.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

const publicDir = path.join(__dirname, 'public');
const noCacheStatic = {
  setHeaders(res) {
    res.set('Cache-Control', 'no-cache');
  }
};
// User-uploaded clips (GIFs / short videos). Filenames are random hex, so a
// 7-day immutable cache is safe. express.static supports Range requests,
// which <video> players use for seeking.
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/clips', express.static(UPLOADS_DIR, { maxAge: '7d', immutable: true }));

app.use('/js', express.static(path.join(publicDir, 'js'), noCacheStatic));
app.use('/css', express.static(path.join(publicDir, 'css'), noCacheStatic));

// ---------- BUILT ASSETS ----------
// Output of `npm run build` (see build.js): minified, content-hashed bundles.
// The hash in the filename is the cache key, so these are the only assets on
// the site that can be cached permanently — a changed file arrives under a new
// URL rather than replacing one a browser already holds. When the build did not
// run this directory does not exist and the route simply never matches.
app.use('/dist', express.static(assets.DIST_DIR, {
  maxAge: assets.IMMUTABLE_MAX_AGE,
  immutable: true,
  index: false,
  dotfiles: 'ignore'
}));

// Pages whose script run the build replaced with a single bundle. Served ahead
// of express.static so the rewritten copy wins; assets.pageFile falls back to
// the hand-written page in public/ when there is no build output.
const BUILT_PAGES = ['mobile.html', 'mobile2.html', 'reset-password.html', 'guide.html', 'offline.html', 'landing.html'];
app.get(BUILT_PAGES.map(name => `/${name}`), (req, res, next) => {
  const name = req.path.replace(/^\/+/, '');
  if (!BUILT_PAGES.includes(name)) return next();

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(assets.pageFile(name), err => { if (err) next(err); });
});

// /index.html is the same document as "/" but without the desktop/mobile
// stylesheet swap, so point it at the canonical URL instead of serving a
// second, differently-cached copy of the app shell.
app.get('/index.html', (req, res) => res.redirect(301, '/'));

app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(publicDir, 'sw.js'));
});
app.use(express.static(publicDir));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// Uploads write to a third party (ImgBB) or to this server's disk, and the clip
// store has a hard 2 GB cap, so they are throttled separately and more tightly
// than ordinary reads. Both also require a session now, which is what makes the
// limit attributable.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/upload-image', uploadLimiter);
app.use('/api/upload-clip', uploadLimiter);
app.use('/api/profile/photos', uploadLimiter);
app.use(cors({ origin: true, credentials: true }));
// Request client hints so modern browsers will include Sec-CH-UA-Mobile on subsequent navigations.
// This improves server-side mobile detection without relying solely on User-Agent sniffing.
app.use((req, res, next) => {
  res.set('Accept-CH', 'Sec-CH-UA-Mobile');
  next();
});

// ---------- DB ----------
// serverSelectionTimeoutMS / bufferTimeoutMS: without a reachable Mongo,
// DB-backed endpoints should answer fast with an error instead of hanging
// on the driver's defaults (30 s server-selection, 10 s per buffered
// operation — a handler doing several queries in sequence could stall for
// 20+ s). Both timers only apply while the connection is not ready, so a
// healthy Mongo is unaffected.
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, bufferTimeoutMS: 5000 })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.warn('MongoDB connection failed (continuing without DB):', err.message || err));

// ---------- PHYSIQUE HELPERS (height / weight) ----------
// Fighter physique is captured during registration and can be edited from the
// profile modal. Height is stored as a feet + inches display string so it can
// be rendered straight from the database (e.g. 5'11"); the menu runs from
// 3'5" (41 inches) up to 8'0" (96 inches) in one-inch steps. Weight is always
// stored as whole pounds (lbs).
// The rules live in public/js/physique.js so the browser menus and the API
// validation can never drift apart.
const physique = require('./public/js/physique.js');
const {
  HEIGHT_MIN_INCHES,
  HEIGHT_MAX_INCHES,
  WEIGHT_MIN_LBS,
  WEIGHT_MAX_LBS,
  inchesToHeight: inchesToHeightString,
  normalizeHeight,
  normalizeWeight
} = physique;

// ---------- TAG HELPERS (wrestling style / fetish / heel-jobber-face / position) ----------
// Members tag themselves in four categories from registration or the profile
// editor, and the roster can then be searched by tag ("heel", "singlet",
// "vers"). The catalogue, the per-category caps and the search rules live in
// public/js/tags.js so the pickers the browser renders and the values the API
// stores can never drift apart.
const tags = require('./public/js/tags.js');

/**
 * The tag selection to store, from a request body. `undefined` (the field was
 * not sent at all — every pre-tags client) clears the selection.
 *
 * A shape that is not a selection (a string, a category that is not a list) is
 * rejected so a broken client is caught; unknown tag ids are dropped instead,
 * so a member whose page still lists a retired tag can still save their
 * profile rather than being stuck behind a 400.
 */
function readTagSelection(value) {
  const normalized = tags.normalize(value);
  if (!normalized.ok) return normalized;
  return { ok: true, tags: normalized.tags };
}

// A user document's tags, always the full four-category shape — accounts
// created before this existed (and any document edited by hand) read as empty
// rather than `undefined`.
function userTags(user) {
  return tags.selection(user && user.tags);
}

// ---------- SCHEMAS ----------
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, index: true },
  email:    { type: String, unique: true, required: true, index: true },
  passwordHash: { type: String, required: true },
  display:  { type: String },
  age:      { type: Number },
  // Fighter physique: height is a feet + inches string (5'11"), weight is lbs.
  height: {
    type: String,
    trim: true,
    default: undefined,
    validate: {
      validator: v => v == null || v === '' || normalizeHeight(v) !== '',
      message: `Height must be between ${inchesToHeightString(HEIGHT_MIN_INCHES)} and ${inchesToHeightString(HEIGHT_MAX_INCHES)}`
    }
  },
  weight: {
    type: Number,
    default: undefined,
    min: [WEIGHT_MIN_LBS, `Weight must be at least ${WEIGHT_MIN_LBS} lbs`],
    max: [WEIGHT_MAX_LBS, `Weight must be at most ${WEIGHT_MAX_LBS} lbs`]
  },
  // Combat stats derived from the physique above (physique.combatStats):
  //   atk = height (m) × √weight (kg)
  //   def = weight (kg) / height (m)
  // Saved here ("userData") whenever the physique is registered or updated,
  // and pulled by /api/combat-stats for the dice match calculations.
  // Both stay null until the user has a complete physique.
  atk: { type: Number, default: null },
  def: { type: Number, default: null },
  stats:    { type: Object, default: {} },
  info:     { type: String },
  color:    { type: String },
  language: { type: String },
  imageUrl: { type: String },
  // ImgBB URLs for the additional photos shown in the user's profile gallery.
  // The image bytes stay on ImgBB; MongoDB only stores the durable URLs.
  extraPhotos: {
    type: [{
      type: String,
      validate: {
        validator: isImgBBUrl,
        message: 'Extra profile photos must be HTTPS ImgBB URLs'
      }
    }],
    default: [],
    validate: {
      validator: photos => photos.length <= MAX_EXTRA_PROFILE_PHOTOS,
      message: `A profile can contain at most ${MAX_EXTRA_PROFILE_PHOTOS} extra photos`
    }
  },
  discordId: { type: String, default: null },
  // Fighter tags: four arrays of catalogue ids (see public/js/tags.js).
  // Stored as ids, not labels, so a tag can be renamed without rewriting
  // every user document. The validator only guards documents written outside
  // the API — /api/register and /api/update-profile normalise first.
  tags: {
    type: new mongoose.Schema({
      style: { type: [String], default: [] },
      fetish: { type: [String], default: [] },
      role: { type: [String], default: [] },
      position: { type: [String], default: [] }
    }, { _id: false }),
    default: () => ({})
  },
  blockedUsers: { type: [String], default: [] },
  // ---------- MATCH RECORD ----------
  // Wins / losses used to be two numbers a member typed into their own
  // profile; they are now real counters moved only by the match-record flow
  // (engine-finished matches and opponent-confirmed logged matches), so the
  // numbers on a profile are backed by rows in the MatchRecord collection.
  wins: { type: Number, default: 0, min: 0 },
  losses: { type: Number, default: 0, min: 0 },
  // ---------- LFG (looking for a match) ----------
  // The member's own flag for the live LFG board — see lfg.js. Flipping it
  // off clears the styles and the note with it, so nothing stale lingers.
  lfg: {
    type: new mongoose.Schema({
      looking: { type: Boolean, default: false },
      styles: { type: [String], default: [] },
      note: { type: String, default: '' },
      updatedAt: { type: Date, default: Date.now }
    }, { _id: false }),
    default: () => ({})
  },
  // ---------- ACHIEVEMENTS ----------
  // Unlocked catalogue ids with their timestamps; anything the catalogue no
  // longer lists simply stops being displayed.
  achievements: {
    type: [{ _id: false, id: String, unlockedAt: Date }],
    default: []
  },
  // ---------- NOTIFICATION PREFERENCES ----------
  // Per-kind push switches + a quiet window; the shape and the defaults live
  // in notificationPrefs.js so this stays dumb storage.
  notificationPrefs: { type: Object, default: {} },
  quietHours: { type: Object, default: {} },
  // ---------- PRESENCE ----------
  // "Online" only exists while a socket is attached; lastSeenAt is what makes
  // "active 2h ago" possible on profile cards once the member is gone.
  lastSeenAt: { type: Date, default: Date.now },
  // Per-conversation DM read markers: { [partnerUsername]: ISO date string }.
  // The unread badge used to be purely client-side (localStorage, fed by live
  // socket events), so a DM that arrived while the recipient had no live
  // socket — the normal case for a message bridged in from Discord — was
  // stored but never badged. These markers let the server compute what is
  // still unread and send it on connect.
  dmSeen: { type: Object, default: {} },
  // Nothing older than this is counted as unread. Set at registration, and
  // backfilled the first time an existing account's counts are computed, so
  // shipping this does not badge every DM in the user's history.
  dmUnreadSince: { type: String, default: () => new Date().toISOString() },
  online:   { type: Boolean, default: false },
  socketId: { type: String, default: null },
  role:     { type: String, default: 'user' },
  banned:   { type: Boolean, default: false }
}, { timestamps: true });

const publicMessageSchema = new mongoose.Schema({
  from: String,
  display: String,
  text: String,
  imageUrl: String,
  // true once a message has been edited by its author
  edited: { type: Boolean, default: false },
  // optional quoted/replied-to message metadata
  replyTo: { type: Object, default: null },
  time: { type: Date, default: Date.now }
});

// Public history is "the newest N, oldest first" and room history is "this
// room, oldest first" — both need an index or they sort the whole collection.
publicMessageSchema.index({ time: -1 });

const roomMessageSchema = new mongoose.Schema({
  room: { type: String, required: true },
  from: String,
  display: String,
  text: String,
  imageUrl: String,
  // short video / GIF attached to the message (served from /clips)
  clipUrl: String,
  clipType: String, // "video" | "gif"
  edited: { type: Boolean, default: false },
  replyTo: { type: Object, default: null },
  time: { type: Date, default: Date.now }
});

const RoomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  private: { type: Boolean, default: false },
  owner: { type: String, required: true },
  invitedUsers: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now },
  // ---------- OWNER MODERATION ----------
  // The room owner's tools, all enforced server-side in the roomMessage /
  // joinRoom handlers: slow mode (minimum gap between one member's messages),
  // mutes (map of member key → ISO instant the mute ends) and the kick list
  // (a kicked member cannot rejoin until the owner reverses it).
  // Usernames may contain "." and "$", which Mongo field names may not, so
  // the map key is normalised the same way dmSeen keys are.
  slowModeMs: { type: Number, default: 0, min: 0, max: 60 * 1000 },
  muted: { type: Object, default: {} },
  kicked: { type: [String], default: [] }
});

// ---------- CHALLENGES / MATCH RECORD / REACTIONS / BOOKMARKS / REPORTS ----------
// One formal match offer between two members. See challenges.js for the flow.
const challengeSchema = new mongoose.Schema({
  from: { type: String, required: true, index: true },
  to: { type: String, required: true, index: true },
  status: { type: String, default: 'pending', index: true }, // pending|accepted|declined|cancelled
  styles: { type: [String], default: [] },
  terms: { type: [String], default: [] },
  bestOf: { type: Number, default: 1 },
  stakes: { type: String, default: '' },
  note: { type: String, default: '' },
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  rematchOf: { type: String, default: null },
  respondedAt: { type: Date }
}, { timestamps: true });
challengeSchema.index({ from: 1, to: 1, status: 1 });

// One recorded match. `status` is only meaningful for member-logged matches
// ('pending' until the named opponent confirms); engine matches are born
// 'confirmed'. See matchHistory.js.
const matchRecordSchema = new mongoose.Schema({
  winner: { type: String, index: true },
  loser: { type: String, index: true },
  draw: { type: Boolean, default: false },
  styles: { type: [String], default: [] },
  bestOf: { type: Number, default: 1 },
  source: { type: String, default: 'engine' }, // engine|logged
  status: { type: String, default: 'confirmed', index: true }, // confirmed|pending|declined
  reporter: { type: String, default: null },
  room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
  notes: { type: String, default: '' },
  // The winner's HP when the bell rang — feeds the Ironman achievement.
  closingHp: { type: Number, default: null },
  confirmedAt: { type: Date }
}, { timestamps: true });
matchRecordSchema.index({ winner: 1, loser: 1, createdAt: -1 });
matchRecordSchema.index({ status: 1, createdAt: -1 });

// One emoji from one member on one message. The compound unique index is the
// "one reaction per member per message" rule, enforced by the database.
const reactionSchema = new mongoose.Schema({
  scope: { type: String, required: true }, // public|room
  room: { type: String, default: '' },
  messageId: { type: String, required: true },
  username: { type: String, required: true },
  emoji: { type: String, required: true },
  time: { type: Date, default: Date.now }
});
reactionSchema.index({ scope: 1, room: 1, messageId: 1, username: 1 }, { unique: true });
reactionSchema.index({ time: 1 });

// A member's saved message. The snippet is copied at save time because the
// message itself will eventually be pruned by the retention sweep — the
// bookmark is the member's copy and is meant to outlive it.
const bookmarkSchema = new mongoose.Schema({
  username: { type: String, required: true, index: true },
  scope: { type: String, required: true }, // public|room
  room: { type: String, default: '' },
  messageId: { type: String, required: true },
  from: { type: String, default: '' },
  text: { type: String, default: '' },
  time: { type: Date, default: null }
}, { timestamps: true });
bookmarkSchema.index({ username: 1, createdAt: -1 });
// The same message saved twice by the same member is one bookmark.
bookmarkSchema.index({ username: 1, scope: 1, room: 1, messageId: 1 }, { unique: true });

// A moderation report. See reports.js — the snippet exists because chat
// history is pruned and evidence should not be.
const reportSchema = new mongoose.Schema({
  reporter: { type: String, required: true, index: true },
  kind: { type: String, default: 'user' }, // user|issue
  targetUser: { type: String, default: null, index: true },
  reason: { type: String, required: true },
  scope: { type: String, default: 'other' }, // public|room|dm|profile|forum|other
  room: { type: String, default: null },
  messageId: { type: String, default: null },
  snippet: { type: String, default: null },
  details: { type: String, default: '' },
  status: { type: String, default: 'open', index: true }, // open|resolved|dismissed
  resolution: { type: String, default: '' },
  resolvedAt: { type: Date }
}, { timestamps: true });
reportSchema.index({ status: 1, createdAt: -1 });

roomMessageSchema.index({ room: 1, time: 1 });
// The retention sweep prunes by age across every room at once, which the
// room-first index above cannot serve.
roomMessageSchema.index({ time: 1 });

// Forums and forum replies are kept in their own collections so a thread can
// be loaded independently from the forum list and responses remain tied to a
// specific forum document.
const forumSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },
  body: { type: String, required: true, trim: true, maxlength: 10000 },
  author: { type: String, required: true, index: true },
  authorDisplay: { type: String, required: true },
  lastActivityAt: { type: Date, default: Date.now }
}, { timestamps: true });
forumSchema.index({ lastActivityAt: -1, createdAt: -1 });

const forumReplySchema = new mongoose.Schema({
  forum: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Forum',
    required: true
  },
  body: { type: String, required: true, trim: true, maxlength: 5000 },
  author: { type: String, required: true, index: true },
  authorDisplay: { type: String, required: true }
}, { timestamps: true });
forumReplySchema.index({ forum: 1, createdAt: 1 });

const ipLogSchema = new mongoose.Schema({
  ip: String,
  username: String,
  action: String,
  userAgent: String,
  createdAt: { type: Date, default: Date.now }
});
// The most sensitive collection on the site (IP + user agent per auth attempt),
// and the one with the shortest retention window — the sweep needs this to find
// the old ones without walking the whole log.
ipLogSchema.index({ createdAt: 1 });

const dmSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },

  // text message (translated)
  text: { type: String },

  // original text (sender's language)
  originalText: { type: String, required: false },

  // image message
  imageUrl: { type: String },

  // short video / GIF message (served from our /clips route)
  clipUrl: { type: String },
  clipType: { type: String }, // "video" | "gif"

  relationshipId: { type: String },
  storyId: { type: String },
  // challenge / matchApproval system notices carry the id of the thing to act on
  challengeId: { type: String },
  matchId: { type: String },
  // system / approval / normal
  type: { type: String, default: "normal" },
  // values:
  // "normal"        → regular DM
  // "image"         → image DM
  // "clip"          → GIF / short video DM
  // "storyApproval" → approval request DM
  // "challenge"     → match challenge notice (challengeId)
  // "matchApproval" → logged-match confirmation (matchId)
  // "system"        → system notifications

  // true once the author has edited the text (see canEditDM for the window)
  edited: { type: Boolean, default: false },
  // a deletion tombstone: the row stays so both feeds agree a message existed,
  // but the content is gone for both sides
  deleted: { type: Boolean, default: false },

  // timestamp
  time: { type: Date, default: Date.now }
});

// Every DM query is an equality match on (from, to) ordered by time — the
// conversation history — or a scan of one side of it for the partner list.
// Without these the collection is walked on every DM window opened, and it
// only ever grows.
dmSchema.index({ from: 1, to: 1, time: -1 });
dmSchema.index({ to: 1, time: -1 });

const storySchema = new mongoose.Schema({
  owner: { type: String, required: true },
  partner: { type: String, required: true },
  title: { type: String, default: "" },
  story: { type: String, required: true },
  // optional GIF / short video played when the story is viewed
  clipUrl: { type: String },
  clipType: { type: String }, // "video" | "gif"

  approvalOwner: { type: Boolean, default: true },
  approvalPartner: { type: Boolean, default: false },

  approved: { type: Boolean, default: false },
  // Set the moment a story first becomes public (used for "published" dates).
  approvedAt: { type: Date },

  // Refusals. A declined story is never public and never pending: the author
  // sees it on their profile with the reason, and can revise and resubmit.
  declined: { type: Boolean, default: false },
  declinedBy: { type: String, default: "" },
  declineReason: { type: String, default: "" },

  // Bumped on every edit. Editing an approved story re-opens approval, so the
  // partner can see how many times the text changed since they approved it.
  revision: { type: Number, default: 0 },
  updatedAt: { type: Date },

  createdAt: { type: Date, default: Date.now }
});

const relationshipSchema = new mongoose.Schema({
  requester: { type: String, required: true },
  target: { type: String, required: true },

  type: { type: String, required: true }, 
  // rival, friend, opponent, tagteam, dating, married, sibling, parent, owner

  approvedRequester: { type: Boolean, default: true },
  approvedTarget: { type: Boolean, default: false },

  approved: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

const Relationship = mongoose.model("Relationship", relationshipSchema);
const Story = mongoose.model("Story", storySchema);
const DM = mongoose.model("DM", dmSchema);
const User = mongoose.model('User', userSchema);
const PublicMessage = mongoose.model("PublicMessage", publicMessageSchema);
const RoomMessage = mongoose.model("RoomMessage", roomMessageSchema);
const IpLog = mongoose.model('IpLog', ipLogSchema);
const Room = mongoose.model('Room', RoomSchema);
const Forum = mongoose.model('Forum', forumSchema);
const ForumReply = mongoose.model('ForumReply', forumReplySchema);
const Challenge = mongoose.model('Challenge', challengeSchema);
const MatchRecord = mongoose.model('MatchRecord', matchRecordSchema);
const Reaction = mongoose.model('Reaction', reactionSchema);
const Bookmark = mongoose.model('Bookmark', bookmarkSchema);
const Report = mongoose.model('Report', reportSchema);

// ---------- COMBAT STATS (shared dice-match resolver) ----------
// Single source of truth for a fighter's atk / def plus the same values
// scaled to the legacy engine magnitude. atk / def are deterministic
// functions of the stored physique, so they are recomputed (and persisted)
// whenever the stored values are missing or out of step with the current
// formula (e.g. after the def formula dropped its /2 factor) — no separate
// migration sweep is needed. Returns null when the fighter has no complete
// physique.
async function resolveCombatStats(user) {
  let atk = user.atk;
  let def = user.def;
  const computed = physique.combatStats(user.height, user.weight);
  if (computed && (atk == null || def == null || Number(atk) !== computed.atk || Number(def) !== computed.def)) {
    atk = computed.atk;
    def = computed.def;
    await User.updateOne({ _id: user._id }, { $set: { atk, def } }).catch(() => {});
  }
  if (atk == null || def == null) return null;
  return {
    atk: Number(atk),
    def: Number(def),
    atkMultiplier: physique.engineAtkMultiplier(Number(atk)),
    defMultiplier: physique.engineDefMultiplier(Number(def))
  };
}

// A fighter's combat stats by username, falling back to the baseline
// fighter (5'11" / 185 lb) when the account or its physique is missing.
async function hpPlayerStats(username) {
  const fallback = {
    atk: physique.baselineStats.atk,
    def: physique.baselineStats.def,
    atkMultiplier: physique.ENGINE_ATK_BASE,
    defMultiplier: physique.ENGINE_DEF_BASE
  };
  if (!username) return fallback;
  try {
    const user = await User.findOne({ username }).select('height weight atk def').lean();
    if (!user) return fallback;
    const stats = await resolveCombatStats(user);
    return stats || fallback;
  } catch (err) {
    console.error('hpPlayerStats error', err?.message || err);
    return fallback;
  }
}

// One-time password-reset tokens. Only the SHA-256 hash of the token is stored
// (never the token itself) so a leaked DB dump can't be used to reset accounts.
const passwordResetSchema = new mongoose.Schema({
  email:    { type: String, required: true, index: true },
  username: { type: String, required: true, index: true },
  tokenHash: { type: String, required: true, index: true, unique: true },
  expiresAt: { type: Date, required: true, index: true },
  used:      { type: Boolean, default: false }
}, { timestamps: true });

const PasswordReset = mongoose.model('PasswordReset', passwordResetSchema);

// ---------- SESSIONS ----------
// A signed-in member is identified by an opaque random token, never by a
// username the client typed. Only the SHA-256 hash is stored (same rule as the
// reset tokens above), and the TTL index lets MongoDB expire the document on
// its own so no cleanup job is needed. See sessions.js for the full rules.
const sessionSchema = new mongoose.Schema({
  tokenHash:  { type: String, required: true, unique: true, index: true },
  username:   { type: String, required: true, index: true },
  createdAt:  { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  expiresAt:  { type: Date, required: true },
  userAgent:  { type: String, default: '' },
  ip:         { type: String, default: '' }
});
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Session = mongoose.model('Session', sessionSchema);

// ---------- WEB PUSH ----------
// One document per browser a member has registered for notifications, so a
// phone, a laptop and an installed PWA each get their own. The endpoint is the
// natural key: the same browser re-subscribing updates its record instead of
// adding a duplicate that would be notified twice.
const pushSubscriptionSchema = new mongoose.Schema({
  username:   { type: String, required: true, index: true },
  endpoint:   { type: String, required: true, unique: true },
  p256dh:     { type: String, required: true },
  auth:       { type: String, required: true },
  createdAt:  { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now }
});

const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);

// Push is only armed with a VAPID key pair. Without one the notifier reports
// itself disabled and every send is a no-op, so the site behaves exactly as it
// did before push existed. See .env.example for generating a pair.
const push = createPushNotifier({
  PushSubscription,
  webpush: require('web-push'),
  publicKey: (process.env.VAPID_PUBLIC_KEY || '').trim(),
  privateKey: (process.env.VAPID_PRIVATE_KEY || '').trim(),
  subject: (process.env.VAPID_SUBJECT || '').trim(),
  // Per-kind preferences + quiet hours. Fetched here (not passed from the
  // caller) so every notify() call site gets the gate without remembering it.
  getUser: username => User.findOne({ username }).select('username notificationPrefs quietHours'),
  gate: notificationPrefs.shouldPush
});
if (!push.configured) {
  console.log('Web push disabled: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable notifications (see .env.example)');
}

// ---------- RETENTION ----------
// Chat transcripts, the IP log and spent reset tokens are pruned on a schedule.
// DMs are deliberately not, unless RETENTION_DM_DAYS is set — see retention.js.
const retention = createRetentionJob({
  models: { PublicMessage, RoomMessage, IpLog, PasswordReset, DM },
  config: configFromEnv(process.env),
  isConnected: () => mongoose.connection.readyState === 1
});

const sessions = createSessionManager({ Session, User, appBaseUrl: APP_BASE_URL });

/**
 * The session cookie is only sent over TLS in production. A local preview is
 * plain http, where `secure` would stop the browser storing the cookie at all
 * and nobody could sign in.
 */
function cookieIsSecure(req) {
  return !!req && (req.secure === true || req.headers?.['x-forwarded-proto'] === 'https');
}

/** Attach the session cookie to a response. */
function setSessionCookie(res, req, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions({ secure: cookieIsSecure(req) }));
}

/** Clear it again on sign-out. */
function clearSessionCookie(res, req) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieIsSecure(req),
    path: '/'
  });
}

// ---------- HELPERS ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE }
});

// Clips (GIFs / short videos) are written to disk — ImgBB only accepts still
// images, and video bytes are too large to keep in memory.
const clipStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = ALLOWED_CLIP_MIME[file.mimetype] || '';
    cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
  }
});
const clipUpload = multer({
  storage: clipStorage,
  limits: { fileSize: Math.max(MAX_GIF_SIZE, MAX_VIDEO_SIZE) },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_CLIP_MIME[file.mimetype]) return cb(null, true);
    cb(new Error('Only GIF, MP4 and WebM clips are allowed'));
  }
});

// Clip URLs always point at our own /clips static route with a generated
// hex filename. Anything else is rejected so message payloads can never be
// used to inject arbitrary remote URLs into stored documents.
function isLocalClipUrl(value) {
  return typeof value === 'string'
    && /^\/clips\/[a-f0-9]{32}\.(gif|mp4|webm)$/.test(value);
}

// Total bytes currently used by the clip directory (single level).
async function uploadsDirSize() {
  let total = 0;
  try {
    for (const entry of await fs.promises.readdir(UPLOADS_DIR)) {
      try {
        const stat = await fs.promises.stat(path.join(UPLOADS_DIR, entry));
        if (stat.isFile()) total += stat.size;
      } catch (_) { /* file removed meanwhile — ignore */ }
    }
  } catch (_) { /* directory not present yet — treat as empty */ }
  return total;
}

function isImgBBUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const isImgBBHost = url.hostname === 'ibb.co' || url.hostname.endsWith('.ibb.co');
    return url.protocol === 'https:' && isImgBBHost;
  } catch (_) {
    return false;
  }
}

async function uploadImageToImgBB(file) {
  const imgbbKey = process.env.IMGBB_API_KEY;
  if (!imgbbKey) {
    const error = new Error('ImgBB API key is not configured');
    error.code = 'no_imgbb_key';
    throw error;
  }

  if (!file || !file.buffer) {
    const error = new Error('No image file was supplied');
    error.code = 'no_file';
    throw error;
  }

  if (!String(file.mimetype || '').startsWith('image/')) {
    const error = new Error('Only image files can be uploaded');
    error.code = 'invalid_file_type';
    throw error;
  }

  const form = new FormData();
  form.append('image', file.buffer.toString('base64'));

  const response = await fetch(
    `https://api.imgbb.com/1/upload?key=${encodeURIComponent(imgbbKey)}`,
    { method: 'POST', body: form }
  );
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.success || !isImgBBUrl(data?.data?.url)) {
    const error = new Error('ImgBB rejected the image upload');
    error.code = 'upload_failed';
    error.details = data;
    throw error;
  }

  return {
    imageUrl: data.data.url,
    viewerUrl: data.data.url_viewer || null
  };
}

// Re-hosts a remote image on ImgBB so a chat message never ends up depending
// on a signed, short-lived CDN URL. Discord signs its attachment links with an
// ~24h expiry (`is`/`ex` params); once they lapse the CDN 404s and the image is
// gone for good, so we fetch the bytes while the URL is still valid and persist
// the durable ImgBB URL instead.
//
// Returns { url, reason }. `url` is the ImgBB URL on success (or the original
// URL when it is already hosted on ImgBB); it is null when the copy can't be
// made and the caller should keep the original URL rather than drop the image.
async function rehostImageToImgBB(rawUrl) {
  const imgbbKey = process.env.IMGBB_API_KEY;
  if (!imgbbKey) return { url: null, reason: 'no_imgbb_key' };

  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch (_) {
    return { url: null, reason: 'invalid_url' };
  }

  // Only remote HTTPS images are re-hosted. Local, data:/blob: and
  // already-ImgBB URLs are returned untouched.
  if (url.protocol !== 'https:') return { url: null, reason: 'not_https' };
  if (isImgBBUrl(url.href)) return { url: url.href, reason: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);
  if (typeof timeout.unref === 'function') timeout.unref();

  try {
    const res = await fetch(url.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
        'User-Agent': 'Mozilla/5.0 (compatible; MaleCyberFighters/1.0; +https://male-cyber-fighters.com)'
      }
    });

    const contentType = String(res.headers.get('content-type') || '')
      .split(';')[0].trim().toLowerCase();
    const contentLength = Number(res.headers.get('content-length') || 0);

    if (!res.ok) {
      if (res.body && typeof res.body.resume === 'function') res.body.resume();
      return { url: null, reason: `upstream_${res.status}` };
    }
    if (!contentType.startsWith('image/')) {
      if (res.body && typeof res.body.resume === 'function') res.body.resume();
      return { url: null, reason: `bad_type_${contentType || 'none'}` };
    }
    if (contentLength && contentLength > MAX_PROXIED_IMAGE_SIZE) {
      if (res.body && typeof res.body.resume === 'function') res.body.resume();
      return { url: null, reason: 'too_large' };
    }

    const buf = await res.buffer();
    if (!buf || !buf.length) return { url: null, reason: 'empty_body' };
    if (buf.length > MAX_PROXIED_IMAGE_SIZE) return { url: null, reason: 'too_large' };

    const uploaded = await uploadImageToImgBB({ buffer: buf, mimetype: contentType });
    return { url: uploaded.imageUrl, reason: null };
  } catch (err) {
    const isAbortError = err && (
      err.name === 'AbortError' || err.type === 'aborted' || err.code === 'ABORT_ERR'
    );
    return { url: null, reason: isAbortError ? 'timeout' : (err.message || 'error') };
  } finally {
    clearTimeout(timeout);
  }
}

// True for a signed Discord CDN attachment URL. These are the links that lapse
// ~24h after issue, so the stale-image sweep targets exactly this host rather
// than rewriting every historical third-party URL.
function isDiscordCdnUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' &&
      (url.hostname === 'cdn.discordapp.com' || url.hostname === 'media.discordapp.net');
  } catch (_) {
    return false;
  }
}

// One-off maintenance sweep for chat messages that still point at Discord CDN
// links (which expire ~24h after issue). For each one it re-hosts a still-valid
// image on ImgBB and clears a definitively-dead one. Transient failures (CDN
// timeout, network error, missing ImgBB key) leave the record untouched so a
// possibly-valid image is never dropped by mistake.
async function sweepStaleDiscordImages({ dryRun = false, limit = 1000 } = {}) {
  const summary = {
    dryRun,
    scanned: 0,
    rehosted: 0,
    cleared: 0,
    skipped: 0,
    errors: 0,
    items: []
  };

  const collections = [
    { model: PublicMessage, label: 'PublicMessage' },
    { model: RoomMessage, label: 'RoomMessage' },
    { model: DM, label: 'DM' }
  ];

  for (const { model, label } of collections) {
    let docs;
    try {
      docs = await model
        .find({ imageUrl: { $type: 'string', $ne: '' } })
        .select('_id imageUrl')
        .lean();
    } catch (err) {
      console.error(`sweep: failed to read ${label}`, err.message || err);
      summary.errors++;
      continue;
    }

    for (const doc of docs) {
      if (summary.scanned >= limit) break;
      if (!isDiscordCdnUrl(doc.imageUrl)) continue;
      summary.scanned++;

      const entry = { collection: label, id: String(doc._id), from: doc.imageUrl };
      const rehosted = await rehostImageToImgBB(doc.imageUrl);

      if (rehosted.url) {
        summary.rehosted++;
        entry.action = 'rehosted';
        entry.to = rehosted.url;
        if (!dryRun) {
          await model.updateOne({ _id: doc._id }, { $set: { imageUrl: rehosted.url } }).catch(() => {});
        }
      } else if (
        rehosted.reason === 'upstream_404' ||
        rehosted.reason === 'upstream_410' ||
        String(rehosted.reason || '').startsWith('bad_type_')
      ) {
        // Upstream says the file is gone (404/410) or is no longer an image —
        // clear it so clients stop rendering a broken <img>.
        summary.cleared++;
        entry.action = 'cleared';
        if (!dryRun) {
          await model.updateOne({ _id: doc._id }, { $set: { imageUrl: null } }).catch(() => {});
        }
      } else {
        // Timeout, network error, missing key, too large — leave as-is.
        summary.skipped++;
        entry.action = 'skipped';
        entry.reason = rehosted.reason;
      }

      summary.items.push(entry);
    }
  }

  return summary;
}

function getIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
}

async function logIp(req, { action, username }) {
  try {
    await IpLog.create({
      ip: getIp(req),
      username: username || null,
      action,
      userAgent: req.headers['user-agent'] || ''
    });
  } catch (e) {
    console.error('IP log error', e);
  }
}

// A public/room message used to send the same Google request once per online
// user. Reuse only identical requests that are currently in progress so each
// message is translated once per language instead of once per recipient.
const pendingTranslations = new Map();

async function translateText(text, targetLang) {
  const requestKey = `${targetLang}\u0000${text}`;
  const pending = pendingTranslations.get(requestKey);
  if (pending) return pending;

  const request = (async () => {
    try {
      const resp = await fetch(
        `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`,
        { headers: { Accept: "application/json" } }
      );

      const contentType = resp.headers.get("content-type") || "";
      if (!resp.ok || !contentType.includes("json")) {
        throw new Error(`Google Translate returned HTTP ${resp.status} (${contentType || "unknown content type"})`);
      }

      const data = await resp.json();
      return data[0][0][0]; // translated text
    } catch (err) {
      console.error("Translation error:", err);
      return text; // fallback
    }
  })();

  pendingTranslations.set(requestKey, request);

  try {
    return await request;
  } finally {
    pendingTranslations.delete(requestKey);
  }
}

async function sendDiscordWebhookMessage(username, message, avatarUrl) {
  if (!DISCORD_WEBHOOK_URL) return;

  // avatar_url only goes in when there is one to send — an empty string can
  // be rejected by Discord and would mask the webhook's default avatar.
  const payload = buildWebhookPayload(username, message, avatarUrl);

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error("Failed to send webhook:", response.statusText);
    }
  } catch (err) {
    console.error("Error sending webhook:", err);
  }
}

async function forwardDMToDiscord(senderUsername, receiver, messageContent) {
  if (receiver && receiver.discordId) {
    let formattedMessage = `**${senderUsername}** sent you a DM on MaleCyberFighters:\n\n${messageContent}`;
    // Replies sent back through the bot have to name their recipient, so show
    // the syntax instead of letting a bary bounce. System notices have no
    // human to reply to, so they get no hint.
    if (senderUsername && senderUsername !== "SYSTEM") {
      formattedMessage += `\n\n*To reply from Discord, send \`@${senderUsername} your message\`.*`;
    }
    await sendDiscordDM(receiver.discordId, formattedMessage);
  }
}

// Send a notification email to the admin mailbox (administrator@male-cyber-fighters.com).
// Only fires when SMTP is configured and EMAIL_ADMIN_ALERTS is enabled, so it is
// a no-op in normal operation. Never throws — failure only logs.
async function sendAdminEmail(subject, { text, html } = {}) {
  if (!mailerConfigured || !EMAIL_ADMIN_ALERTS) return;
  try {
    const result = await sendMail({
      to: MAIL_FROM,
      subject,
      text,
      html
    });
    if (result.ok) {
      console.log(`[mailer] admin alert sent: ${subject} (${result.messageId})`);
    } else if (!result.skipped) {
      console.error(`[mailer] admin alert failed: ${subject}`, result.error);
    }
  } catch (err) {
    console.error('[mailer] admin alert error:', err.message || err);
  }
}

// Build the absolute base URL for links in outgoing emails. Prefers the
// explicitly configured APP_BASE_URL, otherwise derives it from the request
// (respecting reverse-proxy X-Forwarded-Proto/For when trust-proxy is on).
function getBaseUrl(req) {
  if (APP_BASE_URL) return APP_BASE_URL.replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Escape a string so it can be safely embedded inside a RegExp.
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Generate a random reset token, store its hash, and return the raw token so
// the caller can embed it in the reset link. Only the hash is persisted.
async function createPasswordResetToken(user) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  await PasswordReset.create({
    email: user.email,
    username: user.username,
    tokenHash: sha256(rawToken),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    used: false
  });
  return rawToken;
}

function serializeForum(forum, replyCount = 0) {
  return {
    _id: String(forum._id),
    title: forum.title,
    body: forum.body,
    author: forum.author,
    authorDisplay: forum.authorDisplay || forum.author,
    createdAt: forum.createdAt,
    updatedAt: forum.updatedAt,
    lastActivityAt: forum.lastActivityAt || forum.createdAt,
    replyCount
  };
}

function serializeForumReply(reply) {
  return {
    _id: String(reply._id),
    forum: String(reply.forum),
    body: reply.body,
    author: reply.author,
    authorDisplay: reply.authorDisplay || reply.author,
    createdAt: reply.createdAt,
    updatedAt: reply.updatedAt
  };
}

async function getForumsWithReplyCounts() {
  const [forums, replyCounts] = await Promise.all([
    Forum.find({}).sort({ lastActivityAt: -1, createdAt: -1 }).lean(),
    ForumReply.aggregate([
      { $group: { _id: '$forum', count: { $sum: 1 } } }
    ])
  ]);

  const countsByForumId = new Map(
    replyCounts.map(item => [String(item._id), item.count])
  );

  return forums.map(forum =>
    serializeForum(forum, countsByForumId.get(String(forum._id)) || 0)
  );
}

async function broadcastForumsList() {
  try {
    const forums = await getForumsWithReplyCounts();
    io.emit('forumsList', forums);
    return forums;
  } catch (err) {
    // A notification failure must not make an already saved forum/reply fail.
    console.error('forum list broadcast error:', err);
    return null;
  }
}

async function getForumAuthor(username) {
  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  if (!normalizedUsername) return null;

  // The existing client session supplies the username. Confirm that it maps to
  // a real, non-banned member before allowing that name to create content.
  return User.findOne({
    username: normalizedUsername,
    banned: { $ne: true }
  })
    .select('username display')
    .lean();
}

async function updateRoomMembers(roomId) {
  try {
    const sockets = await io.in(roomId).fetchSockets();
    const members = [];

    for (const s of sockets) {
      // attempt to access the live socket instance (may be different shapes depending on fetchSockets result)
      const live = io.sockets.sockets.get(s.id) || s;
      const username = live?.username || s?.username || (live?.handshake?.auth && live.handshake.auth.username) || null;

      if (!username) continue; // skip anonymous sockets

      const user = await User.findOne({ username }).lean();

      if (!user) {
        // fallback member object when user record not found
        members.push({ username, display: username, imageUrl: null, online: true });
        continue;
      }

      members.push({
        username: user.username,
        display: user.display || user.username,
        imageUrl: user.imageUrl || null,
        online: user.online ?? true
      });
    }

    io.to(roomId).emit("roomMembers", members);
  } catch (err) {
    console.error("updateRoomMembers error:", err);
  }
}

// Whether any live socket of `username` is currently in `roomId`. Used to avoid
// announcing a join/leave when the user already has (or still has) another
// session in the room — a second tab, the phone, the desktop app.
async function roomHasUser(roomId, username) {
  if (!roomId || !username) return false;
  try {
    const sockets = await io.in(String(roomId)).fetchSockets();
    for (const s of sockets) {
      const live = io.sockets.sockets.get(s.id) || s;
      const uname = live?.username || s?.username ||
        (live?.handshake?.auth && live.handshake.auth.username) || null;
      if (uname && String(uname) === String(username)) return true;
    }
  } catch (err) {
    console.error("roomHasUser error:", err.message || err);
  }
  return false;
}

// Broadcast a system notice ("<name> has joined/left the room") into the room
// feed. Live-only: nothing is persisted, so the notice reaches only the people
// currently in the room and never shows up in scrollback/history. Never throws —
// an announcement failure must not break the join/leave it accompanies.
async function announceRoomSystemMessage(roomId, username, action) {
  try {
    const user = await User.findOne({ username }).lean();
    const name = user?.display || user?.username || username;
    const text = action === "join"
      ? `${name} has joined the room`
      : `${name} has left the room`;

    io.to(roomId).emit("roomMessage", {
      room: roomId,
      from: "SYSTEM",
      display: null,
      text,
      type: "system",
      time: new Date()
    });
  } catch (err) {
    console.error("announceRoomSystemMessage error:", err.message || err);
  }
}

/* ---------- Story authoring -------------------------------------------------
   Stories are written by one member about a conversation they had with another,
   then approved by the second before they go public. The routes live in
   storyRoutes.js (so they can be tested without a database) and the rules they
   apply live in storyService.js.

   The two notification helpers are passed as thunks because emitToUser comes
   from the DM delivery setup further down this file.
--------------------------------------------------------------------------- */
app.use("/api/story", createStoryRouter({
  Story,
  User,
  DM,
  mongoose,
  isLocalClipUrl,
  emitToUser: (...args) => deliverToUser(...args),
  forwardDMToDiscord: (...args) => forwardDMToDiscord(...args),
  // The moment a story first goes public, both writers get their publishing
  // achievements checked (first story / five stories).
  onPublished: async story => {
    for (const name of [story.owner, story.partner]) {
      if (!name) continue;
      const storyCount = await Story.countDocuments({
        approved: true,
        $or: [{ owner: name }, { partner: name }]
      }).catch(() => 0);
      await awardAchievements(name, "story_published", { storyCount });
    }
  }
}));

app.post("/api/relationship/request", sessions.requireUser, async (req, res) => {
  const { target, type } = req.body || {};
  // The requester is the signed-in member. Taking it from the body let anyone
  // send a relationship request as somebody else.
  const requester = req.username;

  if (!target || String(target).trim() === requester) {
    return res.status(400).json({ ok: false, error: "invalid_target" });
  }

  const rel = await Relationship.create({
    requester,
    target,
    type,
    approvedRequester: true,
    approvedTarget: false,
    approved: false
  });

  const targetUser = await User.findOne({ username: target }).lean();

  if (targetUser?.socketId) {
    io.to(targetUser.socketId).emit("relationshipApprovalRequest", {
      relationshipId: rel._id,
      from: requester,
      type
    });
  } else {
    let dmText = `${requester} wants to add a relationship: ${type}.`;
    await DM.create({
  from: "SYSTEM",
  to: target,
  text: dmText,
  type: "relationshipApproval",
  relationshipId: rel._id,
  time: new Date()
});
    const targetUserDoc = await User.findOne({ username: target }).lean();
    await forwardDMToDiscord("SYSTEM", targetUserDoc, dmText);

  }

  res.json({ ok: true });
});

app.post("/api/relationship/approve", sessions.requireUser, async (req, res) => {
  const { relationshipId } = req.body || {};

  const rel = await Relationship.findById(relationshipId);
  if (!rel) return res.json({ ok: false });

  // Only the member the request was sent to may accept it. Approving by id used
  // to be open to anyone who could guess or read one.
  if (rel.target !== req.username) {
    return res.status(403).json({ ok: false, error: "not_your_request" });
  }

  rel.approvedTarget = true;

  if (rel.approvedRequester && rel.approvedTarget) {
    rel.approved = true;
  }

  await rel.save();

  // A first approved relationship is an achievement for both sides.
  if (rel.approved) {
    awardAchievements(rel.requester, "relationship_approved", { relationship: rel });
    awardAchievements(rel.target, "relationship_approved", { relationship: rel });
  }

  res.json({ ok: true, approved: rel.approved });
});

app.get("/api/relationship/list", sessions.requireUser, async (req, res) => {
  const username = req.username;

  const rels = await Relationship.find({
    approved: true,
    $or: [
      { requester: username },
      { target: username }
    ]
  }).lean();

  res.json({ ok: true, relationships: rels });
});

app.get("/api/relationship/pending", sessions.requireUser, async (req, res) => {
  const username = req.username;

  const rels = await Relationship.find({
    requester: username,
    approved: false
  }).lean();

  res.json({ ok: true, relationships: rels });
});

// ---------- API: RELATIONSHIP TIMELINE ----------
app.get("/api/relationship/timeline", sessions.requireUser, async (req, res) => {
  const username = req.username;

  try {
    const rels = await Relationship.find({
      approved: true,
      $or: [
        { requester: username },
        { target: username }
      ]
    })
    .sort({ createdAt: 1 })  // oldest → newest
    .lean();

    // map to a simple timeline structure
    const timeline = rels.map(rel => {
      const isRequester = rel.requester === username;
      const other =
        isRequester ? rel.target : rel.requester;

      return {
        id: rel._id,
        type: rel.type,
        with: other,
        role: isRequester ? "requester" : "target",
        approvedAt: rel.createdAt
      };
    });

    res.json({ ok: true, timeline });
  } catch (err) {
    console.error("relationship timeline error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/block-user", sessions.requireUser, async (req, res) => {
  const username = req.username;
  const target = req.body?.target;

  if (!target) {
    return res.json({ ok: false, error: "missing_fields" });
  }

  try {
    await User.updateOne(
      { username },
      { $addToSet: { blockedUsers: target } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("block-user error:", err);
    return res.json({ ok: false, error: "server_error" });
  }
});

app.post("/api/unblock-user", sessions.requireUser, async (req, res) => {
  const username = req.username;
  const target = req.body?.target;

  if (!target) {
    return res.json({ ok: false, error: "missing_fields" });
  }

  try {
    await User.updateOne(
      { username },
      { $pull: { blockedUsers: target } }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("unblock-user error:", err);
    return res.json({ ok: false, error: "server_error" });
  }
});

// The admin panel is one shared key, so it is worth slowing down: without a
// limit the only thing standing between a visitor and the ban / delete /
// reset-password endpoints is how fast they can guess.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

function requireAdmin(req, res, next) {
  const presented = req.get("x-admin-key");
  // Constant-time, so the comparison does not leak how much of the key a
  // guess got right.
  if (!ADMIN_KEY || !presented || !safeEqual(presented, ADMIN_KEY)) {
    return res.status(403).json({ ok: false, error: "admin_denied" });
  }
  next();
}

async function broadcastPresence() {
  const onlineUsers = await User.find({ online: true })
    .select("username display imageUrl extraPhotos info wins losses color language age height weight lastSeenAt lfg achievements createdAt -_id")
    .lean();

  io.emit("presence", onlineUsers);
}

/**
 * Sign a member out everywhere: revoke every stored session and tell every
 * live socket to drop its local one.
 *
 * `socketId` on the user document only remembers the most recent connection, so
 * kicking that one socket left the member's other tabs, phone and desktop app
 * signed in — which matters most for a ban, where the point is that they stop.
 */
async function signOutEverywhere(username, reason) {
  if (!username) return;
  try {
    await sessions.destroyUserSessions(username);
  } catch (err) {
    console.error('revoke sessions error:', err.message || err);
  }
  try {
    emitToUser(username, 'forceLogout', { reason });
  } catch (err) {
    console.error('force logout error:', err.message || err);
  }
}

app.use('/api/admin', adminLimiter);

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await User.find()
      .select("username display email imageUrl extraPhotos info stats color language age height weight atk def role banned online tags createdAt")
      .sort({ username: 1 })
      .lean();

    res.json({ ok: true, users });
  } catch (err) {
    console.error("Admin user fetch error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/ban", requireAdmin, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const banned = req.body.banned === true || req.body.banned === "true";

  if (!username) {
    return res.status(400).json({ ok: false, error: "missing_username" });
  }

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const previousSocketId = user.socketId;
    user.banned = banned;

    if (banned) {
      user.online = false;
      user.socketId = null;
    }

    await user.save();

    if (banned) {
      // Sessions first, then the live sockets: a banned member must not be able
      // to keep using a tab that was already signed in, and must not be able to
      // sign back in with a token issued before the ban.
      await signOutEverywhere(username, "banned");
      if (previousSocketId) io.to(previousSocketId).emit("forceLogout", { reason: "banned" });
    }

    await broadcastPresence();

    res.json({
      ok: true,
      user: {
        username: user.username,
        banned: user.banned,
        online: user.online
      }
    });
  } catch (err) {
    console.error("Admin ban error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/reset-password", requireAdmin, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const newPassword = String(req.body.newPassword || "");

  if (!username || !newPassword.trim()) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  try {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const result = await User.updateOne({ username }, { $set: { passwordHash } });

    if (!result.matchedCount) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    // A new password invalidates every existing session, including any held by
    // whoever had the old one.
    await signOutEverywhere(username, "password_reset");

    res.json({ ok: true });
  } catch (err) {
    console.error("Admin reset password error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/delete-user", requireAdmin, async (req, res) => {
  const username = String(req.body.username || "").trim();

  if (!username) {
    return res.status(400).json({ ok: false, error: "missing_username" });
  }

  try {
    const user = await User.findOneAndDelete({ username }).lean();
    if (!user) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    await signOutEverywhere(username, "deleted");
    await push.unsubscribeAll(username);
    if (user.socketId) {
      io.to(user.socketId).emit("forceLogout", { reason: "deleted" });
    }

    await broadcastPresence();

    res.json({ ok: true });
  } catch (err) {
    console.error("Admin delete user error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      onlineUsers,
      bannedUsers,
      totalLogs,
      logins24h,
      fails24h,
      regs24h
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ online: true }),
      User.countDocuments({ banned: true }),
      IpLog.countDocuments({}),
      IpLog.countDocuments({ createdAt: { $gte: since }, action: "login_success" }),
      IpLog.countDocuments({ createdAt: { $gte: since }, action: { $in: ["login_fail", "login_error", "login_banned"] } }),
      IpLog.countDocuments({ createdAt: { $gte: since }, action: "register" })
    ]);

    res.json({
      ok: true,
      totalUsers,
      onlineUsers,
      bannedUsers,
      totalLogs,
      last24h: { logins24h, fails24h, regs24h }
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/admin/top-ips", requireAdmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const ips = await IpLog.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $ifNull: ["$ip", "unknown"] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({ ok: true, ips });
  } catch (err) {
    console.error("Admin top IPs error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Sweep stale Discord CDN image URLs out of chat history. Discord attachment
// links expire ~24h after issue; this re-hosts the ones still fetchable on
// ImgBB and clears the definitively-dead ones. Pass ?dryRun=1 to preview.
app.post("/api/admin/sweep-stale-images", requireAdmin, async (req, res) => {
  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
  const limit = Math.min(Number(req.query.limit) || 1000, 10000);

  try {
    const summary = await sweepStaleDiscordImages({ dryRun, limit });
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error("Admin sweep stale images error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/**
 * Load the conversation a story will be written from.
 *
 * This returns real private messages, so it only answers somebody who is one
 * of the two people in the conversation — it used to hand any caller the full
 * DM history between any two usernames. The window is bounded at both ends and
 * capped, because the editor only ever shows a pickable list.
 */
/* Story routes (load / list / archives / one story by id) are mounted from
   storyRoutes.js at /api/story above. */

app.post("/api/check-availability", async (req, res) => {
  try {
    const { username, email } = req.body;

    const conflict = {
      username: false,
      email: false
    };

    const user = await User.findOne({
      $or: [
        { username: username?.toLowerCase() },
        { email: email?.toLowerCase() }
      ]
    });

    if (user) {
      if (user.username === username.toLowerCase()) conflict.username = true;
      if (user.email === email.toLowerCase()) conflict.email = true;
    }

    res.json({
      ok: !conflict.username && !conflict.email,
      conflict
    });

  } catch (err) {
    console.error("check-availability error:", err);
    res.json({
      ok: false,
      conflict: { username: false, email: false }
    });
  }
});

app.post("/api/send-dm", sessions.requireUser, async (req, res) => {
  const { to, text } = req.body || {};
  // A support report is filed by the signed-in member. `from` used to come from
  // the request body, so a report could be filed as anybody.
  const from = req.username;

  if (!to) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  // User-typed support reports pass through the same invite rewrite.
  const safeText = typeof text === 'string' ? rewriteDiscordInvites(text) : text;

  const dm = await DM.create({
    from,
    to,
    text: safeText,
    time: new Date(),
    type: "supportReport"
  });

  const target = await User.findOne({ username: to }).lean();

  deliverToUser(to, "privateMessage", { ...dm.toObject(), id: String(dm._id) });

  await forwardDMToDiscord(from, target, safeText);

  res.json({ ok: true });
});

// ---------- API: PUBLIC CHAT HISTORY ----------
app.get("/api/public-messages", async (req, res) => {
  try {
    // Paging backwards: the client sends the `oldest` timestamp it already has
    // and receives the page immediately before it — the same contract
    // /api/dm/history uses, so one scroll-back helper serves both feeds.
    const { limit, filter } = pagingRequest(req.query, {
      page: PUBLIC_HISTORY_PAGE,
      max: PUBLIC_HISTORY_MAX
    });

    // Fetch the newest page, then restore chronological display order.
    // Sorting ascending before limiting returned the oldest 200 forever, so
    // new messages did not change the response and browsers kept seeing 304.
    const messages = (await PublicMessage
      .find(filter)
      .sort({ time: -1 })
      .limit(limit)
      .lean())
      .reverse();

    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({ ok: true, ...pageEnvelope(messages, { limit }) });
  } catch (err) {
    console.error("load public messages error:", err);
    res.status(500).json({ ok: false });
  }
});

// ---------- API: IMAGE UPLOAD ----------
// Used for avatars and chat attachments. Extra profile photos use the
// dedicated endpoint below so their URLs are persisted to the user document
// as part of the same request.
app.post('/api/upload-image', sessions.requireUser, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });

  try {
    const uploaded = await uploadImageToImgBB(req.file);
    return res.json({
      ok: true,
      imageUrl: uploaded.imageUrl,
      viewer: uploaded.viewerUrl
    });
  } catch (e) {
    console.error('upload error', e);
    const status = e.code === 'no_file' || e.code === 'invalid_file_type' ? 400 : 500;
    return res.status(status).json({
      ok: false,
      error: e.code || 'upload_error',
      ...(e.details ? { details: e.details } : {})
    });
  }
});

// ---------- API: CLIP UPLOAD (GIF / SHORT VIDEO) ----------
// Used by DMs, custom rooms and story attachments. GIFs, MP4 and WebM files
// are stored locally and served from /clips/<name>; the returned URL is what
// gets persisted on DM / RoomMessage / Story documents.
app.post('/api/upload-clip', sessions.requireUser, (req, res, next) => {
  // Run multer with an explicit callback so size/type errors come back as
  // JSON (there is no global error middleware).
  clipUpload.single('clip')(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, error: 'file_too_large', maxFileSize: MAX_VIDEO_SIZE });
      }
      return res.status(400).json({ ok: false, error: err.code === 'LIMIT_UNEXPECTED_FILE' ? 'no_file' : err.code });
    }
    return res.status(400).json({ ok: false, error: 'invalid_file_type', message: err.message });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });

  try {
    const isGif = req.file.mimetype === 'image/gif';
    const limit = isGif ? MAX_GIF_SIZE : MAX_VIDEO_SIZE;

    if (req.file.size > limit) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(413).json({ ok: false, error: 'file_too_large', maxFileSize: limit });
    }

    // Hard cap on total clip storage so chat media can't fill the disk.
    if ((await uploadsDirSize()) - req.file.size > MAX_UPLOADS_TOTAL_SIZE) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(507).json({ ok: false, error: 'storage_full' });
    }

    return res.json({
      ok: true,
      clipUrl: `/clips/${req.file.filename}`,
      clipType: isGif ? 'gif' : 'video',
      size: req.file.size
    });
  } catch (e) {
    console.error('clip upload error', e);
    await fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(500).json({ ok: false, error: 'upload_error' });
  }
});

// ---------- API: EXTRA PROFILE PHOTOS ----------
app.get('/api/profile/photos', sessions.requireUser, async (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username) {
    return res.status(400).json({ ok: false, error: 'missing_username' });
  }

  try {
    const user = await User.findOne({ username }).select('extraPhotos -_id').lean();
    if (!user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    return res.json({
      ok: true,
      extraPhotos: (user.extraPhotos || []).filter(isImgBBUrl)
    });
  } catch (e) {
    console.error('get profile photos error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

const receiveExtraProfilePhotos = upload.array('photos', MAX_EXTRA_PROFILE_PHOTOS);

app.post('/api/profile/photos', sessions.requireUser, (req, res) => {
  receiveExtraProfilePhotos(req, res, async uploadError => {
    if (uploadError) {
      const isClientError = uploadError instanceof multer.MulterError;
      return res.status(isClientError ? 400 : 500).json({
        ok: false,
        error: uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'file_too_large'
          : uploadError.code === 'LIMIT_UNEXPECTED_FILE'
            ? 'too_many_photos'
            : 'upload_error',
        maxPhotos: MAX_EXTRA_PROFILE_PHOTOS,
        maxFileSize: MAX_IMAGE_SIZE
      });
    }

    // The session decides whose gallery this is, not the form field.
    const username = req.username;
    const files = Array.isArray(req.files) ? req.files : [];

    if (!files.length) {
      return res.status(400).json({ ok: false, error: 'no_file' });
    }
    if (files.some(file => !String(file.mimetype || '').startsWith('image/'))) {
      return res.status(400).json({ ok: false, error: 'invalid_file_type' });
    }

    try {
      const user = await User.findOne({ username });
      if (!user) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }

      const existingPhotos = Array.isArray(user.extraPhotos)
        ? user.extraPhotos.filter(isImgBBUrl)
        : [];
      const availableSlots = MAX_EXTRA_PROFILE_PHOTOS - existingPhotos.length;

      if (availableSlots <= 0 || files.length > availableSlots) {
        return res.status(400).json({
          ok: false,
          error: 'profile_photo_limit',
          maxPhotos: MAX_EXTRA_PROFILE_PHOTOS,
          remainingSlots: Math.max(0, availableSlots)
        });
      }

      const uploadedPhotos = [];
      for (const file of files) {
        const uploaded = await uploadImageToImgBB(file);
        uploadedPhotos.push(uploaded.imageUrl);
      }

      user.extraPhotos = [...new Set([...existingPhotos, ...uploadedPhotos])];
      await user.save();

      return res.json({
        ok: true,
        uploadedPhotos,
        extraPhotos: user.extraPhotos,
        maxPhotos: MAX_EXTRA_PROFILE_PHOTOS
      });
    } catch (e) {
      console.error('profile photo upload error', e);
      const status = e.code === 'invalid_file_type' || e.code === 'no_file' ? 400 : 500;
      return res.status(status).json({
        ok: false,
        error: e.code || 'upload_error',
        ...(e.details ? { details: e.details } : {})
      });
    }
  });
});

app.delete('/api/profile/photos', sessions.requireUser, async (req, res) => {
  const username = req.username;
  const photoUrl = String(req.body.photoUrl || '').trim();

  if (!photoUrl) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  try {
    const user = await User.findOneAndUpdate(
      { username },
      { $pull: { extraPhotos: photoUrl } },
      { new: true }
    ).select('extraPhotos -_id');

    if (!user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    return res.json({
      ok: true,
      extraPhotos: (user.extraPhotos || []).filter(isImgBBUrl)
    });
  } catch (e) {
    console.error('remove profile photo error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: UPDATE PROFILE ----------
// A Discord user ID is a snowflake: a plain run of digits. The profile field is
// free text, so people paste a mention (<@123456789012345678>), a username
// (john_doe) or an old tag (john#1234) instead. Anything that is not a
// snowflake breaks the DM bridge in both directions, but only one direction
// says so: outbound calls users.fetch() and swallows the failure into the log,
// so the site looks fine while nothing is delivered. Accept every form that
// clearly names a snowflake and reject the rest instead of storing it.
const DISCORD_SNOWFLAKE = /^\d{16,25}$/;

function normalizeDiscordId(value) {
  if (value === null || value === undefined) return { ok: true, value: null };

  const raw = String(value).trim();
  if (!raw) return { ok: true, value: null };          // clearing the field is allowed

  // A pasted mention: <@123456789012345678> or <@!123456789012345678>.
  const mention = raw.match(/^<@!?(\d+)>$/) || raw.match(/^@(\d+)$/);
  // Otherwise drop stray spaces and the zero-width characters that survive a
  // copy/paste out of Discord.
  const candidate = mention ? mention[1] : raw.replace(/[\s\u200b-\u200d\ufeff]/g, '');

  if (DISCORD_SNOWFLAKE.test(candidate)) return { ok: true, value: candidate };
  return { ok: false, value: raw };
}

app.post('/api/update-profile', sessions.requireUser, async (req, res) => {
  const { updates } = req.body || {};
  // Whose profile this edits comes from the session. Taking it from the body
  // let anyone rewrite any member's display name, bio, photos and physique.
  const username = req.username;

  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ ok: false, error: 'missing_updates' });
  }

  // Only these fields may be written by the member. The object used to be
  // passed through wholesale, so a hand-crafted request could set ANY user
  // field — role, banned, even someone's saved counters. An allowlist makes
  // that impossible instead of unlikely. (Wins and losses are no longer
  // member-writable at all: they are match-record counters now.)
  const PROFILE_FIELDS = [
    'display', 'age', 'discordId', 'height', 'weight', 'info', 'color',
    'language', 'imageUrl', 'tags'
  ];
  const safeUpdates = {};
  for (const field of PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      safeUpdates[field] = updates[field];
    }
  }

  // Physique fields get normalised before they reach Mongo so clients can
  // send 5'11", 5'11 or raw inches and get the same stored value back.

  if (Object.prototype.hasOwnProperty.call(safeUpdates, 'discordId')) {
    const discordId = normalizeDiscordId(safeUpdates.discordId);
    if (!discordId.ok) {
      return res.status(400).json({ ok: false, error: 'invalid_discord_id' });
    }
    safeUpdates.discordId = discordId.value;
  }

  if (Object.prototype.hasOwnProperty.call(safeUpdates, 'height')) {
    const rawHeight = safeUpdates.height;
    if (rawHeight === undefined || rawHeight === null || String(rawHeight).trim() === '') {
      // Clearing physique is allowed — store an empty string.
      safeUpdates.height = '';
    } else {
      const normalized = normalizeHeight(rawHeight);
      if (!normalized) {
        return res.status(400).json({ ok: false, error: 'invalid_height' });
      }
      safeUpdates.height = normalized;
    }
  }

  if (Object.prototype.hasOwnProperty.call(safeUpdates, 'weight')) {
    const rawWeight = safeUpdates.weight;
    if (rawWeight === undefined || rawWeight === null || String(rawWeight).trim() === '') {
      // Clearing physique is allowed — store null so the field reads as unset.
      safeUpdates.weight = null;
    } else {
      const normalized = normalizeWeight(rawWeight);
      if (normalized === null) {
        return res.status(400).json({ ok: false, error: 'invalid_weight' });
      }
      safeUpdates.weight = normalized;
    }
  }

  // Fighter tags. An empty selection (or `null`) clears them; unknown ids are
  // dropped, so an old page left open across a catalogue change can still
  // save the rest of the profile.
  if (Object.prototype.hasOwnProperty.call(safeUpdates, 'tags')) {
    const tagSelection = readTagSelection(safeUpdates.tags);
    if (!tagSelection.ok) {
      return res.status(400).json({ ok: false, error: 'invalid_tags' });
    }
    safeUpdates.tags = tagSelection.tags;
  }

  // The saved combat stats must track the physique — recompute them
  // whenever the height or weight field is part of this update (including
  // clearing it, which resets the stats to null).
  const physiqueTouched =
    Object.prototype.hasOwnProperty.call(safeUpdates, 'height') ||
    Object.prototype.hasOwnProperty.call(safeUpdates, 'weight');

  try {
    let user = await User.findOneAndUpdate(
      { username },
      safeUpdates,
      { new: true, runValidators: true }
    ).select('-passwordHash');

    if (!user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    if (physiqueTouched) {
      const combat = physique.combatStats(user.height, user.weight);
      user.atk = combat ? combat.atk : null;
      user.def = combat ? combat.def : null;
      await user.save();
      user = user.toObject();
    }

    return res.json({ ok: true, user });

  } catch (e) {
    console.error('update-profile error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: COMBAT STATS (dice-match atk / def) ----------
// How the dice match pulls a fighter's saved atk / def from their userData.
// The values are derived from the physique (height → meters, weight → kg):
//   atk = height (m) × √weight (kg)
//   def = weight (kg) / height (m)
// and stored on the user document when the physique is registered or
// updated. `atkMultiplier` / `defMultiplier` are the same values scaled back
// to the legacy dice engine magnitude (see physique.js).
app.get('/api/combat-stats', async (req, res) => {
  const usernames = String(req.query.usernames || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 20);

  if (!usernames.length) {
    return res.status(400).json({ ok: false, error: 'missing_usernames' });
  }

  try {
    const users = await User.find({ username: { $in: usernames } })
      .select('username height weight atk def')
      .lean();
    const byName = new Map(users.map(u => [u.username, u]));

    const stats = {};
    for (const username of usernames) {
      const user = byName.get(username);
      if (!user) {
        stats[username] = { atk: null, def: null, atkMultiplier: null, defMultiplier: null };
        continue;
      }

      // Recompute (and persist) whenever the stored atk/def are missing or
      // out of step with the current physique formula (e.g. after the def
      // formula dropped its /2 factor) — see resolveCombatStats.
      const resolved = await resolveCombatStats(user);

      stats[username] = resolved || { atk: null, def: null, atkMultiplier: null, defMultiplier: null };
    }

    return res.json({ ok: true, stats });
  } catch (e) {
    console.error('combat-stats error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: ACCOUNT SETTINGS - CHANGE PASSWORD ----------
app.post('/api/account/change-password', sessions.requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const username = req.username;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  if (String(newPassword).length < 6) {
    return res.status(400).json({ ok: false, error: 'weak_password' });
  }

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) {
      await logIp(req, { action: 'change_password_fail', username });
      return res.status(401).json({ ok: false, error: 'invalid_current' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    user.passwordHash = hash;
    await user.save();

    // Changing the password signs every *other* device out. This session is
    // kept alive so the member is not thrown out of the page they changed it on.
    await sessions.destroyUserSessions(username, { exceptToken: req.sessionToken });

    await logIp(req, { action: 'change_password', username });

    return res.json({ ok: true });
  } catch (e) {
    console.error('change-password error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: ACCOUNT SETTINGS - DELETE ACCOUNT ----------
app.post('/api/account/delete', sessions.requireUser, async (req, res) => {
  const { password } = req.body || {};
  const username = req.username;

  if (!password) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      await logIp(req, { action: 'delete_account_fail', username });
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    const socketIdToKick = user.socketId;

    // Delete the user account itself
    await User.deleteOne({ username });

    // No account, no sessions: drop every token issued for it and sign out every
    // device that was using one.
    await signOutEverywhere(username, 'deleted');
    // No account, no notifications either.
    await push.unsubscribeAll(username);

    // Clean up related data (DMs, stories, relationships, rooms ownership)
    try {
      await DM.deleteMany({ $or: [{ from: username }, { to: username }] });
    } catch (e) { console.error('cleanup DMs error', e); }
    try {
      await Story.deleteMany({ $or: [{ owner: username }, { partner: username }] });
    } catch (e) { console.error('cleanup stories error', e); }
    try {
      await Relationship.deleteMany({ $or: [{ requester: username }, { target: username }] });
    } catch (e) { console.error('cleanup relationships error', e); }
    try {
      await Room.deleteMany({ owner: username });
      await Room.updateMany({}, { $pull: { invitedUsers: username } });
    } catch (e) { console.error('cleanup rooms error', e); }

    if (socketIdToKick) {
      try { io.to(socketIdToKick).emit('forceLogout', { reason: 'deleted' }); } catch (_) {}
    }

    try {
      await broadcastPresence();
      const rooms = await Room.find().lean();
      io.emit('roomsList', rooms);
    } catch (e) { console.error('broadcast after delete error', e); }

    await logIp(req, { action: 'delete_account', username });

    return res.json({ ok: true });
  } catch (e) {
    console.error('delete-account error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: REGISTER ----------
app.post('/api/register', async (req, res) => {
  const { username, email, password, display, age, stats, info, color, language, imageUrl } = req.body;
  const rawHeight = req.body.height;
  const rawWeight = req.body.weight;

  // Usernames become mention bodies in the Discord-DM bridge (the listener
  // reads "@username message"), so allow only letters / digits / _ / . / -.
  if (typeof username !== 'string' || !/^[A-Za-z0-9._-]+$/.test(username)) {
    await logIp(req, { action: 'register_fail', username });
    return res.status(400).json({ ok: false, error: 'invalid_username' });
  }

  if (!username || !email || !password) {
    await logIp(req, { action: 'register_fail', username });
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  // Physique is optional for older clients, but when it is supplied it must
  // fall inside the 3'5"–8'0" / 60–700 lbs menu ranges.
  let height;
  if (rawHeight !== undefined && rawHeight !== null && String(rawHeight).trim() !== '') {
    height = normalizeHeight(rawHeight);
    if (!height) {
      await logIp(req, { action: 'register_fail', username });
      return res.status(400).json({ ok: false, error: 'invalid_height' });
    }
  }

  let weight;
  if (rawWeight !== undefined && rawWeight !== null && String(rawWeight).trim() !== '') {
    weight = normalizeWeight(rawWeight);
    if (weight === null) {
      await logIp(req, { action: 'register_fail', username });
      return res.status(400).json({ ok: false, error: 'invalid_weight' });
    }
  }

  // Fighter tags are optional too, and unknown ids inside an otherwise valid
  // selection are dropped rather than rejected.
  const tagSelection = readTagSelection(req.body.tags);
  if (!tagSelection.ok) {
    await logIp(req, { action: 'register_fail', username });
    return res.status(400).json({ ok: false, error: 'invalid_tags' });
  }

  try {
    const existing = await User.findOne({ $or: [{ username }, { email }] }).lean();
    if (existing) {
      const conflict = {};
      if (existing.username === username) conflict.username = true;
      if (existing.email === email) conflict.email = true;
      await logIp(req, { action: 'register_conflict', username });
      return res.status(409).json({ ok: false, conflict });
    }

    const hash = await bcrypt.hash(password, 10);

    // Derive the fighter's combat stats from the physique so they are saved
    // on the user document from the very first match.
    const combat = physique.combatStats(height || '', weight == null ? null : weight);

    const user = new User({
      username,
      email,
      passwordHash: hash,
      display: display || username,
      age: age ? Number(age) : undefined,
      height: height || undefined,
      weight,
      atk: combat ? combat.atk : null,
      def: combat ? combat.def : null,
      stats: stats || {},
      info: info || '',
      color: color || '',
      language: language || 'en',
      imageUrl: imageUrl || '',
      tags: tagSelection.tags
    });

    await user.save();
    await logIp(req, { action: 'register', username });

    // Optional welcome email (only sends when SMTP is configured)
    if (mailerConfigured) {
      try {
        await sendMail({
          to: user.email,
          subject: `Welcome to Male Cyber Fighters, ${user.username}!`,
          text: `Hi ${user.username},\n\nWelcome to Male Cyber Fighters! Your account is ready.\n\nYour username: ${user.username}\n\nIf you received this email in error, you can safely ignore it.\n\n— The Male Cyber Fighters Team`,
          html: `<p>Hi <strong>${escapeHtml(user.username)}</strong>,</p><p>Welcome to <strong>Male Cyber Fighters</strong>! Your account is ready.</p><p>Your username: ${escapeHtml(user.username)}</p><p>If you received this email in error, you can safely ignore it.</p><p>— The Male Cyber Fighters Team</p>`
        });
      } catch (e) {
        console.error('[mailer] welcome email error:', e.message || e);
      }
    }

    // Optional admin alert for new registrations
    await sendAdminEmail(`New registration: ${user.username}`, {
      text: `A new user registered on Male Cyber Fighters.\n\nUsername: ${user.username}\nEmail: ${user.email}`,
      html: `<p>A new user registered on <strong>Male Cyber Fighters</strong>.</p><p>Username: ${escapeHtml(user.username)}<br>Email: ${escapeHtml(user.email)}</p>`
    });

    return res.json({
      ok: true,
      user: {
        username: user.username,
        display: user.display,
        imageUrl: user.imageUrl,
        extraPhotos: user.extraPhotos || [],
        age: user.age,
        height: user.height || '',
        weight: user.weight ?? undefined,
        atk: combat ? combat.atk : null,
        def: combat ? combat.def : null,
        discordId: user.discordId ?? null,
        tags: userTags(user)
      }
    });
  } catch (e) {
    console.error('register error', e);
    await logIp(req, { action: 'register_error', username });
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// The member record a client is allowed to hold. Everything the UI renders
// comes from here, and nothing in it is a credential: identity is carried by
// the session token, so this object can be cached, replaced or ignored without
// ever changing who the server thinks is asking.
function sessionUserPayload(user) {
  return {
    username: user.username,
    display: user.display,
    imageUrl: user.imageUrl,
    extraPhotos: user.extraPhotos || [],
    color: user.color,
    language: user.language,
    role: user.role,
    stats: user.stats,
    info: user.info,
    age: user.age,
    height: user.height || '',
    weight: user.weight ?? undefined,
    atk: user.atk ?? null,
    def: user.def ?? null,
    discordId: user.discordId ?? null,
    tags: userTags(user)
  };
}

// ---------- API: LOGIN ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    await logIp(req, { action: 'login_fail', username });
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  try {
    const user = await User.findOne({ username }).lean();
    if (!user) {
      await logIp(req, { action: 'login_fail', username });
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    if (user.banned) {
      await logIp(req, { action: 'login_banned', username });
      return res.status(403).json({ ok: false, error: 'banned' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      await logIp(req, { action: 'login_fail', username });
      return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    }

    await logIp(req, { action: 'login_success', username });

    // The credential is an opaque random token, shown to this client exactly
    // once. It also goes out as an httpOnly cookie, and that cookie — not
    // anything the browser stores or sends back — is what every later request
    // is authenticated by. The `user` object in the response is display data.
    const token = await sessions.createSession(user.username, {
      userAgent: req.headers['user-agent'] || '',
      ip: req.ip
    });
    setSessionCookie(res, req, token);

    return res.json({ ok: true, token, user: sessionUserPayload(user) });
  } catch (e) {
    console.error(e);
    await logIp(req, { action: 'login_error', username });
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: CURRENT MEMBER ----------
// GET /api/me
//   Answers from the session alone, never from anything the client claims. The
//   app calls this on boot to confirm a remembered session is still valid — a
//   forged or stale localStorage entry no longer signs anybody in.
app.get('/api/me', async (req, res) => {
  const token = sessions.tokenFromRequest(req);
  const found = token ? await sessions.verifyToken(token) : null;
  if (!found) return res.status(401).json({ ok: false, error: 'auth_required' });
  return res.json({ ok: true, user: sessionUserPayload(found.user) });
});

// ---------- API: WEB PUSH ----------
// GET /api/push/config
//   The public VAPID key the browser encrypts a subscription to, and whether
//   push is armed at all. Public on purpose: a signed-out visitor's browser asks
//   before offering the button.
app.get('/api/push/config', (req, res) => {
  res.json({ ok: true, ...push.clientConfig() });
});

// POST /api/push/subscribe
//   body: the PushSubscription JSON from the service worker registration.
//   Bound to the signed-in member — a subscription cannot be registered for
//   somebody else, so nobody can point another member's notifications at a
//   browser they control.
app.post('/api/push/subscribe', sessions.requireUser, async (req, res) => {
  if (!push.configured) {
    return res.status(503).json({ ok: false, error: 'push_not_configured' });
  }
  const result = await push.subscribe(req.username, req.body || {});
  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.json(result);
});

// POST /api/push/unsubscribe
//   body: { endpoint } — forget this browser. Only the owner's own
//   subscriptions can be removed.
app.post('/api/push/unsubscribe', sessions.requireUser, async (req, res) => {
  const endpoint = String(req.body?.endpoint || '').trim();
  if (!endpoint) {
    return res.status(400).json({ ok: false, error: 'missing_endpoint' });
  }
  return res.json(await push.unsubscribe(req.username, endpoint));
});

// ---------- API: LOGOUT ----------
// POST /api/logout
//   Ends the calling session only, so signing out in one browser does not drop
//   the member's phone or desktop app.
app.post('/api/logout', async (req, res) => {
  const token = sessions.tokenFromRequest(req);
  if (token) await sessions.destroyToken(token);
  clearSessionCookie(res, req);
  return res.json({ ok: true });
});

// ---------- API: FORGOT / RESET PASSWORD ----------
// POST /api/forgot-password
//   body: { email }
//   Looks up an account by email. If found (and SMTP is configured), generates a
//   one-time token and emails a reset link to that address. To avoid leaking
//   which emails have accounts, the response is always "ok" regardless of
//   whether the email existed — only send an email when there is a match.
app.post('/api/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ ok: false, error: 'missing_email' });
  }

  try {
    // Emails may be stored in mixed case (registration doesn't normalize), so
    // match case-insensitively while still anchoring to the full address.
    const user = await User.findOne({ email: new RegExp('^' + escapeRegex(email) + '$', 'i') }).lean();

    // Only bother sending when we both found a user and can send email.
    if (user && mailerConfigured) {
      // Clean up any previously unused, still-valid tokens for this account
      // so only the newest reset link works.
      await PasswordReset.deleteMany({ email: user.email, used: false });

      const rawToken = await createPasswordResetToken(user);
      const baseUrl = getBaseUrl(req);
      const resetUrl = `${baseUrl}/reset-password.html?token=${encodeURIComponent(rawToken)}`;
      const displayEmail = user.email;

      try {
        await sendMail({
          to: displayEmail,
          subject: 'Reset your Male Cyber Fighters password',
          text: `Hi ${user.username},\n\nWe received a request to reset your Male Cyber Fighters password.\n\nClick the link below to choose a new password (valid for 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email — your password will not change.\n\n— The Male Cyber Fighters Team`,
          html: `<p>Hi <strong>${escapeHtml(user.username)}</strong>,</p><p>We received a request to reset your Male Cyber Fighters password.</p><p>Click the button below to choose a new password (valid for 1 hour):</p><p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Reset password</a></p><p>Or copy and paste this link into your browser:<br><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p><p>If you didn't request this, you can safely ignore this email — your password will not change.</p><p>— The Male Cyber Fighters Team</p>`
        });
      } catch (err) {
        console.error('[mailer] forgot-password email error:', err.message || err);
      }
    }

    // Always respond the same way so we don't reveal which emails are registered.
    return res.json({ ok: true });
  } catch (e) {
    console.error('forgot-password error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// POST /api/reset-password
//   body: { token, newPassword }
//   Validates the one-time token from the reset link. If it is valid and not
//   expired, sets a new password (via the same bcrypt.hash used everywhere else).
app.post('/api/reset-password', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const newPassword = String(req.body.newPassword || '');

  if (!token) {
    return res.status(400).json({ ok: false, error: 'missing_token' });
  }
  if (!newPassword) {
    return res.status(400).json({ ok: false, error: 'missing_password' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'weak_password' });
  }

  try {
    const tokenHash = sha256(token);
    const record = await PasswordReset.findOne({ tokenHash, used: false });

    if (!record || record.expiresAt < new Date()) {
      return res.status(400).json({ ok: false, error: 'invalid_or_expired_token' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const result = await User.updateOne(
      { email: record.email },
      { $set: { passwordHash: hash } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    // Mark the token used so it cannot be replayed, and lock out any other
    // outstanding reset tokens for this account.
    await PasswordReset.updateMany(
      { email: record.email, used: false },
      { $set: { used: true } }
    );

    // If the user is currently logged in elsewhere, force a logout so the old
    // session is invalidated after the password change.
    const user = await User.findOne({ email: record.email }).lean();
    if (user?.socketId) {
      io.to(user.socketId).emit('forceLogout', { reason: 'password_changed' });
    }

    await logIp(req, { action: 'reset_password', username: record.username });

    return res.json({ ok: true });
  } catch (e) {
    console.error('reset-password error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: EXTERNAL PUBLIC CHAT MESSAGE ----------
// The caller here is the Discord bridge, not a signed-in browser, so it cannot
// hold a member session. It authenticates with a shared secret instead; a
// member session is accepted too so the site's own clients can use the route.
// Without CHAT_INGRESS_KEY set, only a member session works and the bridge
// must be given a key — see .env.example.
function requireChatIngress(req, res, next) {
  const presented = req.get('x-chat-ingress-key');
  if (CHAT_INGRESS_KEY && presented && safeEqual(presented, CHAT_INGRESS_KEY)) return next();
  return sessions.requireUser(req, res, next);
}

app.post("/api/chatMessage", requireChatIngress, async (req, res) => {
  try {
    const { message, timestamp, avatar } = req.body;
    // A session-authenticated caller may only post as themselves; the bridge
    // (authenticated by key) supplies the Discord member's name.
    const username = req.username || String(req.body.username || '').trim();
    const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
    let imageUrl = req.body.imageUrl || req.body.image || req.body.image_url ||
      attachments.find(a => a && (a.url || a.proxy_url) && String(a.content_type || a.contentType || "").startsWith("image/"))?.url ||
      attachments.find(a => a && (a.url || a.proxy_url))?.url ||
      attachments.find(a => a && (a.url || a.proxy_url))?.proxy_url ||
      null;

    // Signed CDN links (Discord attachments) expire ~24h after issue. Re-host
    // the image on ImgBB while it is still fetchable and persist that durable
    // URL instead, so old messages don't turn into 404s later. If the copy
    // can't be made the original URL is kept as a fallback.
    if (imageUrl) {
      const rehosted = await rehostImageToImgBB(imageUrl);
      if (rehosted.url) {
        imageUrl = rehosted.url;
      } else {
        console.warn('chat message image not re-hosted to ImgBB; keeping original URL', {
          url: imageUrl,
          reason: rehosted.reason
        });
      }
    }

    if (!username || (!message && !imageUrl)) {
      return res.status(400).json({ error: "Username and message are required" });
    }

    const msgTimestamp = timestamp ? new Date(timestamp) : new Date();

    // This endpoint is the ingress for messages bridged in from the Discord
    // channel — those pass through the same invite rewrite as website chat.
    const safeMessage = typeof message === 'string' ? rewriteDiscordInvites(message) : message;

    const enriched = {
      from: username,
      display: username,
      text: safeMessage || "",
      imageUrl: imageUrl || null,
      time: msgTimestamp
    };

    await PublicMessage.create(enriched);

    io.emit("externalPublicMessage", {
      from: username,
      display: username,
      text: safeMessage || "",
      avatar: avatar || null,
      imageUrl: imageUrl || null,
      time: msgTimestamp.toISOString()
    });

    return res.json({ success: true, message: "Message saved and broadcasted" });

  } catch (err) {
    console.error("Error saving chat message:", err);
    return res.status(500).json({ error: "Failed to save message" });
  }
});

// The conversation the caller is a party to. `a`/`b` arrive from the client in
// either order, so the caller's own name is taken from the session and the
// other one becomes the partner — a request naming two other members has no
// conversation to return.
function dmConversation(req) {
  const me = req.username;
  const names = [req.body?.a, req.body?.b].map(v => (v == null ? '' : String(v).trim()));
  if (!names.includes(me)) return { me, partner: null };
  const partner = names.find(name => name && name !== me) || null;
  return { me, partner };
}

app.post("/api/dm/history", sessions.requireUser, async (req, res) => {
  const { me, partner } = dmConversation(req);
  if (!partner) {
    return res.status(403).json({ ok: false, error: "not_your_conversation" });
  }

  // Paging backwards: the client sends the `oldest` timestamp it already has
  // and receives the page immediately before it.
  const { limit, filter: olderThan } = pagingRequest(req.body, {
    page: DM_HISTORY_PAGE,
    max: DM_HISTORY_MAX
  });

  const filter = {
    ...olderThan,
    $or: [
      { from: me, to: partner },
      { from: partner, to: me },
      // System notices belong to the member they were addressed to, so only
      // the caller's own are included — never the partner's.
      { from: "SYSTEM", to: me }
    ]
  };

  try {
    // Newest first so `limit` keeps the most recent page, then back into the
    // chronological order the client renders.
    const messages = await DM.find(filter).sort({ time: -1 }).limit(limit).lean();
    messages.reverse();

    return res.json({ ok: true, ...pageEnvelope(messages, { limit }) });
  } catch (err) {
    console.error("dm history error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/dm/partners", sessions.requireUser, async (req, res) => {
  const me = req.username;

  try {
    // Distinct names on the other side of the caller's conversations. This used
    // to load every message the member had ever sent or received into Node just
    // to build a Set of the people in it.
    const rows = await DM.aggregate([
      { $match: { $or: [{ from: me }, { to: me }] } },
      { $project: { other: { $cond: [{ $eq: ["$from", me] }, "$to", "$from"] } } },
      { $group: { _id: "$other" } },
      { $sort: { _id: 1 } }
    ]);

    return res.json({ ok: true, partners: rows.map(row => row._id).filter(Boolean) });
  } catch (err) {
    console.error("dm partners error:", err);
    return res.status(500).json({ ok: false, error: "server_error", partners: [] });
  }
});

app.post("/api/dm/clear", sessions.requireUser, async (req, res) => {
  const { me, partner } = dmConversation(req);
  if (!partner) {
    return res.status(403).json({ ok: false, error: "not_your_conversation" });
  }

  try {
    await DM.deleteMany({
      $or: [
        { from: me, to: partner },
        { from: partner, to: me }
      ]
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("dm clear error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// The tag catalogue, for API consumers and anything that would rather fetch it
// than load the page script. The page scripts use public/js/tags.js directly.
app.get('/api/tags', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  return res.json({ ok: true, categories: tags.catalogue() });
});

// The member directory. Requires a session: it is the roster behind the arena,
// and it exposes every member's profile, physique and record.
//
// Optional filters, used by the roster's search box and available to any
// client that wants to search the directory itself:
//   ?search=heel        names AND tags (label / alias / id) — "vers" finds
//                       Vers Top, "jobber" finds Heel Jobber
//   ?tags=heel,singlet  tag ids, matched with `tagMode`
//   ?tagMode=any|all    any tag (default) or every tag
app.get("/api/allUsers", sessions.requireUser, async (req, res) => {
  try {
    // Both filters can be present at once, and each one is itself an $or, so
    // they are combined with $and rather than merged into one query object.
    const clauses = [];

    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameMatch = new RegExp(escaped, 'i');
      const conditions = [{ username: nameMatch }, { display: nameMatch }];

      const matchedTags = tags.matchingTagIds(search);
      if (matchedTags.length) conditions.push(tags.mongoFilter(matchedTags, 'any'));

      clauses.push({ $or: conditions });
    }

    const wanted = tags.parseTagList(req.query.tags);
    if (wanted.length) {
      const tagCondition = tags.mongoFilter(wanted, req.query.tagMode);
      if (Object.keys(tagCondition).length) clauses.push(tagCondition);
    }

    const filter = clauses.length === 1 ? clauses[0] : (clauses.length ? { $and: clauses } : {});

    const users = await User.find(filter)
      .select("username display imageUrl extraPhotos info wins losses color language age height weight lastSeenAt atk def tags createdAt")
      .lean();

    res.json({ success: true, users: users.map(user => ({ ...user, tags: userTags(user) })) });
  } catch (err) {
    console.error("Error fetching all users:", err);
    res.status(500).json({ success: false });
  }
});


// ---------- API: FORUMS ----------
app.get('/api/forums', async (req, res) => {
  try {
    const forums = await getForumsWithReplyCounts();
    return res.json({ ok: true, forums });
  } catch (err) {
    console.error('list forums error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/forums', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';

  if (!title || !body) {
    return res.status(400).json({ ok: false, error: 'title_and_body_required' });
  }

  if (title.length > 160 || body.length > 10000) {
    return res.status(400).json({ ok: false, error: 'forum_too_long' });
  }

  try {
    const author = await getForumAuthor(req.body.author);
    if (!author) {
      return res.status(401).json({ ok: false, error: 'login_required' });
    }

    const forum = await Forum.create({
      title,
      body,
      author: author.username,
      authorDisplay: author.display || author.username,
      lastActivityAt: new Date()
    });

    const savedForum = serializeForum(forum.toObject(), 0);
    io.emit('forumCreated', savedForum);
    void broadcastForumsList();
    awardAchievements(author.username, 'forum_posted', { forum });

    return res.status(201).json({ ok: true, forum: savedForum });
  } catch (err) {
    console.error('create forum error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/api/forums/:forumId', async (req, res) => {
  const { forumId } = req.params;
  if (!mongoose.isValidObjectId(forumId)) {
    return res.status(400).json({ ok: false, error: 'invalid_forum' });
  }

  try {
    const [forum, replies] = await Promise.all([
      Forum.findById(forumId).lean(),
      ForumReply.find({ forum: forumId }).sort({ createdAt: 1 }).lean()
    ]);

    if (!forum) {
      return res.status(404).json({ ok: false, error: 'forum_not_found' });
    }

    return res.json({
      ok: true,
      forum: serializeForum(forum, replies.length),
      replies: replies.map(serializeForumReply)
    });
  } catch (err) {
    console.error('load forum error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/forums/:forumId/replies', async (req, res) => {
  const { forumId } = req.params;
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';

  if (!mongoose.isValidObjectId(forumId)) {
    return res.status(400).json({ ok: false, error: 'invalid_forum' });
  }

  if (!body) {
    return res.status(400).json({ ok: false, error: 'reply_body_required' });
  }

  if (body.length > 5000) {
    return res.status(400).json({ ok: false, error: 'reply_too_long' });
  }

  try {
    const [author, forum] = await Promise.all([
      getForumAuthor(req.body.author),
      Forum.findById(forumId).lean()
    ]);

    if (!author) {
      return res.status(401).json({ ok: false, error: 'login_required' });
    }

    if (!forum) {
      return res.status(404).json({ ok: false, error: 'forum_not_found' });
    }

    const reply = await ForumReply.create({
      forum: forum._id,
      body,
      author: author.username,
      authorDisplay: author.display || author.username
    });

    const activityAt = new Date();
    await Forum.updateOne({ _id: forum._id }, { $set: { lastActivityAt: activityAt } });

    const savedReply = serializeForumReply(reply.toObject());
    io.emit('forumReplyCreated', {
      forumId: String(forum._id),
      reply: savedReply
    });
    void broadcastForumsList();

    // The thread's author hears about a reply the moment it lands — live on
    // any session, and as a (content-free) push when they have none. They can
    // switch this off per-kind in their notification preferences.
    if (forum.author && forum.author !== author.username) {
      const reached = emitToUser(forum.author, 'forumReply', {
        forumId: String(forum._id),
        title: forum.title,
        by: author.username
      });
      if (reached === 0) pushIfOffline(forum.author, 'forum', author.display || author.username);
    }

    return res.status(201).json({ ok: true, reply: savedReply });
  } catch (err) {
    console.error('create forum reply error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});


/* ============================================================
   API: LFG / CHALLENGES / MATCH RECORD / REACTIONS / BOOKMARKS
   / ACHIEVEMENTS / NOTIFICATION PREFERENCES / REPORTS
   ------------------------------------------------------------
   All of the new community features mount here. Every router is a factory
   (models and helpers injected) so each one runs under tests without a
   database, exactly like the story router above.
============================================================ */

/**
 * Push a non-DM notification, but only when the member has no live session.
 * Live sockets already got the event; a push on top of that is noise, and a
 * member sitting in the arena does not need their phone to tell them about a
 * mention they just read.
 */
function pushIfOffline(username, kind, from, url = '/') {
  if (!push.configured || !username) return;
  try {
    if (typeof liveSocketCount === 'function' && liveSocketCount(username) > 0) return;
  } catch (err) { /* presence is best-effort; never block the notification */ }
  push
    .notify({ to: username, from: from || username, kind, url })
    .catch(err => console.error('push notify error:', err.message || err));
}

/**
 * Evaluate and award achievements for one member after an event.
 *
 * Never throws and never blocks its caller: a badge is a nicety, and a failed
 * award must not fail the match / story / challenge it decorates.
 */
async function awardAchievements(username, event, context = {}) {
  if (!username) return;
  try {
    const user = await User.findOne({ username }).select('username wins achievements');
    if (!user) return;

    // Rivalry needs a fact the caller does not have handy: how many times
    // these two have now met. Computed here so every call site stays dumb.
    if (event === 'match_recorded' && context.opponentMatches == null) {
      const match = context.match || {};
      const opponent = match.winner === username ? match.loser : match.winner;
      if (opponent) {
        context.opponentMatches = await MatchRecord.countDocuments({
          status: 'confirmed',
          $or: [
            { winner: username, loser: opponent },
            { winner: opponent, loser: username }
          ]
        });
      }
    }

    const fresh = achievements.evaluate({ user, event, context });
    if (!fresh.length) return;

    const now = new Date();
    const entries = fresh.map(id => ({ id, unlockedAt: now }));
    await User.updateOne({ username }, { $push: { achievements: { $each: entries } } });

    emitToUser(username, 'achievementUnlocked', {
      achievements: fresh.map(id => achievements.catalogueEntry(id))
    });
    // The member may well be offline (a story published while they slept) —
    // the push says a badge happened, never what it is for.
    pushIfOffline(username, 'system', 'SYSTEM');
  } catch (err) {
    console.error('achievement award error:', err?.message || err);
  }
}

// ---------- LFG ----------
const lfg = createLfgRouter({
  User,
  matchStyles,
  requireUser: sessions.requireUser,
  // The board is ambient: everyone's copy refreshes the moment anybody flips
  // a toggle, like presence does.
  broadcast: entries => io.emit('lfgBoard', entries)
});
app.use('/api/lfg', lfg.router);

// ---------- CHALLENGES ----------
app.use('/api/challenge', createChallengeRouter({
  Challenge,
  User,
  Room,
  DM,
  mongoose,
  matchStyles,
  requireUser: sessions.requireUser,
  emitToUser: (...args) => emitToUser(...args),
  deliverToUser: (...args) => deliverToUser(...args),
  forwardDMToDiscord,
  io,
  onAchievement: awardAchievements
}).router);

// ---------- MATCH RECORD ----------
// The engine hook below needs the same "persist + move the counters" path the
// confirmation flow uses, so the router hands it back.
const matchHistoryApi = createMatchHistoryRouter({
  MatchRecord,
  User,
  DM,
  matchStyles,
  requireUser: sessions.requireUser,
  emitToUser: (...args) => emitToUser(...args),
  deliverToUser: (...args) => deliverToUser(...args),
  onAchievement: awardAchievements
});
app.use('/api/matches', matchHistoryApi.router);

/**
 * Record a match the embedded dice engine just decided, and tell both
 * fighters. Only engine-decided finishes are recorded automatically: the
 * winner of a manually ended game is a caller-supplied name, and a record
 * nobody can vouch for is exactly what the confirmation flow exists to
 * prevent.
 */
function recordEngineMatch(game, result) {
  const players = Array.from(game.players);
  if (players.length !== 2) return Promise.resolve(null);

  let winner = null;
  let loser = null;
  const draw = !!result.tie;
  if (draw) {
    // both survived to a double KO
  } else if (result.won) {
    winner = result.playerId;
    loser = players.find(p => p !== result.playerId) || null;
  } else if (result.lost) {
    loser = result.playerId;
    winner = players.find(p => p !== result.playerId) || null;
  } else {
    return Promise.resolve(null);
  }

  const match = {
    winner,
    loser,
    draw,
    styles: ['dice'],
    bestOf: 1,
    source: 'engine',
    status: 'confirmed',
    room: game.id && mongoose.Types.ObjectId.isValid(game.id) ? game.id : null,
    notes: 'HP dice match',
    // The winner's HP when the match ended — the Ironman achievement reads it.
    closingHp: winner === result.playerId && hpIsNumber(result.updatedHealth) ? result.updatedHealth : null
  };

  return matchHistoryApi.recordConfirmedMatch(match)
    .then(recorded => {
      const view = matchHistoryApi.serializeMatch(recorded, winner);
      [winner, loser].forEach(name => {
        if (!name) return;
        emitToUser(name, 'matchRecorded', matchHistoryApi.serializeMatch(recorded, name));
      });
      return view;
    })
    .catch(err => console.error('engine match record error:', err?.message || err));
}

/** Nudge the player whose turn a dice match just became. */
function notifyMatchTurn(username, mover) {
  if (!username || username === mover) return;
  const reached = emitToUser(username, 'matchTurn', { mover });
  if (reached === 0) pushIfOffline(username, 'match', mover);
}

// ---------- REACTIONS ----------
app.use('/api/reactions', reactions.createReactionsRouter({
  Reaction,
  requireUser: sessions.requireUser,
  io
}).router);

// Reactions are metadata on messages, and messages are pruned on a retention
// window; a reaction that outlives its message is garbage, so it gets the
// same window (mirroring the sweep retention.js runs, on its own timer
// because the retention job's model list is fixed at creation).
setInterval(() => {
  Reaction.deleteMany({ time: { $lt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) } })
    .catch(err => console.error('reaction sweep error:', err?.message || err));
}, 6 * 60 * 60 * 1000).unref();

// ---------- BOOKMARKS ----------
// A bookmark saves the message's text at save time: the retention sweep will
// eventually delete the message itself, and the member's copy is meant to
// outlive it.
app.get('/api/bookmarks', sessions.requireUser, async (req, res) => {
  try {
    const bookmarks = await Bookmark.find({ username: req.username })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    res.json({ ok: true, bookmarks });
  } catch (err) {
    console.error('bookmark list error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/bookmarks', sessions.requireUser, async (req, res) => {
  const scope = req.body?.scope === 'room' ? 'room' : 'public';
  const room = scope === 'room' ? String(req.body?.room || '') : '';
  const messageId = String(req.body?.messageId || '');
  if (!reactions.validTarget({ scope, room, messageId })) {
    return res.status(400).json({ ok: false, error: 'invalid_target' });
  }

  try {
    // The saved text is read from the stored message, never trusted from the
    // request — a bookmark is evidence the member chose to keep, and the
    // client's copy of the text is not authoritative.
    let message = null;
    if (scope === 'public') {
      message = await PublicMessage.findById(messageId).lean();
    } else {
      const roomRecord = await Room.findById(room).lean();
      if (!canAccessRoom(roomRecord, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_your_room' });
      }
      message = await RoomMessage.findOne({ _id: messageId, room }).lean();
    }
    if (!message) return res.status(404).json({ ok: false, error: 'not_found' });

    const bookmark = await Bookmark.findOneAndUpdate(
      { username: req.username, scope, room, messageId },
      {
        $set: {
          from: message.from || '',
          text: String(message.text || '').slice(0, 300),
          time: message.time || null
        }
      },
      { upsert: true, new: true }
    ).lean();

    res.status(201).json({ ok: true, bookmark });
  } catch (err) {
    console.error('bookmark save error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.delete('/api/bookmarks/:id', sessions.requireUser, async (req, res) => {
  try {
    const result = await Bookmark.deleteOne({ _id: req.params.id, username: req.username });
    res.json({ ok: true, removed: result.deletedCount || 0 });
  } catch (err) {
    console.error('bookmark delete error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- ACHIEVEMENTS ----------
app.get('/api/achievements', sessions.requireUser, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.username })
      .select('username wins losses achievements')
      .lean();
    if (!user) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({
      ok: true,
      ...achievements.catalogueView(user),
      record: { wins: user.wins || 0, losses: user.losses || 0 }
    });
  } catch (err) {
    console.error('achievements error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- NOTIFICATION PREFERENCES ----------
app.get('/api/notification-prefs', sessions.requireUser, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.username }).select('notificationPrefs quietHours').lean();
    if (!user) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({
      ok: true,
      prefs: notificationPrefs.effectivePrefs(user),
      quietHours: notificationPrefs.effectiveQuietHours(user)
    });
  } catch (err) {
    console.error('notification-prefs read error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/notification-prefs', sessions.requireUser, async (req, res) => {
  const prefs = notificationPrefs.normalizePrefs(req.body?.prefs);
  if (!prefs.ok) return res.status(400).json({ ok: false, error: prefs.error });
  const quiet = notificationPrefs.normalizeQuietHours(req.body?.quietHours);
  if (!quiet.ok) return res.status(400).json({ ok: false, error: quiet.error });

  try {
    await User.updateOne(
      { username: req.username },
      { $set: { notificationPrefs: prefs.prefs, quietHours: quiet.quiet } }
    );
    res.json({ ok: true, prefs: prefs.prefs, quietHours: quiet.quiet });
  } catch (err) {
    console.error('notification-prefs save error:', err?.message || err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- REPORTS ----------
// Reports are filed by members, so they are throttled like the other
// member-facing write paths rather than left open to flooding. Mounted before
// the router so a flood is cut off before any handler runs.
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/report', reportLimiter);

// Reports land in the admin queue and — when the support webhook is
// configured — in the same Discord channel the assistance popup documents.
// The dispatch must never fail the filing: the queue row is already saved.
app.use('/api/report', createReportsRouter({
  Report,
  requireUser: sessions.requireUser,
  requireAdmin,
  dispatchReport: async report => {
    const summary = summarizeForDispatch(report);
    if (DISCORD_SUPPORT_URL) {
      await fetch(DISCORD_SUPPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'MCF Reports',
          content: [
            `**${summary}**`,
            report.snippet ? `> ${report.snippet}` : '',
            report.details ? report.details : ''
          ].filter(Boolean).join('\n')
        })
      });
    }
    await sendAdminEmail(`Report: ${summary}`, {
      text: [
        summary,
        report.snippet ? `Snippet: ${report.snippet}` : '',
        report.details ? `Details: ${report.details}` : ''
      ].filter(Boolean).join('\n')
    });
  }
}).router);

// ---------- SOCKET.IO ----------

// Directed DM delivery (per-user socket rooms) and the server-side unread
// counts the client is sent on connect. Split into its own module so the
// rules can be tested without a running deployment; see dmDelivery.js.
/**
 * Deliver to a member's live sessions — and when there are none, push instead.
 *
 * `emitToUser` returns how many sockets it reached, so 0 means the member is
 * not here: the tab is closed, the laptop is asleep, the phone is in a pocket.
 * That is exactly when a DM bridged in from Discord or a story waiting for
 * approval used to disappear without a trace, because the unread badge is only
 * fed by a live socket and the reconnect catch-up only runs when they come back
 * on their own. This is the hook that brings them back.
 *
 * Only `privateMessage` pushes. Presence, typing and room events are ambient —
 * notifying on those would be noise, and a member who is not connected is not
 * missing anything they would want woken for.
 *
 * The message text is never included; see pushNotifications.js.
 */
function deliverToUser(username, event, payload) {
  const reached = emitToUser(username, event, payload);

  if (reached === 0 && event === 'privateMessage' && push.configured) {
    const sender = payload && payload.from;
    const isSystem = !sender || String(sender).toUpperCase() === 'SYSTEM';
    push
      .notify({ to: username, from: sender, kind: isSystem ? 'system' : 'dm' })
      .catch(err => console.error('push notify error:', err.message || err));
  }

  return reached;
}

const { userRoom, emitToUser, markDMRead, getUnreadDMCounts, liveSocketCount } =
  createDmDelivery({ User, DM, io });

// Room access is enforced on the server. The room list is only a UI aid and
// must never be treated as authorization, since clients can emit socket events
// directly.
function canAccessRoom(room, username) {
  if (!room || !username) return false;
  if (!room.private) return true;

  const normalizedUsername = String(username).trim().toLowerCase();
  return String(room.owner || '').trim().toLowerCase() === normalizedUsername
    || (Array.isArray(room.invitedUsers) && room.invitedUsers.some(invited =>
      String(invited).trim().toLowerCase() === normalizedUsername
    ));
}

// ---------- SOCKET AUTHENTICATION ----------
// A socket is identified once, at handshake, from the same session token the
// HTTP API uses. `auth.token` covers clients that are not same-origin with the
// API (the Electron and Capacitor wrappers point at the Railway host, where a
// cookie for the site domain is not sent); otherwise the session cookie the
// browser attaches to the handshake request is enough and no client code has to
// change.
//
// Before this, `socket.username` came from whatever the browser chose to emit,
// so any visitor could join another member's delivery room and receive their
// DMs. Now an unauthenticated socket has no username at all: it can still read
// the public arena, but every handler that acts on a member checks first.
function tokenFromHandshake(socket) {
  const auth = socket.handshake?.auth;
  if (auth && typeof auth.token === 'string' && auth.token) return auth.token;

  const cookieHeader = socket.handshake?.headers?.cookie;
  if (typeof cookieHeader === 'string') {
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE_NAME) {
        try { return decodeURIComponent(rest.join('=')); } catch (_) { return rest.join('='); }
      }
    }
  }
  return null;
}

io.use((socket, next) => {
  const token = tokenFromHandshake(socket);
  if (!token) return next(); // anonymous: public chat is readable when signed out

  sessions.verifyToken(token)
    .then(found => {
      if (found) {
        socket.username = found.username;
        socket.sessionUser = found.user;
        socket.sessionToken = token;
      } else {
        // Not worth dropping the connection over: the client is told on connect
        // so it can clear a stale local session and prompt a login, while the
        // public arena keeps working.
        socket.authRejected = true;
      }
      next();
    })
    .catch(err => {
      console.error('socket auth error:', err.message || err);
      socket.authRejected = true;
      next();
    });
});

/**
 * Bring an authenticated socket into the member's live state: join the delivery
 * room its DMs are sent to, mark the member online, and hand back anything that
 * arrived while no session of theirs was connected.
 *
 * Every await is guarded — this runs inside an async socket handler, where a
 * rejection that escapes is an unhandled rejection and ends the process rather
 * than just this connection.
 */
async function attachSocketSession(socket) {
  const username = socket.username;
  if (!username) return null;

  socket.join(userRoom(username));

  let user = null;
  try {
    user = await User.findOneAndUpdate(
      { username },
      { online: true, socketId: socket.id, lastSeenAt: new Date() },
      { new: true }
    );
  } catch (err) {
    console.error('socket login error:', err.message || err);
    return null;
  }
  if (!user) {
    // The account went away (deleted, or banned and removed) between the
    // handshake and now — do not keep a socket claiming it.
    socket.username = null;
    return null;
  }

  try {
    await broadcastPresence();
  } catch (err) {
    console.error('presence broadcast error:', err.message || err);
  }

  try {
    const counts = await getUnreadDMCounts(user);
    if (Object.keys(counts).length) socket.emit('dmUnread', { counts });
  } catch (err) {
    console.error('dm unread catch-up error:', err.message || err);
  }

  return user;
}

/**
 * The username this socket is allowed to act as. Handlers call this instead of
 * reading a name out of the event payload, which is the whole point: the
 * payload is data, the handshake is identity.
 */
function actor(socket) {
  return socket.username || null;
}

/**
 * Refuse an action from a socket with no verified session, and say so, so the
 * client can react instead of watching nothing happen.
 */
function requireActor(socket, action) {
  const username = actor(socket);
  if (!username) {
    socket.emit('actionRejected', { action, reason: 'auth_required' });
    return null;
  }
  return username;
}

io.on("connection", async (socket) => {
  console.log("socket connected", socket.id);

  // Every await in this handler needs its own guard. The handler is async, so a
  // rejection that escapes it is an unhandled rejection — and on Node 15+ that
  // ends the process. An unreachable database therefore used to turn one
  // browser connecting into a full outage: the site stopped serving every other
  // member too, and (in testing) the preview died seconds after the page opened.
  try {
    socket.emit("roomsList", await Room.find().lean());
  } catch (err) {
    console.error('initial room list error:', err.message || err);
  }

  try {
    socket.emit('forumsList', await getForumsWithReplyCounts());
  } catch (err) {
    console.error('initial forum list error:', err);
  }
  // A socket that authenticated at handshake is signed in from the moment it
  // connects; nothing has to be emitted to claim an identity.
  if (socket.username) {
    await attachSocketSession(socket);
  } else if (socket.authRejected) {
    socket.emit('auth:invalid', { reason: 'invalid_session' });
  }

  // Kept for clients that connect before signing in: the page is already open,
  // the member then logs in, and the socket picks the session up without a
  // reconnect. The payload is a token — a username in it is ignored, because
  // the point of the handshake is that a client cannot name itself.
  socket.on('login', async (payload) => {
    const token = typeof payload === 'string' ? payload : payload?.token;

    if (token) {
      const found = await sessions.verifyToken(token).catch(err => {
        console.error('socket login verify error:', err.message || err);
        return null;
      });
      if (!found) {
        socket.emit('auth:invalid', { reason: 'invalid_session' });
        return;
      }
      socket.username = found.username;
      socket.sessionUser = found.user;
      socket.sessionToken = token;
      socket.authRejected = false;
    }

    if (!socket.username) return;
    await attachSocketSession(socket);
  });

  // Signing out ends this socket's authenticated state without dropping the
  // connection, so the member can keep reading the arena.
  socket.on('logout', async () => {
    const username = socket.username;
    socket.username = null;
    socket.sessionUser = null;
    socket.sessionToken = null;
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      socket.currentRoom = null;
    }
    if (username) {
      socket.leave(userRoom(username));
      try {
        const survivor = [...io.sockets.sockets.values()].find(s => s.username === username);
        await User.findOneAndUpdate(
          { username },
          survivor
            ? { socketId: survivor.id, lastSeenAt: new Date() }
            : { online: false, socketId: null, lastSeenAt: new Date() }
        );
        await broadcastPresence();
      } catch (err) {
        console.error('socket logout error:', err.message || err);
      }
    }
  });

  // The client reports a conversation as read when it opens a DM window or
  // renders an incoming message into one.
  socket.on("dmRead", async ({ partner } = {}) => {
    // Whose read receipt this is comes from the handshake. Marking a
    // conversation read for another member used to be possible by naming them.
    const who = requireActor(socket, 'dmRead');
    if (!who || !partner) return;
    try {
      await markDMRead(who, partner);
    } catch (err) {
      console.error('dmRead error:', err);
    }
  });

  // The member closed the chat, so only the member who closed it goes offline.
  socket.on("chatClosed", async () => {
    const username = requireActor(socket, 'chatClosed');
    if (!username) return;

    await User.findOneAndUpdate(
      { username },
      { online: false, lastSeenAt: new Date() }
    );

    const onlineUsers = await User.find({ online: true })
      .select("username display imageUrl extraPhotos info wins losses color language age height weight lastSeenAt lfg achievements createdAt -_id")
      .lean();

    io.emit("presence", onlineUsers);
  });

  // A client asking to be signed out. Only this socket is dropped; the
  // member's other sessions stay signed in.
  socket.on("forceLogout", async () => {
    const username = requireActor(socket, 'forceLogout');
    socket.username = null;
    socket.sessionUser = null;
    socket.sessionToken = null;
    if (!username) return;

    socket.leave(userRoom(username));

    const survivor = [...io.sockets.sockets.values()].find(s => s.username === username);
    await User.findOneAndUpdate(
      { username },
      survivor
        ? { socketId: survivor.id, lastSeenAt: new Date() }
        : { online: false, socketId: null, lastSeenAt: new Date() }
    );

    const onlineUsers = await User.find({ online: true })
      .select("username display imageUrl extraPhotos info wins losses color language age height weight lastSeenAt lfg achievements createdAt -_id")
      .lean();

    io.emit("presence", onlineUsers);
  });

socket.on('publicMessage', async (msg) => {
  try {
    // Posting to the arena is a member action: an anonymous socket is refused
    // and told why, rather than the message being silently dropped.
    const from = requireActor(socket, 'publicMessage');
    if (!from) return;

    // The display name comes from the account, not the payload, so a message
    // cannot be dressed up as somebody else's.
    const display = socket.sessionUser?.display || from;

    // Any Discord invite posted in chat is rewritten to the site's official
    // invite before the message is stored, relayed to Discord, or delivered.
    const enriched = {
      from,
      display,
      text: rewriteDiscordInvites(msg.text),
      replyTo: msg.replyTo || null,
      time: new Date()
    };

    const created = await PublicMessage.create(enriched);

    // ⭐ Fetch sender avatar ONCE
    const sender = await User.findOne({ username: from }).lean();
    const avatarUrl = sender?.imageUrl || null;

    // ⭐ Send Discord webhook
    // Discord only shows an avatar when its servers can fetch the image at
    // send time — raw third-party links (and senders with no photo at all)
    // silently fall back to the default gray avatar. Serve the avatar from
    // this site instead: uploaded photos through the /img proxy, and a
    // generated initials-on-profile-color PNG for photoless senders, so the
    // Discord channel matches the website's chat.
    const baseUrl = publicBaseUrlFromSocket(socket, APP_BASE_URL);
    await sendDiscordWebhookMessage(
      display,
      enriched.text,
      resolveWebhookAvatarUrl({
        username: msg.from,
        sender,
        baseUrl,
        proxyImage: url => {
          const target = parseProxyTarget(url);
          return target
            ? `${baseUrl}/img?u=${encodeURIComponent(target.href)}`
            : null;
        }
      })
    );

    // ⭐ @name in the arena pings that member
    // A mention is a notification, so the block rules apply: a member who
    // blocked the sender is skipped (resolveMentions checks), and the sender
    // never pings themselves. The push stays content-free like every push.
    try {
      const mentioned = await resolveMentions({ text: enriched.text, from, User });
      mentioned.forEach(name => {
        const reached = emitToUser(name, 'mentioned', {
          by: from,
          byDisplay: display,
          where: 'arena',
          messageId: String(created._id)
        });
        if (reached === 0) pushIfOffline(name, 'mention', display);
      });
    } catch (err) {
      console.error('mention notify error:', err?.message || err);
    }

    // ⭐ Fetch fresh online users right before emitting
    const onlineUsers = await User.find({ online: true }).lean();

    // ⭐ Use Promise.all to await all translations in parallel
    await Promise.all(
      onlineUsers.map(async u => {
        if (!u.socketId) return; // Skip if no active socket

        // The sender always sees exactly what they typed — never a translation
        // of their own message back into their profile language.
        const isSender = u.username === from;
        const translated = isSender ? enriched.text : await translateText(enriched.text, u.language || "en");

        io.to(u.socketId).emit("publicMessage", {
          ...enriched,
          _id: created._id,
          text: translated,
          avatar: avatarUrl
        });
      })
    );

  } catch (err) {
    console.error("Error in publicMessage:", err);
  }
});

// Edit an existing public message (author only). Broadcasts the new text
// translated for each recipient, matching how new messages are delivered.
socket.on("editPublicMessage", async (data) => {
  try {
    const { id, text } = data || {};
    const from = requireActor(socket, 'editPublicMessage');
    if (!id || !from || typeof text !== "string" || !text.trim()) return;

    const msg = await PublicMessage.findById(id);
    // The author check compares against the handshake identity, so an edit
    // cannot be authorised by claiming the author's name in the payload.
    if (!msg || msg.from !== from) return; // only the author may edit

    // Edits re-run the invite rewrite: a foreign Discord invite must not
    // sneak into history by editing it into an old message.
    msg.text = rewriteDiscordInvites(text.trim());
    msg.edited = true;
    await msg.save();

    const onlineUsers = await User.find({ online: true }).lean();
    await Promise.all(onlineUsers.map(async u => {
      if (!u.socketId) return;
      // The author sees the edit exactly as they typed it.
      const isAuthor = u.username === from;
      const translated = isAuthor ? msg.text : await translateText(msg.text, u.language || "en");
      io.to(u.socketId).emit("publicMessageEdited", {
        _id: id,
        text: translated,
        edited: true
      });
    }));
  } catch (err) {
    console.error("editPublicMessage error:", err);
  }
});


  // WebRTC signaling: relay offers, answers, and ICE candidates only to the intended user.
  socket.on("audio-call-signal", async ({ to, kind, offer, answer, candidate } = {}) => {
    if (!to || !kind || !socket.username) {
      console.log(`[audio-call] signal dropped: to=${to} kind=${kind} caller=${socket.username || "(not logged in)"}`);
      return;
    }
    const target = await User.findOne({ username: to }).lean();
    if (target?.socketId) {
      io.to(target.socketId).emit("audio-call-signal", {
        from: socket.username, kind, offer, answer, candidate
      });
    } else {
      console.log(`[audio-call] ${socket.username} -> ${to}: ${kind} dropped, callee offline or no socketId`);
    }
  });

  socket.on("room-audio-invite", async ({ room } = {}) => {
    if (!room || !socket.username || !socket.rooms.has(room)) return;
    socket.to(room).emit("room-audio-invite", { room, from: socket.username });
  });

  socket.on("room-audio-join", async ({ room, to } = {}) => {
    if (!room || !to || !socket.username || !socket.rooms.has(room)) return;
    const target = await User.findOne({ username: to }).lean();
    if (target?.socketId) io.to(target.socketId).emit("room-audio-join", { room, from: socket.username });
  });

  socket.on("audio-call-end", async ({ to } = {}) => {
    if (!to || !socket.username) return;
    const target = await User.findOne({ username: to }).lean();
    if (target?.socketId) io.to(target.socketId).emit("audio-call-end", { from: socket.username });
  });

  socket.on("privateMessage", async pm => {
    // A DM is sent by whoever is signed in on this socket. `pm.from` is ignored
    // entirely: it used to be the sender's name as the browser typed it, which
    // meant any visitor could message anyone as anyone.
    const from = requireActor(socket, "privateMessage");
    if (!from) return;

    const receiver = await User.findOne({ username: pm.to }).lean();

    // ✅ FIXED: Check receiver.blockedUsers instead of undefined targetUser
    if (receiver?.blockedUsers?.includes(from)) {
      console.log(`DM blocked: ${from} → ${pm.to}`);
      return; // do NOT deliver the DM
    }

    if (!receiver) {
      socket.emit("pmError", { reason: "User not found" });
      return;
    }

    // IMAGE MESSAGE
    if (pm.imageUrl) {
      const saved = await DM.create({
        from,
        to: pm.to,
        imageUrl: pm.imageUrl,
        text: null,
        originalText: null
      });

      const imagePayload = {
        id: String(saved._id),
        from,
        to: pm.to,
        imageUrl: pm.imageUrl,
        time: saved.time
      };

      // One emit per user room: the recipient's other sessions and the
      // sender's own echo both need it, and neither should depend on which
      // single socket the user document happens to remember.
      // The recipient gets a push when no session of theirs is live; the
      // sender's own echo does not, since they are obviously here.
      deliverToUser(pm.to, "privateMessage", imagePayload);
      emitToUser(from, "privateMessage", imagePayload);

      await forwardDMToDiscord(from, receiver, `[Image attachment: ${pm.imageUrl}]`);

      return;
    }

    // CLIP MESSAGE (GIF / short video, served from our /clips route)
    if (pm.clipUrl) {
      if (!isLocalClipUrl(pm.clipUrl)) return; // reject foreign URLs

      const saved = await DM.create({
        from,
        to: pm.to,
        clipUrl: pm.clipUrl,
        clipType: pm.clipType === "gif" ? "gif" : "video",
        type: "clip",
        text: null,
        originalText: null
      });

      const clipPayload = {
        id: String(saved._id),
        from,
        to: pm.to,
        clipUrl: saved.clipUrl,
        clipType: saved.clipType,
        time: saved.time
      };

      deliverToUser(pm.to, "privateMessage", clipPayload);
      emitToUser(from, "privateMessage", clipPayload);

      let appBaseUrl = APP_BASE_URL || "https://male-cyber-fighters.com";
      await forwardDMToDiscord(from, receiver, `[Video/GIF attachment: ${appBaseUrl}${saved.clipUrl}]`);

      return;
    }

    // TEXT MESSAGE
    // DMs pass through the same invite rewrite as the rooms: a foreign
    // Discord invite is rewritten to the site's official invite everywhere.
    const safeText = rewriteDiscordInvites(pm.text);
    const translated = await translateText(safeText, receiver.language || "en");

    const saved = await DM.create({
      from,
      to: pm.to,
      originalText: safeText,
      text: translated
    });

    const messageTime = saved.time;
    const messageId = String(saved._id);

    // Recipient sees the translation, sender sees exactly what they typed.
    deliverToUser(pm.to, "privateMessage", {
      id: messageId,
      from,
      to: pm.to,
      text: translated,
      time: messageTime
    });

    emitToUser(from, "privateMessage", {
      id: messageId,
      from,
      to: pm.to,
      text: safeText,
      time: messageTime
    });

    await forwardDMToDiscord(from, receiver, translated || safeText);
  });

  socket.on("joinRoom", async ({ room } = {}) => {
    // Rooms are member spaces, and `canAccessRoom` decides by username — which
    // is only meaningful once that username came from a verified session.
    if (!requireActor(socket, "joinRoom")) return;
    const roomId = room == null ? "" : String(room);
    if (!roomId) return;
    if (!mongoose.Types.ObjectId.isValid(roomId)) {
      socket.emit("roomJoinDenied", { room: roomId, reason: "room_not_found" });
      return;
    }

    const roomRecord = await Room.findById(roomId).lean();
    if (!roomRecord) {
      socket.emit("roomJoinDenied", { room: roomId, reason: "room_not_found" });
      return;
    }
    if (!canAccessRoom(roomRecord, socket.username)) {
      socket.emit("roomJoinDenied", { room: roomId, reason: "not_invited" });
      return;
    }

    // A kicked member cannot come straight back in — only the owner's
    // un-kick reopens the door. (The owner themselves can never be kicked.)
    if (
      roomRecord.owner !== socket.username &&
      (roomRecord.kicked || []).some(name => String(name).toLowerCase() === String(socket.username).toLowerCase())
    ) {
      socket.emit("roomJoinDenied", { room: roomId, reason: "kicked" });
      return;
    }

    // A socket can only be a member of the room it currently has open.
    // Leave the previous room before joining another one so its member list
    // is updated immediately instead of retaining a stale user.
    const previousRoom = socket.currentRoom;
    if (previousRoom && previousRoom !== roomId) {
      socket.leave(previousRoom);
      socket.currentRoom = null;
      // Announce the leave only when this was the user's last session in the
      // room (another tab / the phone may still be in it).
      if (!(await roomHasUser(previousRoom, socket.username))) {
        announceRoomSystemMessage(previousRoom, socket.username, "leave");
      }
      // Do not delay the new join while refreshing the old room.
      updateRoomMembers(previousRoom);
    }

    // Announce the join only when the user was not already in the room from
    // another session, so opening a second tab doesn't repeat the notice.
    const alreadyInRoom = await roomHasUser(roomId, socket.username);

    socket.join(roomId);
    socket.currentRoom = roomId;

    const history = await RoomMessage.find({ room: roomId }).sort({ time: 1 }).limit(200).lean();
    io.to(socket.id).emit("roomHistory", { room: roomId, history });

    await updateRoomMembers(roomId);

    if (!alreadyInRoom) {
      announceRoomSystemMessage(roomId, socket.username, "join");
    }
  });

  // Remove this socket from a room when its chat window closes.
  socket.on("leaveRoom", async ({ room } = {}) => {
    if (!requireActor(socket, "leaveRoom")) return;
    const roomId = room == null || room === "" ? socket.currentRoom : String(room);
    if (!roomId) return;

    socket.leave(roomId);
    if (socket.currentRoom === roomId) socket.currentRoom = null;

    if (!(await roomHasUser(roomId, socket.username))) {
      announceRoomSystemMessage(roomId, socket.username, "leave");
    }
    await updateRoomMembers(roomId);
  });

  // Allow clients to request a members refresh for a room (client emits "requestRoomMembers")
  socket.on("requestRoomMembers", async ({ room }) => {
    if (!requireActor(socket, "requestRoomMembers")) return;
    try {
      const roomId = room == null ? "" : String(room);
      if (!roomId || !socket.rooms.has(roomId)) return;
      await updateRoomMembers(roomId);
    } catch (err) {
      console.error("requestRoomMembers handler error:", err);
    }
  });

  socket.on("roomMessage", async (msg = {}) => {
    if (!requireActor(socket, "roomMessage")) return;
    const roomId = msg.room == null ? "" : String(msg.room);
    // Do not trust the room/from fields supplied by the browser. A sender
    // must have successfully joined this exact room first.
    if (!roomId || socket.currentRoom !== roomId || !socket.rooms.has(roomId)) return;

    const roomRecord = await Room.findById(roomId).lean();
    if (!canAccessRoom(roomRecord, socket.username)) return;

    // ---------- OWNER MODERATION, enforced server-side ----------
    // The owner's mute / slow-mode settings are checked on every message, so
    // a client that ignores the UI still cannot shout over them. Usernames
    // may contain "." / "$" which Mongo map keys may not — same normalisation
    // the dmSeen map uses.
    const moderationKey = name => String(name).replace(/[.$]/g, '_');
    const mutedUntil = roomRecord.muted ? roomRecord.muted[moderationKey(socket.username)] : null;
    if (mutedUntil && new Date(mutedUntil) > new Date()) {
      socket.emit('roomMessageRejected', {
        room: roomId,
        reason: 'muted',
        until: mutedUntil
      });
      return;
    }
    if (roomRecord.slowModeMs > 0) {
      // The member's previous message in this room decides the wait — one
      // indexed query, not a per-room timer the server has to maintain.
      const last = await RoomMessage.findOne({ room: roomId, from: socket.username })
        .sort({ time: -1 })
        .limit(1)
        .select('time')
        .lean();
      if (last) {
        const elapsed = Date.now() - new Date(last.time).getTime();
        if (elapsed < roomRecord.slowModeMs) {
          socket.emit('roomMessageRejected', {
            room: roomId,
            reason: 'slow_mode',
            retryAfterMs: roomRecord.slowModeMs - elapsed
          });
          return;
        }
      }
    }


    // Clips may only be attached when the browser uploaded them through
    // /api/upload-clip, which always returns same-origin /clips URLs.
    const clipUrl = isLocalClipUrl(msg.clipUrl) ? msg.clipUrl : null;

    const enriched = {
      room: roomId,
      from: socket.username,
      // From the account, not the payload — see publicMessage.
      display: socket.sessionUser?.display || socket.username,
      // Any Discord invite posted in a room is rewritten to the site's
      // official invite before it is stored or relayed to other members.
      text: msg.text ? rewriteDiscordInvites(msg.text) : null,
      imageUrl: msg.imageUrl || null,
      clipUrl,
      clipType: clipUrl ? (msg.clipType === "gif" ? "gif" : "video") : null,
      replyTo: msg.replyTo || null,
      time: new Date()
    };

    let created = null;
    try {
      created = await RoomMessage.create(enriched);
    } catch (err) {
      console.error("Failed to save room message:", err);
    }

    // Same mention rules as the arena, scoped to the room the message landed
    // in — a match room is exactly where "@jobber get up" belongs.
    try {
      const mentioned = await resolveMentions({ text: enriched.text || '', from: socket.username, User });
      mentioned.forEach(name => {
        const reached = emitToUser(name, 'mentioned', {
          by: socket.username,
          byDisplay: enriched.display,
          where: roomRecord.name || roomId,
          room: roomId,
          messageId: created ? String(created._id) : null
        });
        if (reached === 0) pushIfOffline(name, 'mention', enriched.display);
      });
    } catch (err) {
      console.error('room mention notify error:', err?.message || err);
    }

    const members = await io.in(roomId).fetchSockets();

    // Image and clip messages carry no translatable text — deliver as-is.
    if (msg.imageUrl || clipUrl) {
      members.forEach(member => {
        io.to(member.id).emit("roomMessage", {
          ...enriched,
          _id: created?._id
        });
      });
      return;
    }

    members.forEach(async member => {
      const live = io.sockets.sockets.get(member.id) || member;
      const memberUsername = live?.username || member?.username ||
        (live?.handshake?.auth && live.handshake.auth.username) || null;

      // The sender always sees exactly what they typed — never a translation
      // of their own message back into their profile language.
      if (memberUsername && memberUsername === socket.username) {
        io.to(member.id).emit("roomMessage", {
          ...enriched,
          _id: created?._id,
          text: enriched.text
        });
        return;
      }

      const recipient = await User.findOne({ socketId: member.id }).lean();
      const translated = await translateText(enriched.text, recipient?.language || "en");

      io.to(member.id).emit("roomMessage", {
        ...enriched,
        _id: created?._id,
        text: translated
      });
    });
  });

  // Edit an existing room message (author only). Broadcasts the new text
  // translated for each recipient, matching how room messages are delivered.
  socket.on("editRoomMessage", async (data) => {
    try {
      const { id, text } = data || {};
      if (!requireActor(socket, "editRoomMessage")) return;
      if (!id || typeof text !== "string" || !text.trim()) return;

      const msg = await RoomMessage.findById(id);
      if (!msg || msg.from !== socket.username || socket.currentRoom !== msg.room
        || !socket.rooms.has(msg.room)) return; // only the author may edit

      // Edits re-run the invite rewrite, same as public-message edits.
      msg.text = rewriteDiscordInvites(text.trim());
      msg.edited = true;
      await msg.save();

      const members = await User.find({ socketId: { $ne: null } }).lean();
      members.forEach(async u => {
        // The author sees the edit exactly as they typed it.
        const isAuthor = u.username === socket.username;
        const translated = isAuthor ? msg.text : await translateText(msg.text, u.language || "en");
        io.to(u.socketId).emit("roomMessageEdited", {
          room: msg.room,
          _id: id,
          text: translated,
          edited: true
        });
      });
    } catch (err) {
      console.error("editRoomMessage error:", err);
    }
  });

  // The "who is typing" name is the sender's, taken from the handshake, so a
  // typing notice cannot be shown under somebody else's name.
  socket.on("typingDM", ({ to }) => {
    const from = requireActor(socket, "typingDM");
    if (!from) return;
    const target = [...io.sockets.sockets.values()].find(s => s.username === to);
    if (target) {
      io.to(target.id).emit("typingDM", { from });
    }
  });

  socket.on("stopTypingDM", ({ to }) => {
    const from = requireActor(socket, "stopTypingDM");
    if (!from) return;
    const target = [...io.sockets.sockets.values()].find(s => s.username === to);
    if (target) {
      io.to(target.id).emit("stopTypingDM", { from });
    }
  });

  socket.on("typingRoom", ({ room } = {}) => {
    if (!requireActor(socket, "typingRoom")) return;
    const roomId = room == null ? "" : String(room);
    if (roomId && socket.currentRoom === roomId && socket.rooms.has(roomId)) {
      socket.to(roomId).emit("typingRoom", { from: socket.username, room: roomId });
    }
  });

  socket.on("stopTypingRoom", ({ room } = {}) => {
    if (!requireActor(socket, "stopTypingRoom")) return;
    const roomId = room == null ? "" : String(room);
    if (roomId && socket.currentRoom === roomId && socket.rooms.has(roomId)) {
      socket.to(roomId).emit("stopTypingRoom", { from: socket.username, room: roomId });
    }
  });

  socket.on("createRoom", async ({ name, private }) => {
    if (!requireActor(socket, "createRoom")) return;
    if (!name) return;

    const room = await Room.create({
      name,
      private: !!private,
      owner: socket.username,
      invitedUsers: [],
      createdAt: new Date()
    });

    socket.join(room._id.toString());

    const rooms = await Room.find().lean();
    io.emit("roomsList", rooms);
  });

  socket.on("inviteToRoom", async ({ roomId, username }) => {
    if (!requireActor(socket, "inviteToRoom")) return;
    const room = await Room.findById(roomId);
    if (!room) return;

    if (room.owner !== socket.username) return;

    if (!room.invitedUsers.includes(username)) {
      room.invitedUsers.push(username);
      await room.save();
    }

    const targetSocket = [...io.sockets.sockets.values()]
      .find(s => s.username === username);

    if (targetSocket) {
      targetSocket.emit("roomInvited", {
        roomId,
        roomName: room.name
      });
    }

    const rooms = await Room.find().lean();
    io.emit("roomsList", rooms);
  });


  // ---------- REACTIONS ----------
  // Toggle one member's emoji on one message. The toggle resolves on the
  // server (reactions.js) so the broadcast is the shared truth, and the
  // message has to exist — otherwise reaction rows could be minted against
  // ids that were never messages.
  socket.on('setReaction', async (data = {}) => {
    const username = requireActor(socket, 'setReaction');
    if (!username) return;

    const scope = data.scope === 'room' ? 'room' : 'public';
    const room = scope === 'room' ? String(data.room || '') : '';
    const messageId = String(data.id || data.messageId || '');
    if (!reactions.validTarget({ scope, room, messageId })) return;

    try {
      if (scope === 'public') {
        const message = await PublicMessage.findById(messageId).select('_id').lean();
        if (!message) return;
      } else {
        const roomRecord = await Room.findById(room).lean();
        if (!canAccessRoom(roomRecord, username)) return;
        const message = await RoomMessage.findOne({ _id: messageId, room }).select('_id').lean();
        if (!message) return;
      }

      const filter = { scope, room, messageId, username };
      const existing = await Reaction.findOne(filter).lean();
      const toggle = reactions.resolveToggle({
        current: existing ? existing.emoji : '',
        emoji: data.emoji
      });

      if (toggle.op === 'invalid') {
        socket.emit('actionRejected', { action: 'setReaction', reason: 'invalid_emoji' });
        return;
      }
      if (toggle.op === 'remove') await Reaction.deleteOne(filter);
      else if (toggle.op === 'set') {
        await Reaction.updateOne(filter, { $set: { emoji: toggle.emoji } }, { upsert: true });
      } else {
        return; // nothing to remove, nothing changed
      }

      const rows = await Reaction.find({ scope, room, messageId }).select('emoji username').lean();
      const payload = {
        scope,
        room,
        messageId,
        counts: reactions.aggregate(rows).counts,
        reactor: username
      };
      if (scope === 'room') io.to(room).emit('reactionUpdate', payload);
      else io.emit('reactionUpdate', payload);
    } catch (err) {
      console.error('setReaction error:', err?.message || err);
    }
  });

  // ---------- DM EDIT / DELETE ----------
  // Public and room messages have been editable by their author for a while;
  // DMs had no such control. Editing is bounded to a short window (a DM is
  // the other member's conversation too — see dmDelivery.js), deletion is
  // not: on an 18+ site "take that back" is a safety feature, and the
  // tombstone keeps both feeds honest that a message existed.
  socket.on('editDM', async (data = {}) => {
    const username = requireActor(socket, 'editDM');
    if (!username) return;

    try {
      const msg = await DM.findById(String(data.id || ''));
      if (!msg || !canEditDM(msg, username)) {
        socket.emit('dmError', { action: 'editDM', reason: 'cannot_edit' });
        return;
      }

      const text = rewriteDiscordInvites(String(data.text || '').trim());
      if (!text) return;

      const partner = msg.to === username ? msg.from : msg.to;
      const partnerUser = await User.findOne({ username: partner }).lean();

      // The recipient reads the translation, the author their own words —
      // exactly how a fresh DM is delivered.
      const translated = await translateText(text, partnerUser?.language || 'en');
      msg.text = translated;
      msg.originalText = text;
      msg.edited = true;
      await msg.save();

      const base = { id: String(msg._id), from: msg.from, to: msg.to, edited: true };
      emitToUser(partner, 'dmEdited', { ...base, text: translated });
      emitToUser(username, 'dmEdited', { ...base, text });
    } catch (err) {
      console.error('editDM error:', err?.message || err);
    }
  });

  socket.on('deleteDM', async (data = {}) => {
    const username = requireActor(socket, 'deleteDM');
    if (!username) return;

    try {
      const msg = await DM.findById(String(data.id || ''));
      if (!msg || !canDeleteDM(msg, username)) {
        socket.emit('dmError', { action: 'deleteDM', reason: 'cannot_delete' });
        return;
      }

      msg.deleted = true;
      msg.text = null;
      msg.originalText = null;
      msg.imageUrl = null;
      msg.clipUrl = null;
      await msg.save();

      const payload = { id: String(msg._id), from: msg.from, to: msg.to, deleted: true };
      emitToUser(msg.to, 'dmDeleted', payload);
      emitToUser(msg.from, 'dmDeleted', payload);
    } catch (err) {
      console.error('deleteDM error:', err?.message || err);
    }
  });

  // ---------- ROOM OWNER MODERATION ----------
  // kick / unkick / mute / unmute / slow mode. Every action is owner-only,
  // enforced here — the client UI is just a convenience.
  socket.on('roomModerate', async (data = {}) => {
    const username = requireActor(socket, 'roomModerate');
    if (!username) return;

    try {
      const roomId = String(data.room || '');
      if (!roomId || !mongoose.Types.ObjectId.isValid(roomId)) return;

      const room = await Room.findById(roomId);
      if (!room) return;
      if (room.owner !== username) {
        socket.emit('actionRejected', { action: 'roomModerate', reason: 'not_room_owner' });
        return;
      }

      const action = String(data.action || '');
      const target = String(data.target || '').trim();
      // Usernames may contain "." / "$" which Mongo map keys may not.
      const key = String(target).replace(/[.$]/g, '_');
      let notice = null;

      if (action === 'kick' || action === 'unkick') {
        if (!target || target === username) return; // the owner cannot kick themselves
        if (action === 'kick' && !room.kicked.includes(target)) room.kicked.push(target);
        if (action === 'unkick') room.kicked = room.kicked.filter(name => name !== target);
        await room.save();

        if (action === 'kick') {
          // Every live session of the member leaves the room now, and is told
          // why — a silent ejection looks like a bug.
          const roomIdStr = String(room._id);
          for (const s of io.sockets.sockets.values()) {
            if (s.username === target && s.rooms.has(roomIdStr)) {
              s.leave(roomIdStr);
              if (s.currentRoom === roomIdStr) s.currentRoom = null;
              s.emit('roomKicked', { room: roomIdStr, roomName: room.name, by: username });
            }
          }
          io.to(roomIdStr).emit('roomMessage', {
            room: roomIdStr,
            from: 'SYSTEM',
            display: null,
            text: `${target} was removed from the room by the owner`,
            type: 'system',
            time: new Date()
          });
          updateRoomMembers(roomIdStr);
        }
        notice = { action, target };
      } else if (action === 'mute' || action === 'unmute') {
        if (!target) return;
        const muted = { ...(room.muted || {}) };
        if (action === 'mute') {
          const seconds = Math.min(Math.max(Number(data.seconds) || 300, 60), 24 * 60 * 60);
          muted[key] = new Date(Date.now() + seconds * 1000);
        } else {
          delete muted[key];
        }
        room.muted = muted;
        await room.save();
        notice = { action, target, until: muted[key] || null };
      } else if (action === 'slow') {
        const ms = Math.min(Math.max(Number(data.slowModeMs) || 0, 0), 60 * 1000);
        room.slowModeMs = ms;
        await room.save();
        notice = { action, slowModeMs: ms };
      } else {
        return;
      }

      io.to(String(room._id)).emit('roomModeration', { room: String(room._id), by: username, ...notice });

      // The owner's panel (and everyone's rooms sidebar) caches room docs off
      // the roomsList broadcast — refresh it so kicked lists and slow mode
      // stay honest everywhere.
      try {
        io.emit('roomsList', await Room.find().lean());
      } catch (err) {
        console.error('room moderation rooms broadcast error:', err?.message || err);
      }
    } catch (err) {
      console.error('roomModerate error:', err?.message || err);
    }
  });

  socket.on('disconnect', async () => {
    // 'disconnect' fires after socket.io has already dropped this socket from
    // its rooms, so anything still listed here is another session of the same
    // user (a second tab, the desktop app, the phone). Only mark the user
    // offline once their last session is gone, and move `socketId` — which the
    // audio-call signalling still uses — onto a socket that is actually alive.
    const survivor = socket.username
      ? [...io.sockets.sockets.values()].find(s => s.username === socket.username)
      : null;

    const u = survivor
      ? await User.findOneAndUpdate(
        { username: socket.username },
        { online: true, socketId: survivor.id, lastSeenAt: new Date() }
      )
      : await User.findOneAndUpdate(
        { socketId: socket.id },
        { online: false, socketId: null, lastSeenAt: new Date() }
      );

    if (u && !survivor) {
      const onlineUsers = await User.find({ online: true })
        .select('username display imageUrl extraPhotos info wins losses color language age height weight lastSeenAt lfg achievements createdAt -_id')
        .lean();

      io.emit('presence', onlineUsers);
    }

    if (socket.currentRoom) {
      // Announce the leave only when no other session of this user remains in
      // the room. (By the time 'disconnect' fires, this socket has already been
      // removed from its rooms, so roomHasUser sees only the survivors.)
      if (!(await roomHasUser(socket.currentRoom, socket.username))) {
        announceRoomSystemMessage(socket.currentRoom, socket.username, "leave");
      }
      updateRoomMembers(socket.currentRoom);
    }

    console.log('socket disconnected', socket.id);
  });
});

const setupDiscordListener = require('./setupDiscordListener');
// deliverToUser rather than emitToUser, so a DM bridged in from Discord while
// the member is offline reaches them as a push.
setupDiscordListener(User, DM, translateText, deliverToUser, sendDiscordDM, discordEvents, rehostImageToImgBB);

// ---------- START ----------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://localhost:${PORT}`);

  // Say what will be pruned and what will not, so the window is visible in the
  // host's log rather than buried in the environment.
  const rc = retention.config;
  const days = value => (value > 0 ? `${value}d` : 'kept forever');
  console.log(
    `retention: arena ${days(rc.publicMessageDays)}, rooms ${days(rc.roomMessageDays)}, ` +
    `ip-log ${days(rc.ipLogDays)}, reset-tokens ${days(rc.passwordResetDays)}, ` +
    `dms ${days(rc.dmDays)} — sweeping every ${rc.intervalHours}h`
  );
  retention.start();
});
