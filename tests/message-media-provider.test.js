/**
 * Provider failures used to collapse into a bare `provider_error` log line.
 * These tests cover the diagnostics, classification, bounded retries, URL
 * shortening and new config knobs that make Visualize work against the keyless
 * Pollinations endpoint (which regularly returns 5xx, JSON error cards and
 * HTML rate-limit pages with an HTTP 200 status).
 *
 * Everything is injected; no network, MongoDB or Socket.IO needed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
  SAFETY_MARKER,
  configFromEnv,
  finalizePrompt,
  buildPrompt,
  generateMedia,
  createMessageMediaRouter
} = require('../messageMedia');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

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
    providerAttempts: 1,
    providerRetryMs: 0,
    ...overrides
  };
}

const okImage = () => response({
  headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
  buffer: PNG
});

/* ------------------------------------------------------------------ *
   Config knobs
 * ------------------------------------------------------------------ */

test('configFromEnv exposes bounded retry/safety/URL settings with safe defaults', () => {
  const plain = configFromEnv({});
  assert.equal(plain.providerAttempts, 3);
  assert.ok(plain.providerRetryMs > 0);
  assert.equal(plain.safeMode, true);
  assert.ok(plain.maxGetUrlChars >= 2000);

  const tuned = configFromEnv({
    MCF_MEDIA_ATTEMPTS: '5',
    MCF_MEDIA_RETRY_MS: '1200',
    MCF_MEDIA_SAFE: 'false',
    MCF_MEDIA_MAX_URL_CHARS: '2000'
  });
  assert.equal(tuned.providerAttempts, 5);
  assert.equal(tuned.providerRetryMs, 1200);
  assert.equal(tuned.safeMode, false);
  assert.equal(tuned.maxGetUrlChars, 2000);

  // Out-of-range values fall back to bounded defaults instead of disabling safety.
  assert.equal(configFromEnv({ MCF_MEDIA_ATTEMPTS: '999' }).providerAttempts, 5);
  assert.equal(configFromEnv({ MCF_MEDIA_MAX_URL_CHARS: '1' }).maxGetUrlChars, 800);
});

test('generateMedia honours MCF_MEDIA_SAFE=false to relax the provider filter', async () => {
  let url = '';
  await generateMedia({
    prompt: 'A dramatic wrestling pose',
    config: testConfig({ safeMode: false }),
    fetchImpl: async value => { url = value; return okImage(); }
  });
  assert.equal(new URL(url).searchParams.get('safe'), 'false');
});

/* ------------------------------------------------------------------ *
   Error classification + diagnostics
 * ------------------------------------------------------------------ */

test('a 5xx provider response is retryable and carries status plus redacted detail', async () => {
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig({ mediaKey: 'sk_supersecret123' }),
      fetchImpl: async () => response({
        ok: false,
        status: 503,
        headers: { 'content-type': 'application/json' },
        json: { success: false, error: { message: 'upstream flux unavailable', code: 'UPSTREAM' } },
        text: JSON.stringify({
          success: false,
          error: { message: 'upstream flux unavailable for sk_supersecret123', code: 'UPSTREAM' }
        })
      })
    }),
    err => {
      assert.equal(err.code, 'provider_error');
      assert.equal(err.providerStatus, 503);
      assert.equal(err.retryable, true);
      assert.match(err.detail, /upstream flux unavailable/);
      assert.doesNotMatch(err.message, /sk_supersecret123/);
      return true;
    }
  );
});

test('a JSON error card with HTTP 200 is classified as rate-limited, not a bare provider_error', async () => {
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig(),
      fetchImpl: async () => response({
        headers: { 'content-type': 'application/json' },
        json: { success: false, error: 'Rate limit exceeded: one free image every 45 seconds' }
      })
    }),
    err => err.code === 'provider_rate_limited' && /rate limit/i.test(err.detail)
  );
});

