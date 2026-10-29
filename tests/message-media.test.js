/**
 * Message → AI media: prompt refinement, provider validation and the HTTP
 * router that posts the generated media back into the originating chat.
 *
 * Everything external is injected, so these tests need no MongoDB, no image
 * provider and no Socket.IO server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  SAFETY_MARKER,
  configFromEnv,
  sanitizeSourceText,
  buildPrompt,
  finalizePrompt,
  refinePrompt,
  generateMedia,
  detectClipType,
  toPublicImageUrl,
  loadProfileImage,
  resolveParticipants,
  composeProfilePortraits,
  parseTargetRequest,
  createMessageMediaRouter
} = require('../messageMedia');

// A real (1x1) PNG, so Jimp can read it when the portrait overlay is applied.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const PROFILE_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0, 0, 2, 0]),
  Buffer.from('isomiso2avc1mp41', 'ascii')
]);

function response({ ok = true, status = 200, headers = {}, buffer = null, json = null, text = '' } = {}) {
  return {
    ok,
    status,
    headers: { get: key => headers[String(key).toLowerCase()] || null },
    arrayBuffer: async () => buffer || Buffer.alloc(0),
    json: async () => json,
    text: async () => text || (json === null ? '' : JSON.stringify(json))
  };
}

function testConfig(overrides = {}) {
  return {
    mediaKey: '',
    publicBaseUrl: '',
    imageUrl: 'https://image.pollinations.ai/prompt',
    imageMode: 'get',
    imageModel: 'flux',
    videoUrl: 'https://gen.pollinations.ai/video',
    videoMode: 'get',
    videoModel: 'ltx-2',
    videoDuration: 5,
    videoEnabled: false,
    llmUrl: '',
    llmKey: '',
    llmModel: 'openai',
    imageTimeoutMs: 1000,
    videoTimeoutMs: 1000,
    llmTimeoutMs: 1000,
    // Keep the unit tests deterministic; dedicated tests opt into retries.
    providerAttempts: 1,
    providerRetryMs: 0,
    ...overrides
  };
}

/* ------------------------------------------------------------------
   Prompt refinement
------------------------------------------------------------------ */

test('sanitizeSourceText strips links, mentions, slash commands and control chars', () => {
  const cleaned = sanitizeSourceText(
    '/roll @rival check https://example.com/x this\t\u0000out *now*'
  );
  assert.equal(cleaned, 'check this out now');
});

test('buildPrompt turns a message into image and video generator prompts', () => {
  const image = buildPrompt({
    sourceText: 'Rex lifts Vyxen above the neon ring',
    mediaType: 'image',
    style: 'cyberpunk',
    aspectRatio: '16:9'
  });
  assert.match(image, /Rex lifts Vyxen above the neon ring/);
  assert.match(image, /neon cyberpunk/i);
  assert.match(image, /wide landscape composition/);
  assert.doesNotMatch(image, /5-second/);

  const video = buildPrompt({
    sourceText: 'Rex lifts Vyxen above the neon ring',
    mediaType: 'video',
    style: 'cinematic',
    aspectRatio: '9:16'
  });
  assert.match(video, /5-second seamless loop/);
  assert.match(video, /continuous camera move/);
  assert.match(video, /vertical portrait composition/);
});

test('finalizePrompt adds safety constraints once and rejects unsafe requests', () => {
  const once = finalizePrompt('A dramatic wrestling pose');
  assert.match(once, /A dramatic wrestling pose/);
  assert.match(once, /fictional consenting adult/);
  assert.doesNotMatch(once, /\b18\b/, 'mandatory safety wording should not introduce a numeric age');
  assert.equal(once.split(SAFETY_MARKER).length - 1, 1);

  const oldPrompt = 'A dramatic wrestling pose\n\nSafety and quality: every person depicted is a fictional consenting adult (18+); no explicit sexual content.';
  assert.equal(finalizePrompt(oldPrompt), once, 'saved prompts get the updated mandatory suffix');

  const twice = finalizePrompt(once);
  assert.equal(twice, once);

  assert.throws(
    () => finalizePrompt('a child in the ring'),
    err => err.code === 'unsafe_prompt'
  );
  assert.throws(
    () => finalizePrompt('   '),
    err => err.code === 'empty_prompt'
  );
});

