/** Wrestling scene analysis and concise, faithful Visualize prompts. */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeWrestlingScene,
  sceneContextLines,
  buildSceneContext,
  publicReferenceImages,
  buildPrompt,
  finalizePrompt,
  refinePrompt,
  toPublicImageUrl,
  MAX_PROMPT_CHARS
} = require('../messageMedia');

function config(overrides = {}) {
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
    ...overrides
  };
}

/* ------------------------------------------------------------------ */
/* Scene analysis                                                      */
/* ------------------------------------------------------------------ */

test('analyzeWrestlingScene detects named moves and their category', () => {
  const cases = [
    ['I hoist you up for a vertical suplex yt', 'throw'],
    ['Rex plants Vyxen with a powerbomb', 'throw'],
    ['she locks in a figure-four leglock', 'submission'],
    ['I catch your arm and crank an armbar', 'submission'],
    ['he clamps on a sleeper hold', 'submission'],
    ['I whip you in with a clothesline', 'strike'],
    ['Marco drives a knee into Ty\'s gut', 'strike'],
    ['she hits a top-rope moonsault', 'aerial'],
    ['the ref counts the pinfall', 'pin'],
    ['he straddles my chest and lands blows', 'ground'],
    ['we lock up in the center of the ring', 'standoff']
  ];
  for (const [turn, kind] of cases) {
    const a = analyzeWrestlingScene(turn);
    assert.ok(a.kinds.includes(kind), `expected ${kind} in "${turn}" (got ${a.kinds})`);
    assert.ok(a.cues.length >= 1, `expected an anatomy cue for "${turn}"`);
    assert.equal(new Set(a.cues).size, a.cues.length, 'cues are de-duplicated');
    assert.ok(a.cues.length <= 2, 'at most two cues are kept');
  }
});

test('analyzeWrestlingScene reads first- vs third-person perspective', () => {
  assert.equal(analyzeWrestlingScene('I grab your wrist and twist it').perspective, 'first');
  assert.equal(analyzeWrestlingScene('Marco grabs Ty by the wrist and twists it').perspective, 'third');
  assert.equal(analyzeWrestlingScene('A suplex in the middle of the ring').perspective, 'neutral');
});

test('analyzeWrestlingScene picks a setting from the message and defaults to a ring', () => {
  assert.match(analyzeWrestlingScene('we brawl in the locker room').setting, /private room|locker/i);
  assert.match(analyzeWrestlingScene('training on the gym mat').setting, /grappling mat|gym/i);
  assert.match(analyzeWrestlingScene('under the neon arena lights').setting, /wrestling arena|spotlights/i);
  assert.match(analyzeWrestlingScene('into the turnbuckle').setting, /wrestling ring/i);
  assert.match(analyzeWrestlingScene('we circle each other').setting, /wrestling ring/i);
});

test('analyzeWrestlingScene maps motion to the dominant move kind', () => {
  assert.match(analyzeWrestlingScene('I hit a powerbomb').motion, /lifts, rotates and drives/);
  assert.match(analyzeWrestlingScene('I lock in an armbar').motion, /cinches the hold/);
  assert.match(analyzeWrestlingScene('I land a clothesline').motion, /strike travels and lands/);
  assert.match(analyzeWrestlingScene('the challenger kicks out at two').motion, /kick-out|kick out|heaves the covering/);
});

test('a pin "kick out" is an escape, not a kick strike', () => {
  const a = analyzeWrestlingScene('The crowd goes wild as the challenger kicks out at two.');
  assert.equal(a.kinds[0], 'escape');
  assert.match(a.cues[0], /pin escape/i);
  assert.match(a.motion, /kick-out/i);
});

test('a "hook of the head" grapple is not mislabeled as a punch/strike', () => {
  const a = analyzeWrestlingScene('I hook your head and hoist you up for a suplex');
  assert.equal(a.kinds[0], 'throw');
  assert.match(a.cues[0], /suplex/);
  assert.doesNotMatch(a.cues.join(' '), /fist or forearm connects/);
});

/* ------------------------------------------------------------------ */
/* buildPrompt — faithful wrestling scene                              */
/* ------------------------------------------------------------------ */

test('buildPrompt describes the action once, preserves roles, and uses available references', () => {
  const turn = 'I hook your head and try to hoist you up for a vertical suplex, muscles straining as I lift. yt';
  const p = buildPrompt({ sourceText: turn, mediaType: 'image', scene: { hasReferences: true } });
  assert.match(p, /two adult wrestlers/i);
  assert.match(p, /wrestling ring/i);
  assert.match(p, /I = author; you = opponent/i);
  assert.match(p, /I hook your head and try to hoist you up for a vertical suplex/i);
  assert.match(p, /supplied profile pictures as appearance references/i);
  assert.doesNotMatch(p, /word for word|Move anatomy:|Ignore quoted dialogue|\byt\b/i);
  assert.ok(p.length < 500, 'a normal prompt should remain concise');
});