test('an HTML rate-limit page with HTTP 200 is recognised and retried', async () => {
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig(),
      fetchImpl: async () => response({
        headers: { 'content-type': 'text/html' },
        text: '<html><body>Too many requests, please wait</body></html>',
        buffer: Buffer.from('<html><body>Too many requests, please wait</body></html>')
      })
    }),
    err => err.code === 'provider_rate_limited' && err.providerStatus === 200
  );
});

test('a 401 is reported as a provider_auth failure with an actionable code', async () => {
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig({ mediaKey: 'sk_badkey999' }),
      fetchImpl: async () => response({ ok: false, status: 401, text: 'Unauthorized' })
    }),
    err => err.code === 'provider_auth' && err.providerStatus === 401
  );
});

test('a safety refusal is distinguished from a generic provider_error', async () => {
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig(),
      fetchImpl: async () => response({
        ok: false,
        status: 400,
        headers: { 'content-type': 'application/json' },
        json: { error: 'Prompt was refused by the content filter' }
      })
    }),
    err => err.code === 'provider_refused' && /content filter/i.test(err.detail)
  );
});

test('empty bodies and non-media bytes are retryable provider failures', async () => {
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig(),
      fetchImpl: async () => response({ headers: { 'content-type': 'image/jpeg' } })
    }),
    err => err.code === 'provider_error' && err.retryable === true && /empty file/.test(err.message)
  );
});

test('a 402 free-tier exhaustion is never retried and keeps Retry-After', async () => {
  let calls = 0;
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig({ providerAttempts: 3 }),
      fetchImpl: async () => {
        calls++;
        return response({ ok: false, status: 402, headers: { 'retry-after': '45' }, text: 'Payment Required' });
      }
    }),
    err => err.code === 'provider_rate_limited' && err.retryAfter === 45
  );
  assert.equal(calls, 1, 'a 402 must not burn retry attempts');
});

/* ------------------------------------------------------------------ *
   Bounded retries
 * ------------------------------------------------------------------ */

test('transient 5xx responses are retried with a fresh seed and succeed', async () => {
  const urls = [];
  const generated = await generateMedia({
    prompt: 'A dramatic wrestling pose',
    config: testConfig({ providerAttempts: 3, providerRetryMs: 0 }),
    seed: 7,
    fetchImpl: async value => {
      urls.push(value);
      if (urls.length < 3) {
        return response({ ok: false, status: 500, text: 'Internal Server Error' });
      }
      return okImage();
    }
  });
  assert.equal(generated.mediaType, 'image');
  assert.equal(generated.attempts, 3);
  assert.equal(urls.length, 3);
  const seeds = urls.map(value => new URL(value).searchParams.get('seed'));
  assert.equal(seeds[0], '7');
  assert.equal(new Set(seeds).size, 3, 'each retry must vary the URL so cached errors are not replayed');
});

test('retries are bounded and the final error records how many attempts were made', async () => {
  let calls = 0;
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig({ providerAttempts: 3, providerRetryMs: 0 }),
      fetchImpl: async () => {
        calls++;
        return response({ ok: false, status: 502, text: 'Bad Gateway / server busy' });
      }
    }),
    err => err.code === 'provider_error' && err.attempts === 3 && err.providerStatus === 502
  );
  assert.equal(calls, 3);
});

test('a refusal caused by reference images is retried without them', async () => {
  const urls = [];
  const generated = await generateMedia({
    prompt: 'A dramatic wrestling pose',
    config: testConfig({ mediaKey: 'key', providerAttempts: 3, providerRetryMs: 0 }),
    referenceImages: ['https://chat.example.test/img?u=one', 'https://chat.example.test/img?u=two'],
    fetchImpl: async value => {
      urls.push(value);
      if (urls.length === 1) {
        // Models without image-input support reject the `image` parameter.
        return response({
          ok: false, status: 400,
          headers: { 'content-type': 'application/json' },
          json: { error: 'Bad request: image parameter is not supported' }
        });
      }
      return okImage();
    }
  });
  assert.equal(generated.mediaType, 'image');
  assert.equal(urls.length, 2);
  assert.ok(new URL(urls[0]).searchParams.get('image'), 'first attempt sends references');
  assert.equal(new URL(urls[1]).searchParams.get('image'), null, 'retry drops references');
});

