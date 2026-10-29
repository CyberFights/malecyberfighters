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
    ['provider_privacy', {}, 422],
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

/* ------------------------------------------------------------------ *
   Pollinations seed range and binary error cards
 * ------------------------------------------------------------------ */

test('generated seeds use the complete non-negative signed 32-bit range', async t => {
  const crypto = require('node:crypto');
  const randomInt = t.mock.method(crypto, 'randomInt', (min, max) => {
    assert.equal(min, 0);
    assert.equal(max, 2147483648);
    return max - 1;
  });
  let requestedSeed;
  const result = await generateMedia({
    prompt: 'A wrestling match', config: testConfig(),
    fetchImpl: async url => {
      requestedSeed = Number(new URL(url).searchParams.get('seed'));
      return okImage();
    }
  });
  assert.equal(randomInt.mock.callCount(), 1);
  assert.equal(requestedSeed, 2147483647);
  assert.equal(result.seed, requestedSeed);
});

test('oversized input seeds and retry seeds stay in range in GET and POST requests', async () => {
  for (const mode of ['get', 'openai']) {
    const seeds = [];
    const result = await generateMedia({
      prompt: 'A wrestling match', seed: 4294967295,
      config: testConfig({ imageMode: mode, providerAttempts: 2, providerRetryMs: 0 }),
      fetchImpl: async (url, options) => {
        seeds.push(mode === 'get' ? Number(new URL(url).searchParams.get('seed')) : JSON.parse(options.body).seed);
        return seeds.length === 1 ? response({ ok: false, status: 500 }) : okImage();
      }
    });
    assert.deepEqual(seeds, [2147483647, 7918]);
    assert.equal(result.seed, seeds[1]);
  }
});

test('HTTP 400 JPEG error cards are not decoded, posted, or mistaken for a refusal', async () => {
  let read = false;
  let canceled = false;
  await assert.rejects(() => generateMedia({
    prompt: 'A wrestling match', config: testConfig({ providerAttempts: 3 }),
    fetchImpl: async () => ({
      ok: false, status: 400,
      headers: { get: key => key === 'content-type' ? 'image/jpeg' : null },
      body: { cancel: async () => { canceled = true; } },
      text: async () => { read = true; return '\ufffd\ufffd JFIF'; }
    })
  }), err => {
    assert.equal(err.code, 'provider_error');
    assert.equal(err.providerStatus, 400);
    assert.equal(err.contentType, 'image/jpeg');
    assert.match(err.detail, /without a readable explanation/);
    assert.doesNotMatch(err.message, /JFIF|\ufffd/);
    return true;
  });
  assert.equal(read, false);
  assert.equal(canceled, true);
});

test('binary errors with missing content type never appear as text diagnostics', async () => {
  await assert.rejects(() => generateMedia({
    prompt: 'A wrestling match', config: testConfig(),
    fetchImpl: async () => response({ ok: false, status: 400, text: '\ufffd\ufffd JFIF\u0000 rate limit' })
  }), err => err.code === 'provider_error' && !err.message.includes('JFIF') && /binary error/.test(err.detail));
});

test('text error streams are bounded and cancelled when they exceed the limit', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(Buffer.alloc(16384, 65)); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(() => generateMedia({
    prompt: 'A wrestling match', config: testConfig(),
    fetchImpl: async () => ({
      ok: false, status: 400, body,
      headers: { get: key => key === 'content-type' ? 'text/plain' : null }
    })
  }), err => err.code === 'provider_error' && err.detail.length <= 180);
  assert.equal(cancelled, true);
});

/* ------------------------------------------------------------------ *
   Classic Pollinations content negotiation
 * ------------------------------------------------------------------ */