test('third-person turns keep the named fighters and their action', () => {
  const turn = 'Rex locks Vyxen in a figure-four leglock in the middle of the ring';
  const p = buildPrompt({ sourceText: turn, mediaType: 'image' });
  assert.ok(p.includes(turn));
  assert.doesNotMatch(p, /I = author|supplied profile pictures/i);
});

test('buildPrompt applies the chosen style without redundant aspect instructions', () => {
  const p = buildPrompt({ sourceText: 'Rex lifts Vyxen above the neon ring', mediaType: 'image', style: 'cyberpunk', aspectRatio: '16:9' });
  assert.match(p, /neon cyberpunk/i);
  assert.doesNotMatch(p, /Composition:/i);
});

test('video prompts describe the same move without duplicating motion instructions', () => {
  const video = buildPrompt({ sourceText: 'I land a powerbomb in the ring', mediaType: 'video' });
  assert.match(video, /5-second video/i);
  assert.match(video, /I land a powerbomb in the ring/i);
  assert.equal((video.match(/powerbomb/gi) || []).length, 1);
  assert.doesNotMatch(video, /seamless loop|continuous camera move|Animate this exact action/i);
  assert.match(finalizePrompt(video), /fictional consenting adult/);
});

test('long messages and both safety modes stay within the prompt budget', () => {
  const longTurn = 'I grab you and fight in the ring. '.repeat(60);
  for (const mediaType of ['image', 'video']) {
    const body = buildPrompt({ sourceText: longTurn, mediaType });
    assert.ok(body.length <= MAX_PROMPT_CHARS, `${mediaType} body fits the cap`);
    assert.match(finalizePrompt(body), /fictional consenting adult/);
    assert.doesNotMatch(finalizePrompt(body, { safeMode: false }), /Safety and quality:/);
  }
});

test('the safety filter still rejects genuinely unsafe turns', () => {
  assert.throws(
    () => finalizePrompt(buildPrompt({ sourceText: 'I suplex that child' })),
    err => err.code === 'unsafe_prompt'
  );
});

/* ------------------------------------------------------------------ */
/* Scene context + LLM refiner                                         */
/* ------------------------------------------------------------------ */

test('scene context is passed to the LLM refiner and reused on fallback', async () => {
  const captured = [];
  const fetchImpl = async (url, options) => {
    captured.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'A dramatic wrestling suplex in a neon ring' } }] })
    };
  };
  const scene = { author: 'rival', self: { username: 'alice' }, other: { username: 'rival' }, hasReferences: true };

  const refined = await refinePrompt({
    sourceText: 'I hoist you up for a suplex',
    mediaType: 'image',
    scene,
    config: config({ llmUrl: 'https://llm.example.test/v1/chat/completions' }),
    fetchImpl
  });
  assert.equal(refined.refinedBy, 'llm');
  const system = captured[0].messages[0].content;
  const user = captured[0].messages[1].content;
  assert.match(system, /PRO WRESTLING/i);
  assert.match(system, /Preserve the exact move/i);
  assert.match(system, /first person/i); // scene analysis folded into the system prompt
  assert.match(system, /Move anatomy:.*suplex/i);
  assert.match(user, /a suplex/);
  assert.match(user, /Match turn:/);

  // A failing LLM falls back to the faithful local writer (not a generic scene).
  const fallback = await refinePrompt({
    sourceText: 'I hoist you up for a suplex',
    mediaType: 'image',
    scene,
    config: config({ llmUrl: 'https://llm.example.test/v1/chat/completions' }),
    fetchImpl: async () => { throw new Error('refiner offline'); }
  });
  assert.equal(fallback.refinedBy, 'local');
  assert.match(fallback.prompt, /I hoist you up for a suplex/i);
  assert.match(fallback.prompt, /fictional consenting adult/);
});

test('sceneContextLines marks the two chat members and never pins a reference index', () => {
  const a = analyzeWrestlingScene('I clothesline you');
  const lines = sceneContextLines(a, { self: { username: 'alice' }, other: { username: 'rival' }, author: 'rival', hasReferences: true });
  const joined = lines.join(' ');
  assert.match(joined, /two chat members/i);
  assert.doesNotMatch(joined, /first reference|reference index|image\[0\]/i);
  assert.doesNotMatch(joined, /@rival|alice/, 'no raw usernames leak into the prompt');
});