test('a network/DNS failure is a retryable provider_error with a redacted detail', async () => {
  let calls = 0;
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig({ providerAttempts: 2 }),
      fetchImpl: async () => {
        calls++;
        throw new TypeError('request to https://image.pollinations.ai/prompt failed, reason: getaddrinfo ENOTFOUND');
      }
    }),
    err => err.code === 'provider_error' && err.retryable === true && err.attempts === 2
  );
  assert.equal(calls, 2);
});

test('non-retryable failures stop after one request', async () => {
  let calls = 0;
  await assert.rejects(
    () => generateMedia({
      prompt: 'A dramatic wrestling pose',
      config: testConfig({ providerAttempts: 3 }),
      fetchImpl: async () => {
        calls++;
        return response({ ok: false, status: 403, text: 'Forbidden' });
      }
    }),
    err => err.code === 'provider_auth'
  );
  assert.equal(calls, 1);
});

/* ------------------------------------------------------------------ *
   URL length
 * ------------------------------------------------------------------ */

test('long wrestling prompts are shortened for GET providers but keep the safety suffix', async () => {
  const source = 'I hook your head, lift you up and slam you down with a powerbomb in the middle of the ring. '.repeat(14);
  const prompt = finalizePrompt(buildPrompt({ sourceText: source, mediaType: 'image', aspectRatio: '16:9' }));
  assert.ok(prompt.length > 1800);

  let url = '';
  const generated = await generateMedia({
    prompt,
    config: testConfig({ maxGetUrlChars: 1400 }),
    fetchImpl: async value => { url = value; return okImage(); }
  });
  assert.equal(generated.mediaType, 'image');
  assert.ok(url.length <= 1500, `URL too long: ${url.length}`);
  const sent = decodeURIComponent(new URL(url).pathname);
  assert.ok(sent.includes(SAFETY_MARKER), 'the safety suffix must survive URL shortening');
  assert.ok(sent.length < prompt.length, 'the provider prompt must actually be shortened');
});

