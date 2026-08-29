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
const rateLimit = require('express-rate-limit');
const cors = require("cors");
const { sendMail, mailerConfigured, MAIL_FROM, escapeHtml } = require('./mailer');
const { sendDiscordDM, discordEvents } = require('./discordBot');

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

// Public base URL used when building the password-reset link in emails.
// Defaults to the request origin when not set (see getBaseUrl()).
const APP_BASE_URL = process.env.APP_BASE_URL || null;
// How long a password-reset link stays valid.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour



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

app.get('/', (req, res, next) => {
  const cssFile = isMobileClient(req) ? 'mobile.css' : 'desktop.css';
  const indexPath = path.join(__dirname, 'public', 'index.html');

  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return next(err);

    const page = html.replace(
      /<link\s+rel=["']stylesheet["']\s+href=["'][^"']*\/css\/[^"']+["']\s*>/i,
      `<link rel="stylesheet" href="/css/${cssFile}?v=9">`
    );

    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Accept-CH': 'Sec-CH-UA-Mobile',
      'Vary': 'User-Agent, Sec-CH-UA-Mobile'
    });

    res.send(page);
  });
});

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
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const upstream = await fetch(target.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some CDNs reject requests without a browser-ish UA / Accept header.
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
        'User-Agent': 'Mozilla/5.0 (compatible; MaleCyberFighters/1.0; +https://malecyberfighters.com)'
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
    console.error('image proxy error', err.message || err);
    sendPlaceholderImage(res, 502);
  } finally {
    clearTimeout(timeout);
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
app.use(cors({ origin: true, credentials: true }));
// Request client hints so modern browsers will include Sec-CH-UA-Mobile on subsequent navigations.
// This improves server-side mobile detection without relying solely on User-Agent sniffing.
app.use((req, res, next) => {
  res.set('Accept-CH', 'Sec-CH-UA-Mobile');
  next();
});

// ---------- DB ----------
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.warn('MongoDB connection failed (continuing without DB):', err.message || err));

// ---------- SCHEMAS ----------
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, index: true },
  email:    { type: String, unique: true, required: true, index: true },
  passwordHash: { type: String, required: true },
  display:  { type: String },
  age:      { type: Number },
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
  blockedUsers: { type: [String], default: [] },
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
  createdAt: { type: Date, default: Date.now }
});

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
  // system / approval / normal
  type: { type: String, default: "normal" }, 
  // values:
  // "normal"        → regular DM
  // "image"         → image DM
  // "clip"          → GIF / short video DM
  // "storyApproval" → approval request DM
  // "system"        → system notifications

  // timestamp
  time: { type: Date, default: Date.now }
});

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

  const payload = {
    username: username || "Chat Message",
    content: message,
    avatar_url: avatarUrl || ""
  };

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
    // the syntax instead of letting a bare reply bounce. System notices have no
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

app.post("/api/story/save", async (req, res) => {
  const { owner, partner, story, title } = req.body;
  // Optional clip attached to the story — must point at our own /clips route.
  const clipUrl = isLocalClipUrl(req.body.clipUrl) ? req.body.clipUrl : null;

  const saved = await Story.create({
    owner,
    partner,
    title: title || "",
    story,
    clipUrl,
    clipType: clipUrl ? (req.body.clipType === "gif" ? "gif" : "video") : null,
    approvalOwner: true,
    approvalPartner: false,
    approved: false
  });

  const storyTitle = saved.title || "Untitled story";
  const partnerUser = await User.findOne({ username: partner }).lean();

  // If partner is online → real-time popup
  if (partnerUser?.socketId) {
    io.to(partnerUser.socketId).emit("storyApprovalRequest", {
      storyId: saved._id,
      from: owner,
      title: saved.title
    });
  } else {
    // If partner is offline → send DM notification
    let dmText = `${owner} created a story involving your messages: "${storyTitle}". Please approve it.`;
    await DM.create({
      from: "SYSTEM",
      to: partner,
      text: dmText,
      type: "storyApproval",
      storyId: saved._id,
      time: new Date()
    });
    const partnerUserDoc = await User.findOne({ username: partner }).lean();
    await forwardDMToDiscord("SYSTEM", partnerUserDoc, dmText);
  }

  res.json({ ok: true, storyId: saved._id });
});