test('refinePrompt uses an LLM when configured and falls back when it fails', async () => {
  const llmConfig = testConfig({
    llmUrl: 'https://llm.example.test/v1/chat/completions',
    llmKey: 'test-key'
  });
  const requests = [];
  const llmFetch = async (url, options) => {
    requests.push({ url, options });
    return response({
      headers: { 'content-type': 'application/json' },
      json: { choices: [{ message: { content: 'Two cyber fighters lock up under violet arena lights' } }] }
    });
  };

  const refined = await refinePrompt({
    sourceText: 'they lock up',
    mediaType: 'image',
    config: llmConfig,
    fetchImpl: llmFetch
  });
  assert.equal(refined.refinedBy, 'llm');
  assert.match(refined.prompt, /Two cyber fighters lock up/);
  assert.match(refined.prompt, /fictional consenting adult/);
  assert.equal(requests.length, 1);
  assert.match(requests[0].options.headers.Authorization, /Bearer test-key/);
  const systemMessage = JSON.parse(requests[0].options.body).messages[0].content;
  assert.match(systemMessage, /fictional consenting adults/);
  assert.doesNotMatch(systemMessage, /\b18\b/);
  assert.match(systemMessage, /Do not include numeric ages/);

  const fallback = await refinePrompt({
    sourceText: 'they lock up',
    config: llmConfig,
    fetchImpl: async () => { throw new Error('refiner offline'); }
  });
  assert.equal(fallback.refinedBy, 'local');
  assert.match(fallback.prompt, /they lock up/);
});

test('an unsafe LLM answer is discarded in favour of the safe local prompt', async () => {
  const refined = await refinePrompt({
    sourceText: 'a dramatic arena standoff',
    config: testConfig({ llmUrl: 'https://llm.example.test/v1/chat/completions' }),
    fetchImpl: async () => response({
      headers: { 'content-type': 'application/json' },
      json: { choices: [{ message: { content: 'a child fighting in the ring' } }] }
    })
  });
  assert.equal(refined.refinedBy, 'local');
  assert.doesNotMatch(refined.prompt, /child fighting/);
  assert.match(refined.prompt, /a dramatic arena standoff/);
});

test('configFromEnv is keyless for images and needs explicit video enablement', () => {
  const plain = configFromEnv({});
  assert.equal(plain.imageUrl, 'https://image.pollinations.ai/prompt');
  assert.equal(plain.imageMode, 'get');
  assert.equal(plain.videoEnabled, false);
  assert.equal(plain.llmUrl, '');

  const keyed = configFromEnv({ MCF_MEDIA_API_KEY: 'secret' });
  assert.equal(keyed.imageUrl, 'https://gen.pollinations.ai/image');
  assert.equal(keyed.videoEnabled, true);
  assert.equal(keyed.mediaKey, 'secret');

  const custom = configFromEnv({ MCF_VIDEO_API_URL: 'http://127.0.0.1:9999/video' });
  assert.equal(custom.videoEnabled, true);

  const openai = configFromEnv({ MCF_IMAGE_API_MODE: 'openai' });
  assert.equal(openai.imageMode, 'openai');
  assert.equal(openai.imageUrl, 'https://api.openai.com/v1/images/generations');

  assert.equal(configFromEnv({ APP_BASE_URL: 'https://chat.example.test' }).publicBaseUrl, 'https://chat.example.test');
});

/* ------------------------------------------------------------------
   Member profile portraits
------------------------------------------------------------------ */

