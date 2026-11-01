'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Jimp = require('jimp');
const { configFromEnv, generateMedia, makeMagnificReferences, refinePrompt, buildSceneContext, SAFETY_MARKER } = require('../messageMedia');

const ENDPOINT = 'https://api.magnific.com/v1/ai/text-to-image/seedream-v4-5-edit';
const ID = '046b6c7f-0b8a-43b9-b35d-6489e6daee91';
const IMAGE_URL = 'https://ai-statics.freepik.com/output.png';
const json = data => new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
const cfg = overrides => ({ ...configFromEnv({ MAGNIFIC_API_KEY: 'secret-key' }), imageTimeoutMs: 1500, magnificPollMs: 0, ...overrides });
const task = (status, extra = {}) => ({ status, task_id: ID, generated: [], ...extra });
async function image(color) { return new Jimp(16, 20, color).getBufferAsync(Jimp.MIME_PNG); }
async function args() {
  return { prompt: 'I lift you off the mat', config: cfg(), referenceImages: await makeMagnificReferences({
    self: { username: 'alice', buffer: await image(0xff0000ff) },
    other: { username: 'bob', buffer: await image(0x0000ffff) }
  }) };
}

test('Magnific references preserve participant order and normalize photos and missing avatars', async () => {
  const refs = await makeMagnificReferences({
    self: { username: 'alice', buffer: await image(0xff0000ff) },
    other: { username: 'bob', buffer: await image(0x0000ffff) }
  });
  assert.equal(refs.length, 2);
  const [first, second] = await Promise.all(refs.map(ref => Jimp.read(Buffer.from(ref, 'base64'))));
  assert.equal(first.bitmap.width, 512); assert.equal(first.bitmap.height, 512);
  assert.equal(second.bitmap.width, 512); assert.equal(second.bitmap.height, 512);
  assert.equal(first.getPixelColor(256, 256), 0xff0000ff);
  assert.equal(second.getPixelColor(256, 256), 0x0000ffff);
  const initials = await makeMagnificReferences({ self: { username: 'alice' }, other: { username: 'bob', buffer: Buffer.from('bad image') } });
  assert.equal(initials.length, 2);
  assert.notEqual(initials[0], initials[1]);
  for (const ref of initials) assert.equal((await Jimp.read(Buffer.from(ref, 'base64'))).bitmap.width, 512);
  const same = await makeMagnificReferences({ self: { buffer: await image(0xff0000ff) }, other: { buffer: await image(0xff0000ff) } });
  assert.equal(same.length, 2, 'identical photos must not be deduplicated');
});

test('Magnific POST uses both ordered references, polls, and downloads without the API key', async () => {
  const request = await args();
  const output = await image(0x00ff00ff);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return json(task('CREATED'));
    if (calls.length === 2) return json(task('IN_PROGRESS'));
    if (calls.length === 3) return json(task('COMPLETED', { generated: [IMAGE_URL] }));
    return new Response(output, { headers: { 'content-type': 'image/png' } });
  };
  const result = await generateMedia({ ...request, aspectRatio: '16:9', fetchImpl });
  assert.equal(result.provider, 'magnific');
  assert.deepEqual(result.buffer, output);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].options.headers['x-magnific-api-key'], 'secret-key');
  const payload = JSON.parse(calls[0].options.body);
  assert.deepEqual(payload.reference_images, request.referenceImages);
  assert.match(payload.prompt, /@img1.*@img2/);
  assert.match(payload.prompt, /I lift you off the mat/);
  assert.doesNotMatch(payload.prompt, /Safety and quality/);
  assert.equal(payload.aspect_ratio, 'widescreen_16_9');
  assert.equal(payload.seed, 12345);
  assert.equal(payload.enable_safety_checker, false);
  assert.equal(result.prompt, payload.prompt);
  assert.equal(calls[1].url, `${ENDPOINT}/${ID}`);
  assert.equal(calls[2].url, `${ENDPOINT}/${ID}`);
  assert.equal(calls[3].url, IMAGE_URL);
  assert.equal(calls[3].options.headers['x-magnific-api-key'], undefined);
  assert.equal(calls[3].options.redirect, 'manual');
});

test('ratios map to Magnific enums, and existing @img mappings remain unchanged', async () => {
  for (const [aspectRatio, expected] of [['1:1', 'square_1_1'], ['9:16', 'social_story_9_16'], ['4:3', 'classic_4_3']]) {
    const request = await args();
    const prompt = '@img1 grapples @img2';
    let sent;
    await generateMedia({ ...request, prompt, aspectRatio, fetchImpl: async (url, options) => {
      if (options.method === 'POST') { sent = JSON.parse(options.body); return json(task('COMPLETED', { generated: [IMAGE_URL] })); }
      return new Response(await image(0xff00ffff), { headers: { 'content-type': 'image/png' } });
    } });
    assert.equal(sent.aspect_ratio, expected); assert.equal(sent.prompt, prompt);
  }
});

test('preview maps first-person roles to the correct reference with no safety suffix', async () => {
  const config = cfg();
  for (const [author, mapping] of [['alice', /first picture is the author/i], ['bob', /second picture is the author/i]]) {
    const participants = { self: { username: 'alice', imageUrl: '/a' }, other: { username: 'bob', imageUrl: '/b' } };
    const scene = buildSceneContext({ source: { from: author }, participants, config, mediaType: 'image' });
    const preview = await refinePrompt({ sourceText: 'I squeeze you in a bearhug', config, scene });
    assert.match(preview.prompt, /@img1.*@img2/);
    assert.match(preview.prompt, mapping);
    assert.ok(!preview.prompt.includes(SAFETY_MARKER));
  }
});