test('ordinary prompts are sent verbatim (no unnecessary truncation)', async () => {
  let url = '';
  const prompt = finalizePrompt('A dramatic wrestling pose');
  await generateMedia({
    prompt,
    config: testConfig(),
    fetchImpl: async value => { url = value; return okImage(); }
  });
  assert.equal(decodeURIComponent(new URL(url).pathname).replace(/^\/prompt\//, ''), prompt);
});

/* ------------------------------------------------------------------ *
   Router logging + public error body
 * ------------------------------------------------------------------ */

class Collection {
  constructor(docs = []) { this.docs = docs.slice(); }
  async create(fields) {
    const doc = { _id: 'a'.repeat(24), time: new Date(), ...fields };
    this.docs.push(doc);
    return doc;
  }
  findById(id) { return this.findOne({ _id: String(id) }); }
  findOne(query = {}) {
    const matches = doc => Object.entries(query).every(([key, value]) => String(doc[key]) === String(value));
    return { lean: async () => this.docs.find(matches) || null };
  }
}

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await run(port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('the generate log line includes status, detail and provider host, and the reply carries a safe detail', async () => {
  const logs = [];
  const source = new Collection([{
    _id: 'a'.repeat(24), from: 'bob', display: 'Bob',
    text: 'Rex lands a superplex', time: new Date()
  }]);
  const users = new Collection([
    { username: 'alice', display: 'Alice', blockedUsers: [] },
    { username: 'bob', display: 'Bob', blockedUsers: [] }
  ]);

  const app = express();
  app.use(express.json());
  app.use('/api/message-media', createMessageMediaRouter({
    PublicMessage: source,
    RoomMessage: source,
    DM: source,
    Room: source,
    User: users,
    requireUser: (req, _res, next) => {
      req.username = 'alice';
      req.user = { username: 'alice', display: 'Alice' };
      next();
    },
    canAccessRoom: async () => true,
    canPost: async () => ({ ok: true }),
    config: testConfig(),
    refinePrompt: async () => ({ prompt: 'A safe wrestling prompt', sourceText: 'a move', refinedBy: 'local' }),
    generateMedia: async () => {
      const err = new Error('The generator returned HTTP 503: upstream flux unavailable');
      err.code = 'provider_error';
      err.providerStatus = 503;
      err.contentType = 'application/json';
      err.detail = 'upstream flux unavailable';
      err.attempts = 3;
      throw err;
    },
    hostImage: async () => ({ imageUrl: '/generated/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png' }),
    hostVideo: async () => ({ clipUrl: '/clips/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4', clipType: 'video' }),
    publishMessage: async () => {},
    logger: { error: (...args) => logs.push(args.map(String).join(' ')) }
  }));

  await withServer(app, async port => {
    const res = await fetch(`http://127.0.0.1:${port}/api/message-media/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'public', messageId: 'a'.repeat(24), mediaType: 'image',
        style: 'cinematic', aspectRatio: '1:1', prompt: 'A safe wrestling prompt'
      })
    });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error, 'provider_error');
    assert.match(body.detail, /upstream flux unavailable/);
  });

  const line = logs.join('\n');
  assert.match(line, /provider_error/);
  assert.match(line, /status=503/);
  assert.match(line, /type=application\/json/);
  assert.match(line, /attempts=3/);
  assert.match(line, /upstream flux unavailable/);
  assert.match(line, /image\.pollinations\.ai/);
  assert.doesNotMatch(line, /A safe wrestling prompt/, 'the prompt must never be logged');
});

test('a provider_auth failure is a 502 with an actionable client code, and provider_refused is a 422', async () => {
  const statuses = [];
  for (const [code, extra, expected] of [
    ['provider_auth', {}, 502],
    ['provider_refused', {}, 422],
    ['provider_rate_limited', { retryAfter: 45 }, 429]
  ]) {
    const source = new Collection([{
      _id: 'a'.repeat(24), from: 'bob', display: 'Bob',
      text: 'Rex lands a superplex', time: new Date()
    }]);
    const app = express();
    app.use(express.json());
    app.use('/api/message-media', createMessageMediaRouter({
      PublicMessage: source, RoomMessage: source, DM: source, Room: source,
      User: new Collection([]),
      requireUser: (req, _res, next) => {
        req.username = 'alice'; req.user = { username: 'alice', display: 'Alice' }; next();
      },
      canAccessRoom: async () => true,
      canPost: async () => ({ ok: true }),
      config: testConfig(),
      refinePrompt: async () => ({ prompt: 'A safe wrestling prompt', sourceText: 'a move', refinedBy: 'local' }),
      generateMedia: async () => {
        const err = new Error('The generator rejected the request');
        err.code = code;
        err.detail = 'Bad Gateway: upstream key rejected';
        Object.assign(err, extra);
        throw err;
      },
      hostImage: async () => ({ imageUrl: '/generated/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png' }),
      hostVideo: async () => ({ clipUrl: '/clips/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4', clipType: 'video' }),
      publishMessage: async () => {},
      logger: { error: () => {} }
    }));
    await withServer(app, async port => {
      const res = await fetch(`http://127.0.0.1:${port}/api/message-media/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'public', messageId: 'a'.repeat(24), mediaType: 'image',
          style: 'cinematic', aspectRatio: '1:1', prompt: 'A safe wrestling prompt'
        })
      });
      statuses.push([res.status, (await res.json()).error]);
    });
    assert.equal(statuses[statuses.length - 1][0], expected);
    assert.equal(statuses[statuses.length - 1][1], code);
  }
});