test('toPublicImageUrl builds provider-safe profile URLs', () => {
  const config = { publicBaseUrl: 'https://chat.example.test' };
  assert.equal(toPublicImageUrl('/generated/abc.png', config), 'https://chat.example.test/generated/abc.png');
  assert.equal(
    toPublicImageUrl('https://ibb.co/xyz', config),
    'https://chat.example.test/img?u=' + encodeURIComponent('https://ibb.co/xyz')
  );
  assert.equal(toPublicImageUrl(PROFILE_DATA_URL, config), null);
  assert.equal(toPublicImageUrl('/etc/passwd', config), null);
  assert.equal(toPublicImageUrl('http://example.test/a.png', config), null);
  assert.equal(toPublicImageUrl('/images/a.png', {}), null);
});

test('loadProfileImage validates data, remote and local profile pictures', async () => {
  const dataImage = await loadProfileImage({
    rawUrl: PROFILE_DATA_URL,
    fetchImpl: async () => { throw new Error('should not fetch'); },
    readLocalImage: async () => null
  });
  assert.ok(dataImage);
  assert.equal(dataImage.mimetype, 'image/png');

  const remoteImage = await loadProfileImage({
    rawUrl: 'https://i.ibb.co/abc/avatar.png',
    fetchImpl: async () => response({
      headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
      buffer: PNG
    })
  });
  assert.ok(remoteImage);
  assert.equal(remoteImage.mimetype, 'image/png');

  const localImage = await loadProfileImage({
    rawUrl: '/images/avatar.png',
    fetchImpl: async () => { throw new Error('should not fetch'); },
    readLocalImage: async () => ({ buffer: PNG, mimetype: 'image/png' })
  });
  assert.ok(localImage);
  assert.equal(localImage.mimetype, 'image/png');

  assert.equal(await loadProfileImage({ rawUrl: 'not-a-url', readLocalImage: async () => null }), null);
});

test('resolveParticipants returns both members with their stored profile images', async () => {
  const User = {
    findOne: ({ username }) => ({
      select: () => ({
        lean: async () => ({
          username,
          display: String(username).toUpperCase(),
          imageUrl: PROFILE_DATA_URL
        })
      })
    })
  };
  const participants = await resolveParticipants({ username: 'alice', otherUsername: 'bob', User });
  assert.equal(participants.self.username, 'alice');
  assert.equal(participants.self.display, 'ALICE');
  assert.equal(participants.other.username, 'bob');
  assert.equal(participants.self.imageUrl, PROFILE_DATA_URL);
  assert.equal(participants.other.imageUrl, PROFILE_DATA_URL);
});

test('composeProfilePortraits embeds two portraits and falls back to initials', async () => {
  const composed = await composeProfilePortraits({
    baseBuffer: PNG,
    participants: {
      self: { username: 'alice', display: 'Alice', buffer: PNG, mimetype: 'image/png' },
      other: { username: 'bob', display: 'Bob', buffer: PNG, mimetype: 'image/png' }
    }
  });
  assert.equal(composed.mimetype, 'image/png');
  assert.ok(composed.buffer.length > PNG.length);
  assert.equal(composed.buffer.slice(0, 8).toString('hex'), '89504e470d0a1a0a');

  const fallback = await composeProfilePortraits({
    baseBuffer: PNG,
    participants: { self: { username: 'alice' }, other: { username: 'bob' } }
  });
  assert.ok(fallback.buffer.length > PNG.length);

  await assert.rejects(
    () => composeProfilePortraits({ baseBuffer: Buffer.from('not an image'), participants: {} }),
    err => err.code === 'composition_failed'
  );
});