app.post("/api/story/approve", async (req, res) => {
  const { storyId } = req.body;

  const story = await Story.findById(storyId);
  if (!story) return res.json({ ok: false });

  story.approvalPartner = true;

  if (story.approvalOwner && story.approvalPartner) {
    story.approved = true;
  }

  await story.save();

  res.json({ ok: true, approved: story.approved, title: story.title });
});

app.get("/api/story/pending", async (req, res) => {
  const { username } = req.query;

  // Pending stories for both sides: the owner (approvalOwner) who created
  // the story and the partner (approvalPartner) who still has to approve it.
  const stories = await Story.find({
    $or: [{ owner: username }, { partner: username }],
    approved: false
  }).sort({ createdAt: -1 }).lean();

  res.json({ ok: true, stories });
});

app.post("/api/story/resend", async (req, res) => {
  const { storyId } = req.body;

  const story = await Story.findById(storyId);
  if (!story) return res.json({ ok: false });

  const partnerUser = await User.findOne({ username: story.partner }).lean();
  if (partnerUser?.socketId) {
    io.to(partnerUser.socketId).emit("storyApprovalRequest", {
      storyId,
      from: story.owner,
      title: story.title
    });
  }

  res.json({ ok: true });
});

app.post("/api/relationship/request", async (req, res) => {
  const { requester, target, type } = req.body;

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

app.post("/api/relationship/approve", async (req, res) => {
  const { relationshipId } = req.body;

  const rel = await Relationship.findById(relationshipId);
  if (!rel) return res.json({ ok: false });

  rel.approvedTarget = true;

  if (rel.approvedRequester && rel.approvedTarget) {
    rel.approved = true;
  }

  await rel.save();

  res.json({ ok: true, approved: rel.approved });
});

app.get("/api/relationship/list", async (req, res) => {
  const { username } = req.query;

  const rels = await Relationship.find({
    approved: true,
    $or: [
      { requester: username },
      { target: username }
    ]
  }).lean();

  res.json({ ok: true, relationships: rels });
});

app.get("/api/relationship/pending", async (req, res) => {
  const { username } = req.query;

  const rels = await Relationship.find({
    requester: username,
    approved: false
  }).lean();

  res.json({ ok: true, relationships: rels });
});

// ---------- API: RELATIONSHIP TIMELINE ----------
app.get("/api/relationship/timeline", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.json({ ok: false, error: "missing_username" });
  }

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

app.post("/api/block-user", async (req, res) => {
  const { username, target } = req.body;

  if (!username || !target) {
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

app.post("/api/unblock-user", async (req, res) => {
  const { username, target } = req.body;

  if (!username || !target) {
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

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY || req.get("x-admin-key") !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: "admin_denied" });
  }
  next();
}

async function broadcastPresence() {
  const onlineUsers = await User.find({ online: true })
    .select("username display imageUrl extraPhotos info wins losses color language age createdAt -_id")
    .lean();

  io.emit("presence", onlineUsers);
}

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await User.find()
      .select("username display email imageUrl extraPhotos info stats color language age role banned online createdAt")
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

    if (banned && previousSocketId) {
      io.to(previousSocketId).emit("forceLogout", { reason: "banned" });
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

app.post("/api/story/load", async (req, res) => {
  const { a, b, fromDate } = req.body;

  const messages = await DM.find({
    $or: [
      { from: a, to: b },
      { from: b, to: a }
    ],
    time: { $gte: new Date(fromDate) }
  }).sort({ time: 1 }).lean();

  res.json({ ok: true, messages });
});


app.get("/api/story/list", async (req, res) => {
  const { username } = req.query;

  // Approved stories are saved to both profiles: the owner (approvalOwner)
  // and the partner (approvalPartner) each see the story on their profile.
  const stories = await Story.find({
    $or: [{ owner: username }, { partner: username }],
    approved: true
  }).sort({ createdAt: -1 }).lean();

  res.json({ ok: true, stories });
});

// Public archives: every approved story from every member
app.get("/api/story/archives", async (req, res) => {
  const stories = await Story.find({ approved: true })
    .sort({ createdAt: -1 })
    .lean();

  res.json({ ok: true, stories });
});


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

app.post("/api/send-dm", async (req, res) => {
  const { from, to, text } = req.body;

  const dm = await DM.create({
    from,
    to,
    text,
    time: new Date(),
    type: "supportReport"
  });

  const target = await User.findOne({ username: to }).lean();

  if (target?.socketId) {
    io.to(target.socketId).emit("privateMessage", dm);
  }

  await forwardDMToDiscord(from, target, text);

  res.json({ ok: true });
});

// ---------- API: PUBLIC CHAT HISTORY ----------
app.get("/api/public-messages", async (req, res) => {
  try {
    // Fetch the latest 200 records, then restore chronological display order.
    // Sorting ascending before limiting returned the oldest 200 forever, so
    // new messages did not change the response and browsers kept seeing 304.
    const messages = (await PublicMessage
      .find({})
      .sort({ time: -1 })
      .limit(200)
      .lean())
      .reverse();

    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({ ok: true, messages });
  } catch (err) {
    console.error("load public messages error:", err);
    res.status(500).json({ ok: false });
  }
});

// ---------- API: IMAGE UPLOAD ----------
// Used for avatars and chat attachments. Extra profile photos use the
// dedicated endpoint below so their URLs are persisted to the user document
// as part of the same request.
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
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
app.post('/api/upload-clip', (req, res, next) => {
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
app.get('/api/profile/photos', async (req, res) => {
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

app.post('/api/profile/photos', (req, res) => {
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

    const username = String(req.body.username || '').trim();
    const files = Array.isArray(req.files) ? req.files : [];

    if (!username) {
      return res.status(400).json({ ok: false, error: 'missing_username' });
    }
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

app.delete('/api/profile/photos', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const photoUrl = String(req.body.photoUrl || '').trim();

  if (!username || !photoUrl) {
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
app.post('/api/update-profile', async (req, res) => {
  const { username, updates } = req.body;

  if (!username) {
    return res.status(400).json({ ok: false, error: 'missing_username' });
  }

  try {
    const user = await User.findOneAndUpdate(
      { username },
      updates,
      { new: true, runValidators: true }
    ).select('-passwordHash');

    if (!user) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    return res.json({ ok: true, user });

  } catch (e) {
    console.error('update-profile error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: ACCOUNT SETTINGS - CHANGE PASSWORD ----------
app.post('/api/account/change-password', async (req, res) => {
  const { username, currentPassword, newPassword } = req.body;

  if (!username || !currentPassword || !newPassword) {
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

    await logIp(req, { action: 'change_password', username });

    return res.json({ ok: true });
  } catch (e) {
    console.error('change-password error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- API: ACCOUNT SETTINGS - DELETE ACCOUNT ----------
app.post('/api/account/delete', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
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
  if (!username || !email || !password) {
    await logIp(req, { action: 'register_fail', username });
    return res.status(400).json({ ok: false, error: 'missing_fields' });
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

    const user = new User({
      username,
      email,
      passwordHash: hash,
      display: display || username,
      age: age ? Number(age) : undefined,
      stats: stats || {},
      info: info || '',
      color: color || '',
      language: language || 'en',
      imageUrl: imageUrl || ''
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
        extraPhotos: user.extraPhotos || []
      }
    });
  } catch (e) {
    console.error('register error', e);
    await logIp(req, { action: 'register_error', username });
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

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

    return res.json({
      ok: true,
      user: {
        username: user.username,
        display: user.display,
        imageUrl: user.imageUrl,
        extraPhotos: user.extraPhotos || [],
        color: user.color,
        language: user.language,
        role: user.role,
        stats: user.stats,
        info: user.info,
        age: user.age
      }
    });
  } catch (e) {
    console.error(e);
    await logIp(req, { action: 'login_error', username });
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
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
app.post("/api/chatMessage", async (req, res) => {
  try {
    const { username, message, timestamp, avatar } = req.body;
    const attachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
    const imageUrl = req.body.imageUrl || req.body.image || req.body.image_url ||
      attachments.find(a => a && (a.url || a.proxy_url) && String(a.content_type || a.contentType || "").startsWith("image/"))?.url ||
      attachments.find(a => a && (a.url || a.proxy_url))?.url ||
      attachments.find(a => a && (a.url || a.proxy_url))?.proxy_url ||
      null;

    if (!username || (!message && !imageUrl)) {
      return res.status(400).json({ error: "Username and message are required" });
    }

    const msgTimestamp = timestamp ? new Date(timestamp) : new Date();

    const enriched = {
      from: username,
      display: username,
      text: message || "",
      imageUrl: imageUrl || null,
      time: msgTimestamp
    };

    await PublicMessage.create(enriched);

    io.emit("externalPublicMessage", {
      from: username,
      display: username,
      text: message || "",
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

app.post("/api/dm/history", async (req, res) => {
  const { a, b } = req.body;

 const messages = await DM.find({
  $or: [
    { from: a, to: b },
    { from: b, to: a },
    { from: "SYSTEM", to: a },
    { from: "SYSTEM", to: b }
  ]
})
.sort({ time: 1 })
.lean();

  res.json({ ok: true, messages });
});

app.post("/api/dm/partners", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.json({ ok: false, partners: [] });
  }

  const messages = await DM.find({
    $or: [
      { from: username },
      { to: username }
    ]
  }).lean();

  const partners = new Set();

  messages.forEach(m => {
    if (m.from !== username) partners.add(m.from);
    if (m.to !== username) partners.add(m.to);
  });

  res.json({ ok: true, partners: [...partners] });
});

app.post("/api/dm/clear", async (req, res) => {
  const { a, b } = req.body;

  if (!a || !b) {
    return res.json({ ok: false, error: "missing_users" });
  }

  await DM.deleteMany({
    $or: [
      { from: a, to: b },
      { from: b, to: a }
    ]
  });

  res.json({ ok: true });
});

app.get("/api/allUsers", async (req, res) => {
  try {
    const users = await User.find()
      .select("username display imageUrl extraPhotos info wins losses color language age createdAt")
      .lean();

    res.json({ success: true, users });
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

    return res.status(201).json({ ok: true, reply: savedReply });
  } catch (err) {
    console.error('create forum reply error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});


// ---------- SOCKET.IO ----------
const onlineByUsername = new Map();

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

io.on("connection", async (socket) => {
  console.log("socket connected", socket.id);

  const rooms = await Room.find().lean();
  socket.emit("roomsList", rooms);

  try {
    socket.emit('forumsList', await getForumsWithReplyCounts());
  } catch (err) {
    console.error('initial forum list error:', err);
  }

  socket.on('login', async (user) => {
    socket.username = user.username;
    const u = await User.findOneAndUpdate(
      { username: user.username },
      { online: true, socketId: socket.id },
      { new: true }
    );
    if (!u) return;

    const onlineUsers = await User.find({ online: true })
      .select('username display imageUrl extraPhotos info wins losses color language age createdAt -_id')
      .lean();

    io.emit('presence', onlineUsers);
  });

  socket.on("chatClosed", async ({ username }) => {
    if (!username) return;

    await User.findOneAndUpdate(
      { username },
      { online: false }
    );

    const onlineUsers = await User.find({ online: true })
      .select("username display imageUrl extraPhotos info wins losses color language age createdAt -_id")
      .lean();

    io.emit("presence", onlineUsers);
  });

  socket.on("forceLogout", async ({ username }) => {
    if (!username) return;

    await User.findOneAndUpdate(
      { username },
      { online: false, socketId: null }
    );

    const onlineUsers = await User.find({ online: true })
      .select("username display imageUrl extraPhotos info wins losses color language age createdAt -_id")
      .lean();

    io.emit("presence", onlineUsers);
  });

socket.on('publicMessage', async (msg) => {
  try {
    const enriched = {
      from: msg.from,
      display: msg.display,
      text: msg.text,
      replyTo: msg.replyTo || null,
      time: new Date()
    };

    const created = await PublicMessage.create(enriched);

    // ⭐ Fetch sender avatar ONCE
    const sender = await User.findOne({ username: msg.from }).lean();
    const avatarUrl = sender?.imageUrl || null;

    // ⭐ Send Discord webhook
    await sendDiscordWebhookMessage(
      msg.display || msg.from,
      msg.text,
      avatarUrl
    );

    // ⭐ Fetch fresh online users right before emitting
    const onlineUsers = await User.find({ online: true }).lean();

    // ⭐ Use Promise.all to await all translations in parallel
    await Promise.all(
      onlineUsers.map(async u => {
        if (!u.socketId) return; // Skip if no active socket
        
        const translated = await translateText(enriched.text, u.language || "en");

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
    const { id, from, text } = data || {};
    if (!id || !from || typeof text !== "string" || !text.trim()) return;

    const msg = await PublicMessage.findById(id);
    if (!msg || msg.from !== from) return; // only the author may edit

    msg.text = text.trim();
    msg.edited = true;
    await msg.save();

    const onlineUsers = await User.find({ online: true }).lean();
    await Promise.all(onlineUsers.map(async u => {
      if (!u.socketId) return;
      const translated = await translateText(msg.text, u.language || "en");
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
    const sender = await User.findOne({ username: pm.from }).lean();
    const receiver = await User.findOne({ username: pm.to }).lean();

    // ✅ FIXED: Check receiver.blockedUsers instead of undefined targetUser
    if (receiver?.blockedUsers?.includes(pm.from)) {
      console.log(`DM blocked: ${pm.from} → ${pm.to}`);
      return; // do NOT deliver the DM
    }

    if (!receiver) {
      socket.emit("pmError", { reason: "User not found" });
      return;
    }

    // IMAGE MESSAGE
    if (pm.imageUrl) {
      const saved = await DM.create({
        from: pm.from,
        to: pm.to,
        imageUrl: pm.imageUrl,
        text: null,
        originalText: null
      });

      if (receiver.socketId) {
        io.to(receiver.socketId).emit("privateMessage", {
          from: pm.from,
          to: pm.to,
          imageUrl: pm.imageUrl,
          time: saved.time
        });
      }

      if (sender.socketId) {
        io.to(sender.socketId).emit("privateMessage", {
          from: pm.from,
          to: pm.to,
          imageUrl: pm.imageUrl,
          time: saved.time
        });
      }

      await forwardDMToDiscord(pm.from, receiver, `[Image attachment: ${pm.imageUrl}]`);

      return;
    }

    // CLIP MESSAGE (GIF / short video, served from our /clips route)
    if (pm.clipUrl) {
      if (!isLocalClipUrl(pm.clipUrl)) return; // reject foreign URLs

      const saved = await DM.create({
        from: pm.from,
        to: pm.to,
        clipUrl: pm.clipUrl,
        clipType: pm.clipType === "gif" ? "gif" : "video",
        type: "clip",
        text: null,
        originalText: null
      });

      const clipPayload = {
        from: pm.from,
        to: pm.to,
        clipUrl: saved.clipUrl,
        clipType: saved.clipType,
        time: saved.time
      };

      if (receiver.socketId) io.to(receiver.socketId).emit("privateMessage", clipPayload);
      if (sender.socketId) io.to(sender.socketId).emit("privateMessage", clipPayload);

      let appBaseUrl = APP_BASE_URL || "https://malecyberfighters.com";
      await forwardDMToDiscord(pm.from, receiver, `[Video/GIF attachment: ${appBaseUrl}${saved.clipUrl}]`);

      return;
    }

    // TEXT MESSAGE
    const translated = await translateText(pm.text, receiver.language || "en");

    const saved = await DM.create({
      from: pm.from,
      to: pm.to,
      originalText: pm.text,
      text: translated
    });

    if (receiver.socketId) {
      io.to(receiver.socketId).emit("privateMessage", {
        from: pm.from,
        to: pm.to,
        text: translated,
        time: saved.time
      });
    }

    if (sender.socketId) {
      io.to(sender.socketId).emit("privateMessage", {
        from: pm.from,
        to: pm.to,
        text: pm.text,
        time: saved.time
      });
    }

    await forwardDMToDiscord(pm.from, receiver, translated || pm.text);
  });

  socket.on("joinRoom", async ({ room } = {}) => {
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

    // A socket can only be a member of the room it currently has open.
    // Leave the previous room before joining another one so its member list
    // is updated immediately instead of retaining a stale user.
    const previousRoom = socket.currentRoom;
    if (previousRoom && previousRoom !== roomId) {
      socket.leave(previousRoom);
      socket.currentRoom = null;
      // Do not delay the new join while refreshing the old room.
      updateRoomMembers(previousRoom);
    }

    socket.join(roomId);
    socket.currentRoom = roomId;

    const history = await RoomMessage.find({ room: roomId }).sort({ time: 1 }).limit(200).lean();
    io.to(socket.id).emit("roomHistory", { room: roomId, history });

    await updateRoomMembers(roomId);
  });

  // Remove this socket from a room when its chat window closes.
  socket.on("leaveRoom", async ({ room } = {}) => {
    const roomId = room == null || room === "" ? socket.currentRoom : String(room);
    if (!roomId) return;

    socket.leave(roomId);
    if (socket.currentRoom === roomId) socket.currentRoom = null;
    await updateRoomMembers(roomId);
  });

  // Allow clients to request a members refresh for a room (client emits "requestRoomMembers")
  socket.on("requestRoomMembers", async ({ room }) => {
    try {
      const roomId = room == null ? "" : String(room);
      if (!roomId || !socket.rooms.has(roomId)) return;
      await updateRoomMembers(roomId);
    } catch (err) {
      console.error("requestRoomMembers handler error:", err);
    }
  });

  socket.on("roomMessage", async (msg = {}) => {
    const roomId = msg.room == null ? "" : String(msg.room);
    // Do not trust the room/from fields supplied by the browser. A sender
    // must have successfully joined this exact room first.
    if (!roomId || socket.currentRoom !== roomId || !socket.rooms.has(roomId)) return;

    const roomRecord = await Room.findById(roomId).lean();
    if (!canAccessRoom(roomRecord, socket.username)) return;

    // Clips may only be attached when the browser uploaded them through
    // /api/upload-clip, which always returns same-origin /clips URLs.
    const clipUrl = isLocalClipUrl(msg.clipUrl) ? msg.clipUrl : null;

    const enriched = {
      room: roomId,
      from: socket.username,
      display: msg.display,
      text: msg.text || null,
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
      if (!id || typeof text !== "string" || !text.trim()) return;

      const msg = await RoomMessage.findById(id);
      if (!msg || msg.from !== socket.username || socket.currentRoom !== msg.room
        || !socket.rooms.has(msg.room)) return; // only the author may edit

      msg.text = text.trim();
      msg.edited = true;
      await msg.save();

      const members = await User.find({ socketId: { $ne: null } }).lean();
      members.forEach(async u => {
        const translated = await translateText(msg.text, u.language || "en");
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

  socket.on("typingDM", ({ from, to }) => {
    const target = [...io.sockets.sockets.values()].find(s => s.username === to);
    if (target) {
      io.to(target.id).emit("typingDM", { from });
    }
  });

  socket.on("stopTypingDM", ({ from, to }) => {
    const target = [...io.sockets.sockets.values()].find(s => s.username === to);
    if (target) {
      io.to(target.id).emit("stopTypingDM", { from });
    }
  });

  socket.on("typingRoom", ({ room, from } = {}) => {
    const roomId = room == null ? "" : String(room);
    if (roomId && socket.currentRoom === roomId && socket.rooms.has(roomId)) {
      socket.to(roomId).emit("typingRoom", { from: socket.username, room: roomId });
    }
  });

  socket.on("stopTypingRoom", ({ room, from } = {}) => {
    const roomId = room == null ? "" : String(room);
    if (roomId && socket.currentRoom === roomId && socket.rooms.has(roomId)) {
      socket.to(roomId).emit("stopTypingRoom", { from: socket.username, room: roomId });
    }
  });

  socket.on("createRoom", async ({ name, private }) => {
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


  socket.on('disconnect', async () => {
    const u = await User.findOneAndUpdate(
      { socketId: socket.id },
      { online: false, socketId: null }
    );

    if (u) {
      const onlineUsers = await User.find({ online: true })
        .select('username display imageUrl extraPhotos info wins losses color language age createdAt -_id')
        .lean();

      io.emit('presence', onlineUsers);
    }

    if (socket.currentRoom) {
      updateRoomMembers(socket.currentRoom);
    }

    console.log('socket disconnected', socket.id);
  });
});

const setupDiscordListener = require('./setupDiscordListener');
setupDiscordListener(User, DM, translateText, io, sendDiscordDM, discordEvents);

// ---------- START ----------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
