/**
 * Tests for the public-chat → Discord webhook bridge helpers
 * (discordWebhook.js) and their wiring into index.js.
 *
 * Discord renders a webhook message's avatar only when its servers can fetch
 * the avatar_url at send time; a sender with no photo has no avatar_url at
 * all. The bridge therefore serves every avatar from this site — uploaded
 * photos through the /img proxy, photoless senders through the generated
 * /avatar/<username>.png — and never sends an empty avatar_url.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  buildWebhookPayload,
  publicBaseUrlFromSocket,
  resolveWebhookAvatarUrl,
  avatarInitial,
  renderInitialsAvatarPng,
  DEFAULT_AVATAR_COLOR
} = require('../discordWebhook');

const ROOT = path.join(__dirname, '..');
const INDEX_SOURCE = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

const socketWithHeaders = headers => ({ handshake: { headers } });

/* ------------------------ webhook payload --------------------------- */

test('payload includes avatar_url only when there is one to send', () => {
  assert.deepEqual(
    buildWebhookPayload('Rex', 'hello', 'https://example.com/a.png'),
    { username: 'Rex', content: 'hello', avatar_url: 'https://example.com/a.png' }
  );

  // An empty-string avatar_url can be rejected by Discord and masks the
  // webhook's configured default avatar — it must be omitted, not sent.
  assert.deepEqual(
    buildWebhookPayload('Rex', 'hello', ''),
    { username: 'Rex', content: 'hello' }
  );
  assert.deepEqual(
    buildWebhookPayload('Rex', 'hello', null),
    { username: 'Rex', content: 'hello' }
  );
  assert.deepEqual(
    buildWebhookPayload('Rex', 'hello', '   '),
    { username: 'Rex', content: 'hello' }
  );
});

test('payload falls back to a default username and keeps content verbatim', () => {
  assert.equal(buildWebhookPayload('', 'hi', null).username, 'Chat Message');
  assert.equal(buildWebhookPayload(null, 'hi').username, 'Chat Message');
  assert.equal(buildWebhookPayload('Rex', 'hi **there**').content, 'hi **there**');
});

/* ------------------------ base URL from socket ----------------------- */

test('APP_BASE_URL wins over headers and loses its trailing slash', () => {
  assert.equal(
    publicBaseUrlFromSocket(socketWithHeaders({ origin: 'https://other.example' }), 'https://male-cyber-fighters.com/'),
    'https://male-cyber-fighters.com'
  );
});

test('base URL falls back to the socket Origin header', () => {
  assert.equal(
    publicBaseUrlFromSocket(socketWithHeaders({ origin: 'https://male-cyber-fighters.com' })),
    'https://male-cyber-fighters.com'
  );
});

test('base URL derives host + protocol from the handshake behind a proxy', () => {
  assert.equal(
    publicBaseUrlFromSocket(socketWithHeaders({ host: 'male-cyber-fighters.com', 'x-forwarded-proto': 'https' })),
    'https://male-cyber-fighters.com'
  );
  // Proxies chain values left-to-right; the first entry is the client's scheme.
  assert.equal(
    publicBaseUrlFromSocket(socketWithHeaders({ host: 'app.up.railway.app', 'x-forwarded-proto': 'https,http' })),
    'https://app.up.railway.app'
  );
  assert.equal(
    publicBaseUrlFromSocket(socketWithHeaders({ host: 'localhost:3000', 'x-forwarded-proto': 'http' })),
    'http://localhost:3000'
  );
  // No proto information: assume TLS — every production deployment is proxied.
  assert.equal(
    publicBaseUrlFromSocket(socketWithHeaders({ host: 'example.com' })),
    'https://example.com'
  );
});

test('base URL is null when nothing usable is available', () => {
  assert.equal(publicBaseUrlFromSocket(null), null);
  assert.equal(publicBaseUrlFromSocket(socketWithHeaders({})), null);
  // A malformed origin must not be used verbatim.
  assert.equal(publicBaseUrlFromSocket(socketWithHeaders({ origin: 'javascript:alert(1)' })), null);
});

/* ------------------------ avatar resolution -------------------------- */