test('generateMedia sends both profile pictures as reference images when supported', async () => {
  const calls = [];
  await generateMedia({
    prompt: 'A dramatic wrestling pose',
    config: testConfig({ mediaKey: 'key', imageUrl: 'https://gen.pollinations.ai/image' }),
    fetchImpl: async url => {
      calls.push(url);
      return response({ headers: { 'content-type': 'image/png' }, buffer: PNG });
    },
    referenceImages: [
      'https://chat.example.test/img?u=one',
      'https://chat.example.test/img?u=two'
    ]
  });
  const url = new URL(calls[0]);
  assert.equal(
    url.searchParams.get('image'),
    'https://chat.example.test/img?u=one,https://chat.example.test/img?u=two'
  );
});

/* ------------------------------------------------------------------
   Provider calls + byte validation
------------------------------------------------------------------ */

test('generateMedia requests a Pollinations-style image and validates the bytes', async () => {
  const calls = [];
  const generated = await generateMedia({
    prompt: 'A dramatic wrestling pose',
    mediaType: 'image',
    style: 'cinematic',
    aspectRatio: '1:1',
    config: testConfig(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
        buffer: PNG
      });
    },
    seed: 7
  });

  assert.equal(generated.mediaType, 'image');
  assert.equal(generated.mimetype, 'image/png');
  assert.equal(generated.provider, 'pollinations');
  assert.equal(generated.seed, 7);
  assert.ok(Buffer.isBuffer(generated.buffer));
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.hostname, 'image.pollinations.ai');
  assert.match(decodeURIComponent(url.pathname), /A dramatic wrestling pose/);
  assert.match(decodeURIComponent(url.pathname), /fictional consenting adult/);
  assert.equal(url.searchParams.get('safe'), 'true');
  assert.equal(url.searchParams.get('seed'), '7');
});

test('generateMedia rejects non-image bytes and provider rate limits', async () => {
  // An HTML error page is now recognised as a provider failure (with its own
  // redacted detail) rather than being treated as a corrupt image upload.
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig(),
      fetchImpl: async () => response({
        headers: { 'content-type': 'text/html' },
        text: '<html>not an image</html>',
        buffer: Buffer.from('<html>not an image</html>')
      })
    }),
    err => err.code === 'provider_error' && /not an image/.test(err.detail) && err.providerStatus === 200
  );

  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig(),
      fetchImpl: async () => response({
        ok: false,
        status: 402,
        headers: { 'retry-after': '45' },
        buffer: Buffer.from('rate limited')
      })
    }),
    err => err.code === 'provider_rate_limited' && err.retryAfter === 45
  );
});

test('generateMedia understands OpenAI-compatible base64 image replies', async () => {
  let sentBody = null;
  const generated = await generateMedia({
    prompt: 'A dramatic wrestling pose',
    config: testConfig({
      imageMode: 'openai',
      imageUrl: 'https://api.example.test/v1/images/generations',
      mediaKey: 'key'
    }),
    fetchImpl: async (_url, options) => {
      sentBody = JSON.parse(options.body);
      return response({
        headers: { 'content-type': 'application/json' },
        json: { data: [{ b64_json: PNG.toString('base64') }] }
      });
    }
  });
  assert.equal(generated.mimetype, 'image/png');
  assert.equal(generated.provider, 'openai-compatible');
  assert.equal(sentBody.response_format, 'b64_json');
  assert.match(sentBody.prompt, /fictional consenting adult/);
});

test('generateMedia refuses video when disabled and validates MP4 when enabled', async () => {
  await assert.rejects(
    () => generateMedia({ prompt: 'A dramatic wrestling pose', mediaType: 'video', config: testConfig() }),
    err => err.code === 'video_unavailable'
  );

  assert.equal(detectClipType(MP4).extension, 'mp4');
  assert.equal(detectClipType(PNG), null);

  const calls = [];
  const generated = await generateMedia({
    prompt: 'A dramatic wrestling pose',
    mediaType: 'video',
    aspectRatio: '1:1',
    config: testConfig({ videoEnabled: true, mediaKey: 'key' }),
    fetchImpl: async url => {
      calls.push(url);
      return response({
        headers: { 'content-type': 'video/mp4' },
        buffer: MP4
      });
    }
  });
  assert.equal(generated.mediaType, 'video');
  assert.equal(generated.extension, 'mp4');
  assert.equal(generated.clipType, 'video');
  const videoUrl = new URL(calls[0]);
  assert.equal(videoUrl.searchParams.get('aspectRatio'), '16:9');
  assert.equal(videoUrl.searchParams.get('width'), '768');
  assert.equal(videoUrl.searchParams.get('height'), '432');
});