test('classic Pollinations gets machine-readable errors and successful images with the same Accept header', async () => {
  const seen = [];
  const fetchImpl = async (_url, options) => {
    seen.push(options.headers.Accept);
    // The classic API returns JPEG error cards whenever Accept contains image/.
    if (/image\//i.test(options.headers.Accept)) {
      return response({ ok: false, status: 400, headers: { 'content-type': 'image/jpeg' }, buffer: Buffer.from('JFIF') });
    }
    if (seen.length === 1) {
      return response({ ok: false, status: 400, headers: { 'content-type': 'application/json' },
        json: { success: false, error: { code: 'BAD_REQUEST', message: 'Invalid request parameter' } } });
    }
    return okImage();
  };
  await assert.rejects(() => generateMedia({ prompt: 'A wrestling match', config: testConfig(), fetchImpl }), err => {
    assert.equal(err.code, 'provider_error');
    assert.equal(err.providerStatus, 400);
    assert.equal(err.contentType, 'application/json');
    assert.match(err.detail, /Invalid request parameter/);
    return true;
  });
  const image = await generateMedia({ prompt: 'A wrestling match', config: testConfig(), fetchImpl });
  assert.equal(image.mimetype, 'image/png');
  assert.equal(seen.length, 2);
  for (const accept of seen) {
    assert.match(accept, /application\/json/);
    assert.doesNotMatch(accept, /image\//i);
    assert.match(accept, /\*\/\*/);
  }
});

test('classic error details do not expose echoed prompt, URL, or request parameters', async () => {
  const privateText = 'A distinctive private wrestling message';
  await assert.rejects(() => generateMedia({
    prompt: privateText, config: testConfig({ maxGetUrlChars: 800 }),
    fetchImpl: async url => {
      const encoded = new URL(url).pathname.split('/').pop();
      return response({ ok: false, status: 400, headers: { 'content-type': 'application/json' },
        json: { error: { message: `Bad request ${decodeURIComponent(encoded)} ${encoded}` }, requestParameters: { prompt: privateText } } });
    }
  }), err => {
    assert.equal(err.providerStatus, 400);
    assert.doesNotMatch(err.message, /distinctive private wrestling message/i);
    assert.doesNotMatch(err.detail, /distinctive%20private/i);
    assert.match(err.detail, /\[redacted\]/);
    return true;
  });
  await assert.rejects(() => generateMedia({
    prompt: privateText, config: testConfig(),
    fetchImpl: async () => response({ ok: false, status: 400, headers: { 'content-type': 'application/json' },
      json: { requestParameters: { prompt: privateText } } })
  }), err => !err.message.includes(privateText) && !err.detail.includes(privateText));
});

test('custom image, OpenAI, and video providers retain their existing Accept negotiation', async () => {
  for (const config of [
    testConfig({ imageUrl: 'https://example.test/image' }),
    testConfig({ imageMode: 'openai' }),
    testConfig({ videoEnabled: true })
  ]) {
    const mediaType = config.videoEnabled ? 'video' : 'image';
    let accept = '';
    await assert.rejects(() => generateMedia({
      prompt: 'A wrestling match', mediaType, config,
      fetchImpl: async (_url, options) => { accept = options.headers.Accept; return response({ ok: false, status: 403 }); }
    }));
    assert.match(accept, mediaType === 'video' ? /video\/mp4/ : /image\/jpeg/);
  }
});

/* Explicit privacy safety blocks must be surfaced without bypassing them. */
test('Pollinations privacy blocks are actionable and never retried or relaxed', async () => {
  for (const status of [400, 200]) {
    let calls = 0;
    const config = testConfig({ providerAttempts: 3, providerRetryMs: 0, mediaKey: 'test-key' });
    await assert.rejects(() => generateMedia({
      prompt: 'Two adult wrestlers in a ring', config,
      referenceImages: ['https://chat.example.test/one.png', 'https://chat.example.test/two.png'],
      fetchImpl: async (url) => {
        calls++;
        assert.equal(new URL(url).searchParams.get('safe'), 'true');
        assert.ok(new URL(url).searchParams.get('image'));
        return response({
          ok: status === 200, status,
          headers: { 'content-type': 'application/json' },
          json: { success: false, error: { message: 'Request blocked by safety filter: privacy', code: 'content_blocked' }, status }
        });
      }
    }), err => err.code === 'provider_privacy' && err.providerStatus === status && err.retryable === false);
    assert.equal(calls, 1, 'a privacy refusal must not be retried with altered safety or references');
  }
});

test('only explicit privacy-only safety blocks get the privacy-specific response', async () => {
  for (const message of ['Request blocked by safety filter: sexual,privacy', 'privacy service returned an invalid request']) {
    await assert.rejects(() => generateMedia({
      prompt: 'Two wrestlers in a ring', config: testConfig(),
      fetchImpl: async () => response({ ok: false, status: 400, headers: { 'content-type': 'application/json' }, json: { error: message } })
    }), err => err.code !== 'provider_privacy');
  }
});

test('default wrestling prompts and old suffixes do not insert a numeric age, with safety still enabled', async () => {
  for (const keyed of [false, true]) {
    const config = testConfig(keyed ? {
      mediaKey: 'test-key', imageUrl: 'https://gen.pollinations.ai/image'
    } : {});
    const turn = 'I lift you into a powerbomb in the ring';
    const oldPrompt = buildPrompt({ sourceText: turn }) +
      '\n\nSafety and quality: every person depicted is a fictional consenting adult (18+); no explicit sexual content.';
    const referenceImages = ['https://chat.example.test/one.png', 'https://chat.example.test/two.png'];
    const generated = await generateMedia({
      prompt: oldPrompt, config, referenceImages,
      fetchImpl: async url => {
        const parsed = new URL(url);
        const actual = decodeURIComponent(parsed.pathname.split('/').pop());
        assert.equal(parsed.searchParams.get('safe'), 'true');
        assert.match(actual, /fictional consenting adult/);
        assert.match(actual, /no explicit sexual content/);
        assert.match(actual, /no minors/);
        assert.match(actual, /powerbomb/);
        assert.doesNotMatch(actual, /\b18\b/);
        assert.equal(Boolean(parsed.searchParams.get('image')), keyed);
        return okImage();
      }
    });
    assert.equal(generated.mediaType, 'image');
  }
});