const proxyImageOk = url => `https://male-cyber-fighters.com/img?u=${encodeURIComponent(url)}`;
const proxyImageNever = () => null;
const BASE = 'https://male-cyber-fighters.com';

test('an uploaded avatar is served through the site image proxy', () => {
  assert.equal(
    resolveWebhookAvatarUrl({
      username: 'rex',
      sender: { imageUrl: 'https://i.ibb.co/abc/avatar.jpg' },
      baseUrl: BASE,
      proxyImage: proxyImageOk
    }),
    'https://male-cyber-fighters.com/img?u=https%3A%2F%2Fi.ibb.co%2Fabc%2Favatar.jpg'
  );
});

test('a host the proxy cannot serve falls back to the original URL', () => {
  assert.equal(
    resolveWebhookAvatarUrl({
      username: 'rex',
      sender: { imageUrl: 'https://example.com/avatar.png' },
      baseUrl: BASE,
      proxyImage: proxyImageNever
    }),
    'https://example.com/avatar.png'
  );
});

test('without a base URL the raw avatar URL is kept (previous behaviour)', () => {
  assert.equal(
    resolveWebhookAvatarUrl({
      username: 'rex',
      sender: { imageUrl: 'https://i.ibb.co/abc/avatar.jpg' },
      baseUrl: null,
      proxyImage: proxyImageOk
    }),
    'https://i.ibb.co/abc/avatar.jpg'
  );
});

test('a sender without a photo gets the generated initials avatar', () => {
  assert.equal(
    resolveWebhookAvatarUrl({
      username: 'rex',
      sender: { imageUrl: '' },
      baseUrl: BASE,
      proxyImage: proxyImageOk
    }),
    `${BASE}/avatar/rex.png`
  );
  assert.equal(
    resolveWebhookAvatarUrl({ username: 'rex', sender: null, baseUrl: BASE, proxyImage: proxyImageOk }),
    `${BASE}/avatar/rex.png`
  );
});

test('a non-https avatar value is treated as having no photo', () => {
  // http://, data: and relative paths cannot be fetched by Discord.
  for (const imageUrl of ['http://i.ibb.co/abc/avatar.jpg', 'data:image/png;base64,xxx', '/avatar/rex.png', 'not a url']) {
    assert.equal(
      resolveWebhookAvatarUrl({ username: 'rex', sender: { imageUrl }, baseUrl: BASE, proxyImage: proxyImageOk }),
      `${BASE}/avatar/rex.png`,
      `expected initials avatar for ${JSON.stringify(imageUrl)}`
    );
  }
});

test('the username is URL-encoded into the generated avatar path', () => {
  assert.equal(
    resolveWebhookAvatarUrl({ username: 'we ird/name', sender: {}, baseUrl: BASE, proxyImage: proxyImageOk }),
    `${BASE}/avatar/we%20ird%2Fname.png`
  );
});

test('with no base URL and no photo there is no avatar_url at all', () => {
  assert.equal(
    resolveWebhookAvatarUrl({ username: 'rex', sender: {}, baseUrl: null, proxyImage: proxyImageOk }),
    null
  );
});

/* ------------------------ initials ----------------------------------- */

test('the avatar initial comes from the display name, then the username', () => {
  assert.equal(avatarInitial('Rex Kicker', 'rex'), 'R');
  assert.equal(avatarInitial('', 'rex'), 'R');
  assert.equal(avatarInitial('johnsmith', ''), 'J');
  assert.equal(avatarInitial('9lives', ''), '9');
});

test('characters the bitmap font cannot draw fall back to a usable letter', () => {
  assert.equal(avatarInitial('🔥Rex', ''), 'R');   // skip the emoji, use first letter
  assert.equal(avatarInitial('éte', ''), 'E');     // accented character
  assert.equal(avatarInitial('', '×—'), '?');      // nothing drawable
  assert.equal(avatarInitial('', ''), '?');
});

/* ------------------------ PNG rendering ------------------------------ */

function decodePng(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'PNG signature');

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  let idat = null;
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
  }

  const raw = zlib.inflateSync(idat);
  assert.equal(raw.length, height * (width * 3 + 1), 'decoded scanline size');

  const pixel = (x, y) => {
    const row = y * (width * 3 + 1);
    return [raw[row + 1 + x * 3], raw[row + 2 + x * 3], raw[row + 3 + x * 3]];
  };
  return { width, height, pixel };
}