test('parseTargetRequest validates scope, ids and video availability', () => {
  assert.equal(parseTargetRequest({ scope: 'public', messageId: 'a'.repeat(24), mediaType: 'image' }, testConfig()).ok, true);
  assert.equal(parseTargetRequest({ scope: 'forum', messageId: 'a'.repeat(24) }, testConfig()).error, 'invalid_scope');
  assert.equal(parseTargetRequest({ scope: 'room', messageId: 'a'.repeat(24), room: 'bad', mediaType: 'image' }, testConfig()).error, 'invalid_room');
  assert.equal(parseTargetRequest({ scope: 'public', messageId: 'a'.repeat(24), mediaType: 'video' }, testConfig()).error, 'video_unavailable');
});

/* ------------------------------------------------------------------
   HTTP router: authorization, generation, posting
------------------------------------------------------------------ */

class Collection {
  constructor(docs = []) {
    this.docs = docs.slice();
    this.next = 1;
  }

  async create(fields) {
    const doc = {
      _id: (this.next++).toString(16).padStart(24, '0'),
      time: new Date('2026-10-27T12:00:00.000Z'),
      ...fields
    };
    this.docs.push(doc);
    return doc;
  }

  findById(id) {
    return this.findOne({ _id: String(id) });
  }

  findOne(query = {}) {
    const matches = doc => Object.entries(query).every(([key, value]) => String(doc[key]) === String(value));
    return { lean: async () => this.docs.find(matches) || null };
  }

  find(query = {}) {
    const matches = doc => Object.entries(query).every(([key, value]) => String(doc[key]) === String(value));
    return {
      sort: () => ({
        limit: () => ({ select: () => ({ lean: async () => this.docs.filter(matches) }) })
      })
    };
  }

  all() { return this.docs.slice(); }
}

const PUBLIC_ID = 'a'.repeat(24);
const ROOM_ID = 'b'.repeat(24);
const ROOM_MESSAGE_ID = 'c'.repeat(24);
const DM_ID = 'd'.repeat(24);

