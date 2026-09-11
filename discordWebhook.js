/**
 * Discord webhook helpers for the public-chat bridge.
 *
 * The public chat relays every message to a Discord channel through an
 * incoming webhook. Discord renders the `username` / `avatar_url` fields of
 * each execution, but an avatar only shows up when Discord's servers can
 * fetch the image at send time — a step that fails silently (message sent,
 * default gray avatar) whenever the image host is slow, blocks Discord's
 * fetcher, or the sender has no avatar at all. Users of this site always see
 * an avatar in the web chat — their photo, or the colored initials fallback —
 * so the bridge mirrors that:
 *
 *   1. uploaded avatars are served to Discord through this site's own
 *      /img proxy, so Discord fetches a same-origin, correctly-typed image
 *      instead of depending on a third-party CDN;
 *   2. senders without a photo get /avatar/<username>.png — a small PNG of
 *      their initial on their profile color, generated here with zero
 *      dependencies (Node's zlib is the only tool needed to write a PNG).
 *
 * Everything in this module is pure so it can be unit-tested without a
 * server; index.js injects the DB-dependent pieces.
 */

'use strict';

const zlib = require('zlib');

/* ------------------------------------------------------------------ */
/* Webhook payload                                                     */
/* ------------------------------------------------------------------ */

// Discord ignores unknown fields, but an empty-string avatar_url is worse
// than an absent one: it can be rejected or mask the webhook's configured
// default avatar. Only send the field when there is a URL to send.
function buildWebhookPayload(username, content, avatarUrl) {
  const payload = {
    username: String(username || '').trim() || 'Chat Message',
    content: String(content ?? '')
  };

  const avatar = String(avatarUrl || '').trim();
  if (avatar) payload.avatar_url = avatar;

  return payload;
}

/* ------------------------------------------------------------------ */
/* Base URL                                                            */
/* ------------------------------------------------------------------ */