test('missing key, missing reference, and unsafe prompts are rejected before a paid POST', async () => {
  const request = await args(); let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('must not call'); };
  await assert.rejects(generateMedia({ ...request, config: cfg({ magnificKey: '' }), fetchImpl }), { code: 'provider_config' });
  await assert.rejects(generateMedia({ ...request, referenceImages: [request.referenceImages[0]], fetchImpl }), { code: 'provider_config' });
  await assert.rejects(generateMedia({ ...request, prompt: 'a child in the ring', fetchImpl }), { code: 'unsafe_prompt' });
  assert.equal(calls, 0);
});

test('failed task and HTTP errors are safe and never retry the paid POST', async () => {
  const request = await args();
  let calls = 0;
  await assert.rejects(generateMedia({ ...request, fetchImpl: async () => { calls++; return json(task('FAILED', { message: 'secret-key I lift you off the mat' })); } }), err => {
    assert.equal(err.code, 'provider_error');
    assert.doesNotMatch(String(err), /secret-key|I lift you/); return true;
  });
  assert.equal(calls, 1);
  for (const [status, code] of [[401, 'provider_auth'], [429, 'provider_rate_limited'], [500, 'provider_error']]) {
    calls = 0;
    await assert.rejects(generateMedia({ ...request, fetchImpl: async () => { calls++; return new Response('secret-key I lift you off the mat', { status }); } }), err => {
      assert.equal(err.code, code); assert.doesNotMatch(String(err), /secret-key|I lift you/); return true;
    });
    assert.equal(calls, 1);
  }
});

test('unknown tasks, malformed IDs, untrusted URLs, redirects and oversized results are rejected', async () => {
  const request = await args();
  for (const value of [task('SOMETHING_ELSE'), task('CREATED', { task_id: '../x' }), task('COMPLETED', { generated: ['http://127.0.0.1/private'] })]) {
    let calls = 0;
    await assert.rejects(generateMedia({ ...request, fetchImpl: async () => { calls++; return json(value); } }));
    assert.equal(calls, 1);
  }
  for (const response of [new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }), new Response('x', { headers: { 'content-length': String(13 * 1024 * 1024) } }), new Response('not a picture', { headers: { 'content-type': 'image/png' } })]) {
    let calls = 0;
    await assert.rejects(generateMedia({ ...request, fetchImpl: async () => { calls++; return calls === 1 ? json(task('COMPLETED', { generated: [IMAGE_URL] })) : response; } }));
    assert.equal(calls, 2);
  }
});

test('polling times out and does not submit a second task', async () => {
  const request = await args(); let posts = 0, gets = 0;
  await assert.rejects(generateMedia({ ...request, config: cfg({ imageTimeoutMs: 25, magnificPollMs: 1 }), fetchImpl: async (_url, options) => {
    if (options.method === 'POST') { posts++; return json(task('CREATED')); }
    gets++; return json(task('IN_PROGRESS'));
  } }), { code: 'provider_timeout' });
  assert.equal(posts, 1); assert.ok(gets > 0);
});

test('generated images between the profile upload limit and media limit are accepted', async () => {
  const request = await args();
  const large = Buffer.concat([await image(0xffffffff), Buffer.alloc(5 * 1024 * 1024)]);
  const result = await generateMedia({ ...request, fetchImpl: async (_url, options) => options.method === 'POST'
    ? json(task('COMPLETED', { generated: [IMAGE_URL] }))
    : new Response(large, { headers: { 'content-type': 'image/png' } }) });
  assert.equal(result.buffer.length, large.length);
});

test('the deadline includes response-body reads and the network error does not expose request data', async () => {
  const request = await args();
  let posts = 0;
  await assert.rejects(generateMedia({ ...request, config: cfg({ imageTimeoutMs: 20 }), fetchImpl: async () => {
    posts++;
    return { ok: true, headers: { get: () => null }, arrayBuffer: () => new Promise(() => {}) };
  } }), { code: 'provider_timeout' });
  assert.equal(posts, 1);
  await assert.rejects(generateMedia({ ...request, fetchImpl: async () => { throw new Error('secret-key I lift you off the mat'); } }), err => {
    assert.equal(err.code, 'provider_error'); assert.doesNotMatch(String(err), /secret-key|I lift you/); return true;
  });
});

test('transient task-status errors retry only the GET, not the paid POST', async () => {
  const request = await args();
  let posts = 0, polls = 0;
  const result = await generateMedia({ ...request, fetchImpl: async (_url, options) => {
    if (options.method === 'POST') { posts++; return json(task('IN_PROGRESS')); }
    if (options.headers['x-magnific-api-key']) {
      polls++;
      if (polls === 1) return new Response('temporary', { status: 503 });
      return json(task('COMPLETED', { generated: [IMAGE_URL] }));
    }
    return new Response(await image(0xff00ffff), { headers: { 'content-type': 'image/png' } });
  } });
  assert.equal(result.provider, 'magnific');
  assert.equal(posts, 1); assert.equal(polls, 2);
});