async function startApi(overrides = {}) {
  const models = {
    public: new Collection([{ _id: PUBLIC_ID, from: 'rival', display: 'Rival', text: 'Rex lands a superplex', time: new Date() }]),
    rooms: new Collection([{ _id: ROOM_ID, name: 'Private', private: true, owner: 'alice', invitedUsers: ['bob'], slowModeMs: 0, muted: {} }]),
    roomMessages: new Collection([{ _id: ROOM_MESSAGE_ID, room: ROOM_ID, from: 'bob', display: 'Bob', text: 'The crowd goes wild', time: new Date() }]),
    dms: new Collection([{ _id: DM_ID, from: 'bob', to: 'alice', text: 'Hola amiga', originalText: 'Meet me in the ring', time: new Date() }]),
    users: new Collection([
      { username: 'bob', display: 'Bob', blockedUsers: [], imageUrl: PROFILE_DATA_URL },
      { username: 'alice', display: 'Alice', blockedUsers: [], imageUrl: PROFILE_DATA_URL },
      { username: 'rival', display: 'Rival', blockedUsers: [], imageUrl: PROFILE_DATA_URL }
    ])
  };
  if (overrides.seed) overrides.seed(models);

  const published = [];
  const prompts = [];
  const generations = [];
  const hostedImages = [];
  const hostedVideos = [];
  let canPostResult = overrides.canPostResult || { ok: true };

  const app = express();
  app.use(express.json());
  const requireUser = (req, res, next) => {
    const username = req.get('x-member');
    if (!username) return res.status(401).json({ ok: false, error: 'auth_required' });
    req.username = username;
    req.user = { username, display: username === 'alice' ? 'Alice' : username };
    next();
  };

  const config = testConfig({
    videoEnabled: true,
    ...(overrides.config || {})
  });

  app.use('/api/message-media', createMessageMediaRouter({
    PublicMessage: models.public,
    RoomMessage: models.roomMessages,
    DM: models.dms,
    Room: models.rooms,
    User: models.users,
    requireUser,
    canAccessRoom: (room, username) => !room.private || room.owner === username ||
      (Array.isArray(room.invitedUsers) && room.invitedUsers.includes(username)),
    canPost: async () => canPostResult,
    config,
    fetchImpl: async () => response({ buffer: PNG }),
    refinePrompt: async args => {
      prompts.push(args);
      return refinePrompt({ ...args, config: testConfig(), fetchImpl: async () => response({}) });
    },
    generateMedia: async args => {
      generations.push(args);
      if (args.mediaType === 'video') {
        return { mediaType: 'video', buffer: MP4, extension: 'mp4', clipType: 'video', provider: 'test', model: 'test', seed: 1 };
      }
      return { mediaType: 'image', buffer: PNG, mimetype: 'image/png', provider: 'test', model: 'test', seed: 1 };
    },
    hostImage: async args => {
      hostedImages.push(args);
      return { imageUrl: `/generated/${'e'.repeat(32)}.png` };
    },
    hostVideo: async args => {
      hostedVideos.push(args);
      return { clipUrl: `/clips/${'f'.repeat(32)}.mp4`, clipType: args.clipType };
    },
    readLocalImage: async () => null,
    publishMessage: async payload => { published.push(payload); },
    logger: { error: () => {} }
  }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(path, { member = 'alice', body } = {}) {
    const headers = {};
    if (member) headers['x-member'] = member;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}/api/message-media${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  return {
    models,
    published,
    prompts,
    generations,
    hostedImages,
    hostedVideos,
    call,
    setCanPost: value => { canPostResult = value; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('config endpoint reports capabilities, and auth is required', async () => {
  const api = await startApi();
  try {
    const anon = await api.call('/config', { member: null });
    assert.equal(anon.status, 401);

    const config = await api.call('/config');
    assert.equal(config.status, 200);
    assert.equal(config.data.ok, true);
    assert.equal(config.data.videoEnabled, true);
    assert.ok(config.data.styles.some(style => style.id === 'cinematic'));
    assert.ok(config.data.aspectRatios.some(ratio => ratio.id === '16:9'));
  } finally {
    await api.close();
  }
});

test('prompt endpoint refines the STORED message, not client-supplied text', async () => {
  const api = await startApi();
  try {
    const result = await api.call('/prompt', {
      body: {
        scope: 'public',
        messageId: PUBLIC_ID,
        mediaType: 'image',
        style: 'comic',
        aspectRatio: '16:9',
        text: 'IGNORE ME'
      }
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.target.from, 'rival');
    assert.equal(result.data.participants.self.username, 'alice');
    assert.equal(result.data.participants.other.username, 'rival');
    assert.equal(result.data.participants.other.imageUrl, PROFILE_DATA_URL);
    assert.equal(result.data.sourceText, 'Rex lands a superplex');
    assert.match(result.data.prompt, /Rex lands a superplex/);
    assert.match(result.data.prompt, /comic-book/i);
    assert.doesNotMatch(result.data.prompt, /IGNORE ME/);
    assert.equal(api.prompts[0].sourceText, 'Rex lands a superplex');
  } finally {
    await api.close();
  }
});

test('generating in the arena hosts the image, stores provenance and broadcasts it', async () => {
  const api = await startApi();
  try {
    const result = await api.call('/generate', {
      body: {
        scope: 'public',
        messageId: PUBLIC_ID,
        mediaType: 'image',
        prompt: 'A dramatic ring moment'
      }
    });
    assert.equal(result.status, 201);
    assert.equal(result.data.ok, true);
    assert.match(result.data.message.imageUrl, /^\/generated\/[a-f0-9]{32}\.png$/);
    assert.match(result.data.prompt, /fictional consenting adult/);

    const created = api.models.public.all().find(doc => doc.generatedMedia);
    assert.ok(created, 'a new public message was stored');
    assert.equal(created.from, 'alice');
    assert.equal(created.display, 'Alice');
    assert.equal(created.generatedMedia.sourceMessageId, PUBLIC_ID);
    assert.equal(created.generatedMedia.sourceFrom, 'rival');
    assert.deepEqual(
      created.generatedMedia.participants.map(p => p.username),
      ['alice', 'rival']
    );
    assert.equal(created.replyTo._id, PUBLIC_ID);
    assert.match(created.text, /AI image from @rival/);

    assert.equal(api.hostedImages.length, 1);
    assert.equal(api.hostedImages[0].mimetype, 'image/png');
    assert.ok(api.hostedImages[0].buffer.length > PNG.length, 'portraits were composited');
    assert.equal(api.generations[0].referenceImages.length, 0, 'keyless provider gets no references');
    assert.equal(api.published.length, 1);
    assert.deepEqual(
      api.published[0].payload.generatedMedia.participants.map(p => p.username),
      ['alice', 'rival']
    );
    assert.equal(api.published[0].scope, 'public');
    assert.equal(api.published[0].payload.imageUrl, created.imageUrl);
    assert.equal(api.published[0].payload._id, String(created._id));
  } finally {
    await api.close();
  }
});

test('room generation requires access and includes the room in the broadcast', async () => {
  const api = await startApi();
  try {
    const denied = await api.call('/generate', {
      member: 'stranger',
      body: { scope: 'room', room: ROOM_ID, messageId: ROOM_MESSAGE_ID, mediaType: 'image' }
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, 'not_your_room');

    const ok = await api.call('/generate', {
      member: 'alice',
      body: { scope: 'room', room: ROOM_ID, messageId: ROOM_MESSAGE_ID, mediaType: 'image' }
    });
    assert.equal(ok.status, 201);
    const created = api.models.roomMessages.all().find(doc => doc.generatedMedia);
    assert.equal(created.room, ROOM_ID);
    assert.equal(created.from, 'alice');
    assert.deepEqual(
      created.generatedMedia.participants.map(p => p.username),
      ['alice', 'bob']
    );
    assert.equal(api.published[0].scope, 'room');
    assert.equal(api.published[0].room, ROOM_ID);
    assert.equal(api.published[0].payload.generatedMedia.sourceMessageId, ROOM_MESSAGE_ID);
  } finally {
    await api.close();
  }
});

test('DM generation uses the original text, checks blocks and delivers to both sides', async () => {
  const api = await startApi();
  try {
    const outsider = await api.call('/generate', {
      member: 'stranger',
      body: { scope: 'dm', messageId: DM_ID, mediaType: 'image' }
    });
    assert.equal(outsider.status, 404);

    const ok = await api.call('/generate', {
      body: { scope: 'dm', messageId: DM_ID, mediaType: 'image' }
    });
    assert.equal(ok.status, 201);
    const created = api.models.dms.all().find(doc => doc.generatedMedia);
    assert.equal(created.to, 'bob');
    assert.equal(created.type, 'image');
    assert.equal(created.originalText, created.text);
    assert.deepEqual(
      created.generatedMedia.participants.map(p => p.username),
      ['alice', 'bob']
    );
    assert.equal(api.published[0].scope, 'dm');
    assert.equal(api.published[0].partner, 'bob');
    assert.equal(api.published[0].payload.to, undefined); // index.js adds the recipient
  } finally {
    await api.close();
  }
});

test('a blocked recipient, a staff timeout and an unsafe prompt are rejected', async () => {
  const api = await startApi({
    seed: models => {
      models.users.docs.find(user => user.username === 'bob').blockedUsers = ['alice'];
    }
  });
  try {
    const blocked = await api.call('/generate', {
      body: { scope: 'dm', messageId: DM_ID, mediaType: 'image' }
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error, 'recipient_blocked');

    api.setCanPost({ ok: false, status: 403, error: 'timed_out', until: new Date().toISOString() });
    const timedOut = await api.call('/generate', {
      body: { scope: 'public', messageId: PUBLIC_ID, mediaType: 'image' }
    });
    assert.equal(timedOut.status, 403);
    assert.equal(timedOut.data.error, 'timed_out');

    api.setCanPost({ ok: true });
    const unsafe = await api.call('/generate', {
      body: {
        scope: 'public',
        messageId: PUBLIC_ID,
        mediaType: 'image',
        prompt: 'a child in the ring'
      }
    });
    assert.equal(unsafe.status, 400);
    assert.equal(unsafe.data.error, 'unsafe_prompt');
    assert.equal(api.published.length, 0);
  } finally {
    await api.close();
  }
});

test('configured key + public base URL pass both profile pictures as provider references', async () => {
  const api = await startApi({
    config: { mediaKey: 'key', publicBaseUrl: 'https://chat.example.test' },
    seed: models => {
      models.users.docs.find(user => user.username === 'alice').imageUrl = 'https://ibb.co/alice';
      models.users.docs.find(user => user.username === 'rival').imageUrl = 'https://i.ibb.co/rival/a.png';
    }
  });
  try {
    const ok = await api.call('/generate', {
      body: { scope: 'public', messageId: PUBLIC_ID, mediaType: 'image' }
    });
    assert.equal(ok.status, 201);
    assert.equal(api.generations[0].referenceImages.length, 2);
    assert.match(api.generations[0].referenceImages[0], /^https:\/\/chat\.example\.test\/img\?u=/);
    assert.match(api.generations[0].referenceImages[1], /^https:\/\/chat\.example\.test\/img\?u=/);
    assert.deepEqual(ok.data.participants.map(p => p.username), ['alice', 'rival']);
  } finally {
    await api.close();
  }
});

test('video generation posts a /clips attachment with the right metadata', async () => {
  const api = await startApi();
  try {
    const ok = await api.call('/generate', {
      body: {
        scope: 'public',
        messageId: PUBLIC_ID,
        mediaType: 'video',
        style: 'cinematic',
        aspectRatio: '16:9'
      }
    });
    assert.equal(ok.status, 201);
    assert.match(ok.data.message.clipUrl, /^\/clips\/[a-f0-9]{32}\.mp4$/);
    assert.equal(ok.data.message.clipType, 'video');

    const created = api.models.public.all().find(doc => doc.generatedMedia);
    assert.equal(created.generatedMedia.type, 'video');
    assert.equal(created.clipUrl, ok.data.message.clipUrl);
    assert.equal(api.hostedVideos.length, 1);
    assert.equal(api.published[0].payload.clipType, 'video');
  } finally {
    await api.close();
  }
});

test('generated messages cannot be used as the source, and bad ids are rejected', async () => {
  const api = await startApi({
    seed: models => {
      models.public.docs[0].generatedMedia = { type: 'image' };
    }
  });
  try {
    const recycled = await api.call('/prompt', {
      body: { scope: 'public', messageId: PUBLIC_ID, mediaType: 'image' }
    });
    assert.equal(recycled.status, 422);
    assert.equal(recycled.data.error, 'not_visualizable');

    const badId = await api.call('/generate', {
      body: { scope: 'public', messageId: 'not-an-id', mediaType: 'image' }
    });
    assert.equal(badId.status, 400);
    assert.equal(badId.data.error, 'invalid_target');
  } finally {
    await api.close();
  }
});
