/**
 * ✨ Visualize — the shared message action and modal, loaded into jsdom with
 * the real features-core.js helper. No page scripts or sockets are needed: the
 * client only needs message-row markup and the message-media API.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'features-core.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'js', 'message-media.js'), 'utf8');

const PUBLIC_ID = 'a'.repeat(24);
const ROOM_ID = 'b'.repeat(24);
const ROOM_MESSAGE_ID = 'c'.repeat(24);
const DM_ID = 'd'.repeat(24);
const GENERATED_ID = 'e'.repeat(24);

const PAGE = `<!doctype html><html><body>
  <div id="roomChatPopup" data-room="${ROOM_ID}">
    <div id="publicFeed" class="public-feed">
      <div class="message-row" data-id="${PUBLIC_ID}">
        <div class="message"><div class="message-text">Rex lands a superplex</div></div>
      </div>
      <div class="message-row" data-id="${GENERATED_ID}" data-generated-media="1">
        <div class="message"><div class="message-text">🎨 AI image from @rival's message</div></div>
      </div>
    </div>
    <div id="roomFeed" class="public-feed">
      <div class="message-row" data-id="${ROOM_MESSAGE_ID}">
        <div class="message"><div class="message-text">The crowd goes wild</div></div>
      </div>
    </div>
    <div id="dmMessages" class="public-feed">
      <div class="message-row" data-dm-id="${DM_ID}">
        <div class="message"><div>Meet me in the ring</div></div>
      </div>
    </div>
    <div id="pmBody_bob">
      <div class="message" data-dm-id="${DM_ID}">
        <div style="font-size:13px;font-weight:700">bob</div>
        <div style="margin-top:6px">Another DM line</div>
      </div>
    </div>
  </div>
</body></html>`;

const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}

async function boot({ videoEnabled = false, generateError = null, generateDetail = '', referenceStatus = 'unsupported' } = {}) {
  const dom = new JSDOM(PAGE, {
    url: 'https://example.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const win = dom.window;
  win.localStorage.setItem('cw_session_v1', JSON.stringify({ username: 'alice', display: 'Alice' }));

  const requests = [];
  win.fetch = async (url, options = {}) => {
    const target = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url: target, body, options });

    if (target.endsWith('/api/message-media/config')) {
      return jsonResponse({
        ok: true,
        mediaTypes: ['image', 'video'],
        videoEnabled,
        styles: [
          { id: 'cinematic', label: 'Cinematic' },
          { id: 'comic', label: 'Comic book' }
        ],
        aspectRatios: [
          { id: '1:1', label: 'Square (1:1)' },
          { id: '16:9', label: 'Landscape (16:9)' }
        ]
      });
    }
    if (target.endsWith('/api/message-media/prompt')) {
      return jsonResponse({
        ok: true,
        target: { scope: body.scope, room: body.room, messageId: body.messageId },
        participants: {
          self: { username: 'alice', display: 'Alice', imageUrl: '/images/mcf-512.png' },
          other: { username: 'rival', display: 'Rival', imageUrl: 'https://i.ibb.co/rival/a.png' }
        },
        sourceText: 'Rex lands a superplex',
        prompt: 'A polished illustration of Rex landing a superplex. Safety and quality: fictional consenting adults.',
        refinedBy: 'local',
        referenceStatus,
        mediaType: body.mediaType,
        style: body.style,
        aspectRatio: body.aspectRatio
      });
    }
    if (target.endsWith('/api/message-media/generate')) {
      if (generateError) {
        return jsonResponse({ ok: false, error: generateError, detail: generateDetail }, 400);
      }
      return jsonResponse({
        ok: true,
        message: { _id: 'f'.repeat(24), scope: body.scope, imageUrl: '/generated/' + '1'.repeat(32) + '.png' },
        prompt: body.prompt
      }, 201);
    }
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  };

  win.eval(CORE);
  win.eval(CLIENT);
  await waitFor(() => win.document.querySelectorAll('.mcf-media-btn').length >= 4);

  return { dom, win, requests };
}

test('decorates arena, room and DM rows exactly once, skipping AI-generated rows', async () => {
  const { dom, win } = await boot();
  try {
    assert.equal(win.document.querySelectorAll('.mcf-media-btn').length, 4);

    const publicTarget = win.MCFMessageMedia.targetFor(
      win.document.querySelector(`#publicFeed .message-row[data-id="${PUBLIC_ID}"]`)
    );
    assert.equal(publicTarget.scope, 'public');
    assert.equal(publicTarget.room, '');
    assert.equal(publicTarget.messageId, PUBLIC_ID);
    assert.equal(publicTarget.sourceText, 'Rex lands a superplex');

    const roomTarget = win.MCFMessageMedia.targetFor(
      win.document.querySelector(`#roomFeed .message-row[data-id="${ROOM_MESSAGE_ID}"]`)
    );
    assert.equal(roomTarget.scope, 'room');
    assert.equal(roomTarget.room, ROOM_ID);
    assert.equal(roomTarget.messageId, ROOM_MESSAGE_ID);

    const dmTarget = win.MCFMessageMedia.targetFor(
      win.document.querySelector(`#dmMessages .message-row[data-dm-id="${DM_ID}"]`)
    );
    assert.equal(dmTarget.scope, 'dm');
    assert.equal(dmTarget.messageId, DM_ID);
    assert.equal(dmTarget.sourceText, 'Meet me in the ring');

    const popupDmTarget = win.MCFMessageMedia.targetFor(
      win.document.querySelector(`#pmBody_bob .message[data-dm-id="${DM_ID}"]`)
    );
    assert.equal(popupDmTarget.scope, 'dm');
    assert.equal(popupDmTarget.sourceText, 'Another DM line');

    assert.equal(
      win.MCFMessageMedia.targetFor(
        win.document.querySelector(`#publicFeed .message-row[data-id="${GENERATED_ID}"]`)
      ),
      null
    );

    // Re-running the observer/scan must not stack duplicate buttons.
    win.MCFMessageMedia.scan(win.document);
    win.MCFMessageMedia.decorate(win.document.querySelector(`#publicFeed .message-row[data-id="${PUBLIC_ID}"]`));
    assert.equal(win.document.querySelectorAll('.mcf-media-btn').length, 4);
  } finally {
    dom.window.close();
  }
});

test('opens a refined prompt, edits it, and posts an image into the arena', async () => {
  const { dom, win, requests } = await boot();
  try {
    win.document.querySelector(`#publicFeed .message-row[data-id="${PUBLIC_ID}"] .mcf-media-btn`).click();

    await waitFor(() => !!win.document.getElementById('mcfMediaPrompt'));
    const promptEl = win.document.getElementById('mcfMediaPrompt');
    assert.equal(await waitFor(() => promptEl.value.includes('A polished illustration')), true);
    assert.match(win.document.getElementById('mcfMediaSource').textContent, /Rex lands a superplex/);
    const participants = win.document.getElementById('mcfMediaParticipants');
    assert.match(participants.textContent, /@alice/);
    assert.match(participants.textContent, /@rival/);
    assert.equal(participants.querySelectorAll('.mcf-media-avatar').length, 2);
    assert.equal(win.document.querySelector('#mcfMediaType option[value="video"]').disabled, true);
    assert.match(win.document.getElementById('mcfMediaStatus').textContent, /Prompt ready/);

    const promptRequest = requests.find(request => request.url.endsWith('/prompt'));
    assert.equal(promptRequest.body.scope, 'public');
    assert.equal(promptRequest.body.messageId, PUBLIC_ID);

    promptEl.value = 'My edited generator prompt';
    promptEl.dispatchEvent(new win.Event('input', { bubbles: true }));
    win.document.getElementById('mcfMediaGenerate').click();

    assert.equal(await waitFor(() => requests.some(request => request.url.endsWith('/generate'))), true);
    const generate = requests.find(request => request.url.endsWith('/generate'));
    assert.equal(generate.body.scope, 'public');
    assert.equal(generate.body.messageId, PUBLIC_ID);
    assert.equal(generate.body.mediaType, 'image');
    assert.equal(generate.body.prompt, 'My edited generator prompt');

    assert.equal(await waitFor(() => !win.document.querySelector('.mcf-modal')), true);
  } finally {
    dom.window.close();
  }
});

test('video option is available when configured and sends the room id', async () => {
  const { dom, win, requests } = await boot({ videoEnabled: true });
  try {
    win.document.querySelector(`#roomFeed .message-row[data-id="${ROOM_MESSAGE_ID}"] .mcf-media-btn`).click();
    await waitFor(() => !!win.document.getElementById('mcfMediaType'));
    const typeEl = win.document.getElementById('mcfMediaType');
    assert.equal(typeEl.querySelector('option[value="video"]').disabled, false);

    typeEl.value = 'video';
    typeEl.dispatchEvent(new win.Event('change', { bubbles: true }));
    await waitFor(() => requests.filter(request => request.url.endsWith('/prompt')).length >= 2);
    await waitFor(() => {
      const button = win.document.getElementById('mcfMediaGenerate');
      const status = win.document.getElementById('mcfMediaStatus');
      return button && !button.disabled && /Prompt ready/.test(status.textContent);
    });

    const promptEl = win.document.getElementById('mcfMediaPrompt');
    promptEl.value = 'A five second dolly shot of the arena';
    promptEl.dispatchEvent(new win.Event('input', { bubbles: true }));
    win.document.getElementById('mcfMediaGenerate').click();

    assert.equal(await waitFor(() => requests.some(request => request.url.endsWith('/generate'))), true);
    const generate = requests.find(request => request.url.endsWith('/generate'));
    assert.equal(generate.body.scope, 'room');
    assert.equal(generate.body.room, ROOM_ID);
    assert.equal(generate.body.messageId, ROOM_MESSAGE_ID);
    assert.equal(generate.body.mediaType, 'video');
    await waitFor(() => !win.document.querySelector('.mcf-modal'));
  } finally {
    dom.window.close();
  }
});

test('a failed generation keeps the dialog open and explains the error', async () => {
  const { dom, win } = await boot({ generateError: 'provider_rate_limited' });
  try {
    win.document.querySelector(`#dmMessages .message-row[data-dm-id="${DM_ID}"] .mcf-media-btn`).click();
    await waitFor(() => !!win.document.getElementById('mcfMediaPrompt'));
    const promptEl = win.document.getElementById('mcfMediaPrompt');
    await waitFor(() => promptEl.value.includes('A polished illustration'));
    win.document.getElementById('mcfMediaGenerate').click();

    assert.equal(
      await waitFor(() => /generator is busy/i.test(win.document.getElementById('mcfMediaStatus').textContent)),
      true
    );
    assert.ok(win.document.querySelector('.mcf-modal'), 'the dialog stays open for a retry');
    assert.equal(win.document.getElementById('mcfMediaGenerate').disabled, false);
  } finally {
    dom.window.close();
  }
});

test('provider failures show the server detail and an actionable message', async () => {
  const cases = [
    ['provider_error', 'upstream flux unavailable (HTTP 503)', /image generator failed/i],
    ['provider_auth', 'the API key was rejected', /API key/i],
    ['provider_refused', 'prompt was refused by the content filter', /refused this prompt/i],
    ['provider_privacy', 'Request blocked by safety filter: privacy', /remove personal details.*names.*contact information/i]
  ];
  for (const [code, detail, expected] of cases) {
    const { dom, win } = await boot({ generateError: code, generateDetail: detail });
    try {
      win.document.querySelector(`#dmMessages .message-row[data-dm-id="${DM_ID}"] .mcf-media-btn`).click();
      await waitFor(() => !!win.document.getElementById('mcfMediaPrompt'));
      const promptEl = win.document.getElementById('mcfMediaPrompt');
      await waitFor(() => promptEl.value.includes('A polished illustration'));
      win.document.getElementById('mcfMediaGenerate').click();
      const status = win.document.getElementById('mcfMediaStatus');
      assert.equal(await waitFor(() => status.textContent.includes(detail)), true, `${code}: detail missing`);
      assert.match(status.textContent, expected, `${code}: actionable text missing`);
      assert.ok(win.document.querySelector('.mcf-modal'), 'the dialog stays open for a retry');
      assert.equal(win.document.getElementById('mcfMediaGenerate').disabled, false);
    } finally {
      dom.window.close();
    }
  }
});

test('a provider detail containing markup is stripped before display', async () => {
  const { dom, win } = await boot({
    generateError: 'provider_error',
    generateDetail: '<img src=x onerror=alert(1)>bad gateway'
  });
  try {
    win.document.querySelector(`#dmMessages .message-row[data-dm-id="${DM_ID}"] .mcf-media-btn`).click();
    await waitFor(() => !!win.document.getElementById('mcfMediaPrompt'));
    const promptEl = win.document.getElementById('mcfMediaPrompt');
    await waitFor(() => promptEl.value.includes('A polished illustration'));
    win.document.getElementById('mcfMediaGenerate').click();
    const status = win.document.getElementById('mcfMediaStatus');
    assert.equal(await waitFor(() => /bad gateway/.test(status.textContent)), true);
    assert.equal(win.document.querySelector('#mcfMediaStatus img'), null, 'markup must not become HTML');
  } finally {
    dom.window.close();
  }
});

test('the dialog distinguishes real appearance references from corner badges', async () => {
  for (const [referenceStatus, expected] of [
    ['unsupported', /corner badges only.*cannot use them as appearance references/i],
    ['missing', /corner badges.*both accessible photos are needed/i],
    ['available', /photos will be sent to the image generator as appearance references.*likeness and pose depend/i]
  ]) {
    const { dom, win } = await boot({ referenceStatus });
    try {
      win.document.querySelector(`#publicFeed .message-row[data-id="${PUBLIC_ID}"] .mcf-media-btn`).click();
      await waitFor(() => win.document.getElementById('mcfMediaPrompt') && win.document.getElementById('mcfMediaPrompt').value);
      assert.match(win.document.getElementById('mcfMediaNote').textContent, expected);
    } finally { dom.window.close(); }
  }
});