test('renderInitialsAvatarPng produces a valid 128x128 truecolor PNG', () => {
  const { width, height } = decodePng(renderInitialsAvatarPng('R', '#c0392b'));
  assert.equal(width, 128);
  assert.equal(height, 128);
});

test('the background is the profile color, shaded by the gradient', () => {
  const { pixel } = decodePng(renderInitialsAvatarPng('R', '#c0392b'));
  const [r, g, b] = pixel(2, 2);           // top: essentially #c0392b
  assert.ok(Math.abs(r - 192) <= 2 && Math.abs(g - 57) <= 2 && Math.abs(b - 43) <= 2,
    `top pixel was ${r},${g},${b}`);
  const [r2, g2, b2] = pixel(2, 126);      // bottom: ~25% darker
  assert.ok(r2 < r && g2 < g && b2 < b, 'bottom of the gradient is darker');
});

test('dark backgrounds get a white glyph, light ones a dark glyph', () => {
  const dark = decodePng(renderInitialsAvatarPng('R', '#1e3a5f'));
  const hasWhite = Array.from({ length: 128 }, (_, y) => y).some(y =>
    Array.from({ length: 128 }, (_, x) => x).some(x => {
      const [r, g, b] = dark.pixel(x, y);
      return r > 240 && g > 240 && b > 240;
    })
  );
  assert.ok(hasWhite, 'white glyph pixels on dark background');

  const light = decodePng(renderInitialsAvatarPng('R', '#7fd8ff'));
  const hasNavy = Array.from({ length: 128 }, (_, y) => y).some(y =>
    Array.from({ length: 128 }, (_, x) => x).some(x => {
      const [r, g, b] = light.pixel(x, y);
      return r < 40 && g < 50 && b < 70;
    })
  );
  assert.ok(hasNavy, 'dark navy glyph pixels on light background');
});

test('invalid colors render in the site default color', () => {
  const byDefault = renderInitialsAvatarPng('R', DEFAULT_AVATAR_COLOR);
  for (const bad of [null, '', 'red', 'rgb(1,2,3)', '#12', '#12345']) {
    const png = renderInitialsAvatarPng('R', bad);
    assert.ok(png.equals(byDefault), `expected default color for ${JSON.stringify(bad)}`);
  }
  // 3-digit hex expands correctly.
  assert.ok(!renderInitialsAvatarPng('R', '#f00').equals(byDefault));
});

test('rendering is deterministic and distinguishes initials', () => {
  const a1 = renderInitialsAvatarPng('R', '#c0392b');
  const a2 = renderInitialsAvatarPng('R', '#c0392b');
  assert.ok(a1.equals(a2), 'same input, same bytes');

  assert.ok(!a1.equals(renderInitialsAvatarPng('S', '#c0392b')), 'different initial');
  assert.ok(!a1.equals(renderInitialsAvatarPng('R', '#2ecc71')), 'different color');
});

/* ------------------------ index.js wiring ----------------------------- */

test('index.js wires the webhook bridge through discordWebhook.js', () => {
  assert.match(INDEX_SOURCE, /require\('\.\/discordWebhook'\)/,
    'index.js should require the discordWebhook helpers');
  assert.match(INDEX_SOURCE, /sendDiscordWebhookMessage[\s\S]{0,400}buildWebhookPayload\(/,
    'sendDiscordWebhookMessage should build its payload via buildWebhookPayload');
  assert.match(
    INDEX_SOURCE,
    /publicBaseUrlFromSocket\(socket,\s*APP_BASE_URL\)[\s\S]{0,600}resolveWebhookAvatarUrl\(\{/,
    'the publicMessage handler should resolve the webhook avatar from the socket base URL'
  );
  assert.match(INDEX_SOURCE, /app\.get\('\/avatar\/:username'/,
    'the generated avatar endpoint should be registered');
  assert.match(INDEX_SOURCE, /renderInitialsAvatarPng\(\s*avatarInitial\(/,
    'the avatar route should render the user initial');
});