// The public base URL of this deployment, as seen from the outside. Webhook
// avatars have to be absolute URLs that Discord's servers can reach, but the
// public-chat relay runs inside a socket handler where there is no Express
// request to derive the origin from. The socket's HTTP upgrade handshake
// carries the same headers (Origin, Host, X-Forwarded-Proto behind Railway's
// proxy), so the same value can be recovered from `socket.handshake.headers`.
function publicBaseUrlFromSocket(socket, appBaseUrl = process.env.APP_BASE_URL || null) {
  if (appBaseUrl) {
    const configured = String(appBaseUrl).trim().replace(/\/+$/, '');
    if (configured) return configured;
  }

  const headers = (socket && socket.handshake && socket.handshake.headers) || {};

  const origin = String(headers.origin || '').trim();
  if (/^https?:\/\/\S+$/i.test(origin)) return origin.replace(/\/+$/, '');

  const host = String(headers.host || '').trim();
  if (host) {
    const proto = String(headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    return `${proto === 'http' ? 'http' : 'https'}://${host}`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Avatar resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * The avatar_url to hand Discord for a public-chat message.
 *
 * @param {object}   options
 * @param {string}   options.username  sender's username (fallback identity)
 * @param {object}   options.sender    sender's user document (imageUrl, color…)
 * @param {string}   options.baseUrl   absolute base URL of this site, or null
 * @param {Function} options.proxyImage fn(url) -> proxied URL or null when the
 *                                     host is not one our /img proxy serves
 * @returns {string|null} absolute avatar URL, or null when nothing usable
 */
function resolveWebhookAvatarUrl({ username, sender, baseUrl, proxyImage }) {
  const imageUrl = String((sender && sender.imageUrl) || '').trim();

  if (/^https:\/\//i.test(imageUrl)) {
    if (baseUrl && typeof proxyImage === 'function') {
      const proxied = proxyImage(imageUrl);
      if (proxied) return proxied;
    }
    // Host the proxy does not serve (or no base URL): hand Discord the
    // original URL — the pre-bridge behaviour — rather than nothing.
    return imageUrl;
  }

  if (baseUrl && username) {
    return `${baseUrl}/avatar/${encodeURIComponent(username)}.png`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Initials fallback avatar (pure-JS PNG, no image libraries)          */
/* ------------------------------------------------------------------ */

// Classic 5x7 bitmap glyphs, one byte per row (5 high bits, MSB = leftmost
// pixel). Covers the characters usernames are made of; everything else
// falls back to '?'.
const GLYPHS = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '?': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04]
};

// The single letter shown on a fallback avatar. Website usernames are
// alphanumeric; display names can be anything, so anything the font cannot
// draw falls back to the first usable ASCII letter or '?'.
function avatarInitial(display, username) {
  const source = String(display || username || '?').trim();
  // Fold accents (é → e) so Latin names keep a recognizable letter.
  const folded = source.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const first = folded.charAt(0).toUpperCase();
  if (GLYPHS[first]) return first;

  // Try the first ASCII letter or digit anywhere in the name (skips emoji
  // and other characters the bitmap font cannot draw).
  const match = /[A-Za-z0-9]/.exec(folded.toUpperCase());
  const candidate = match ? match[0].toUpperCase() : '?';
  return GLYPHS[candidate] ? candidate : '?';
}

const DEFAULT_AVATAR_COLOR = '#1e3a5f'; // matches the site's fallback avatar bg

function parseHexColor(value) {
  const hex = String(value || '').trim().toLowerCase();
  const six = /^#?([0-9a-f]{6})$/.exec(hex);
  if (six) {
    const n = parseInt(six[1], 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  const three = /^#?([0-9a-f]{3})$/.exec(hex);
  if (three) {
    return three[1].split('').map(c => parseInt(c + c, 16));
  }
  const def = parseHexColor.cache = parseHexColor.cache || parseHexColor(DEFAULT_AVATAR_COLOR);
  return def;
}

// Perceived brightness (ITU-R BT.601) — decides whether the glyph reads
// better in white or in dark navy on the given background color.
function isLightColor(rgb) {
  const [r, g, b] = rgb;
  return 0.299 * r + 0.587 * g + 0.114 * b > 165;
}

// ---- PNG encoding (truecolor, 8-bit) ----------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Renders a fallback avatar: the user's initial in a 5x7 bitmap font, on a
 * subtle vertical gradient of their profile color. 128x128 truecolor PNG —
 * the size Discord asks avatars for, generated in a millisecond or two with
 * no image-library dependency.
 */
function renderInitialsAvatarPng(initial, colorHex, size = 128) {
  const glyph = GLYPHS[avatarInitial(initial, initial)] || GLYPHS['?'];
  const background = parseHexColor(colorHex);
  const glyphColor = isLightColor(background)
    ? [13, 23, 42]    // dark navy glyph on light backgrounds
    : [255, 255, 255]; // white glyph on dark backgrounds

  const dimension = Math.max(32, Math.min(512, Math.round(size) || 128));

  // Integer scale that keeps the glyph ~55% of the image height.
  const scale = Math.max(1, Math.floor(dimension * 0.55 / glyph.length));
  const glyphWidth = 5 * scale;
  const glyphHeight = glyph.length * scale;
  const x0 = Math.floor((dimension - glyphWidth) / 2);
  const y0 = Math.floor((dimension - glyphHeight) / 2);

  // Uncompressed scanlines: each row is a filter byte (0 = None) + RGB pixels.
  const raw = Buffer.alloc(dimension * (dimension * 3 + 1));
  let offset = 0;

  for (let y = 0; y < dimension; y++) {
    raw[offset++] = 0; // filter: None

    // Gradient: the profile color at the top, ~25% darker at the bottom.
    const shade = 1 - 0.25 * (y / (dimension - 1 || 1));
    const bgRow = [
      Math.round(background[0] * shade),
      Math.round(background[1] * shade),
      Math.round(background[2] * shade)
    ];

    const glyphRow = y >= y0 && y < y0 + glyphHeight
      ? Math.floor((y - y0) / scale)
      : -1;

    for (let x = 0; x < dimension; x++) {
      const on = glyphRow >= 0 &&
        x >= x0 && x < x0 + glyphWidth &&
        (glyph[glyphRow] >> (4 - Math.floor((x - x0) / scale)) & 1) === 1;

      const pixel = on ? glyphColor : bgRow;
      raw[offset++] = pixel[0];
      raw[offset++] = pixel[1];
      raw[offset++] = pixel[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dimension, 0);
  ihdr.writeUInt32BE(dimension, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = {
  buildWebhookPayload,
  publicBaseUrlFromSocket,
  resolveWebhookAvatarUrl,
  avatarInitial,
  renderInitialsAvatarPng,
  DEFAULT_AVATAR_COLOR
};