test('buildSceneContext records the author and detects reference support', () => {
  const participants = {
    self: { username: 'alice', display: 'Alice', imageUrl: 'https://ibb.co/self.jpg' },
    other: { username: 'rival', display: 'Rival', imageUrl: 'https://ibb.co/other.jpg' }
  };
  const plain = buildSceneContext({
    source: { from: 'rival' },
    participants,
    config: config(),
    referenceImages: []
  });
  assert.equal(plain.author, 'rival');
  assert.equal(plain.self.username, 'alice');
  assert.equal(plain.other.username, 'rival');
  assert.equal(plain.hasReferences, false);

  const withKey = buildSceneContext({
    source: { from: 'rival' },
    participants,
    config: config({ mediaKey: 'key', publicBaseUrl: 'https://example.test' }),
    referenceImages: publicReferenceImages(participants, { publicBaseUrl: 'https://example.test' })
  });
  assert.equal(withKey.hasReferences, true);
});

test('publicReferenceImages keeps self then other, de-duplicating identical URLs', () => {
  const participants = {
    self: { imageUrl: 'https://ibb.co/a.jpg' },
    other: { imageUrl: 'https://ibb.co/a.jpg' }
  };
  const cfg = { publicBaseUrl: 'https://example.test' };
  const refs = publicReferenceImages(participants, cfg);
  assert.equal(refs.length, 1);
  assert.equal(refs[0], toPublicImageUrl('https://ibb.co/a.jpg', cfg));
});

test('fig4 around the head is a face-up headscissors, not a leglock', () => {
  const turn = 'Taking you down onto the canvas I wrap my legs around your head and squeeze your head in a fig4 as your laying face up';
  const analysis = analyzeWrestlingScene(turn);
  assert.equal(analysis.kinds[0], 'submission');
  assert.match(analysis.cues[0], /figure-four headscissors/i);
  assert.match(analysis.cues[0], /opponent's head is between the attacker's thighs/i);
  assert.match(analysis.cues[0], /opponent lies face up on the canvas/i);
  assert.doesNotMatch(analysis.cues.join(' '), /twists and crosses the opponent's legs/i);
  assert.match(analysis.motion, /headscissors around the opponent's head/i);
  for (const mediaType of ['image', 'video']) {
    const prompt = finalizePrompt(buildPrompt({ sourceText: turn, mediaType }));
    assert.match(prompt, /figure-four headscissors/i);
    assert.match(prompt, /legs around your head/i);
    assert.match(prompt, /face up/i);
    assert.doesNotMatch(prompt, /Move anatomy:|Match turn \(word for word\)/i);
    assert.ok(prompt.length < 750);
  }
});

test('headscissors wording does not force face-up or turn a figure-four leglock into a headscissors', () => {
  const neutral = analyzeWrestlingScene('I apply a headscissors on the mat');
  assert.match(neutral.cues[0], /headscissors/i);
  assert.doesNotMatch(neutral.cues[0], /face up/i);
  const leglock = analyzeWrestlingScene('I apply a fig4 leglock to your legs');
  assert.match(leglock.cues[0], /leg submission/i);
  assert.doesNotMatch(leglock.cues[0], /headscissors/i);
});

test('LLM refiner receives headscissors context without a contradictory leglock', async () => {
  const turn = 'Taking you down onto the canvas I wrap my legs around your head and squeeze your head in a fig4 as your laying face up';
  let request;
  await refinePrompt({
    sourceText: turn, mediaType: 'image',
    config: config({ llmUrl: 'https://llm.example.test/v1/chat/completions' }),
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Two adult wrestlers in a grounded headscissors' } }] }) };
    }
  });
  const context = request.messages.map(message => message.content).join('\n');
  assert.match(context, /figure-four headscissors/i);
  assert.match(context, /face up on the canvas/i);
  assert.doesNotMatch(context, /twists and crosses the opponent's legs/i);
  assert.ok(context.includes(turn));
});

test('reference context follows the selected provider mode, not the other media type', () => {
  const references = ['https://chat.example.test/a.png', 'https://chat.example.test/b.png'];
  const cfg = config({ imageMode: 'get', videoMode: 'openai' });
  const image = buildSceneContext({ config: cfg, referenceImages: references, mediaType: 'image' });
  const video = buildSceneContext({ config: cfg, referenceImages: references, mediaType: 'video' });
  assert.equal(image.hasReferences, false);
  assert.equal(video.hasReferences, true);
  assert.doesNotMatch(buildPrompt({ sourceText: 'I throw you', scene: image }), /supplied profile pictures/);
  assert.match(buildPrompt({ sourceText: 'I throw you', scene: video }), /supplied profile pictures/);
});
