/**
 * Tests for the Assistance window (public/index.html + public/js/assistance.js).
 *
 * The page is loaded into jsdom and assistance.js is evaluated against it, so
 * these run the real assistant against the real markup: the real action-row
 * buttons, the real popup ids and the real /images/jax*.jpg paths.
 *
 * dm-toggle.js is evaluated too, because it is the app's real wiring for the
 * DMs and Rooms buttons — that is what proves the assistant opens a window by
 * driving the page's own controls instead of a copy of their logic.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const PAGE = read('public', 'index.html');
const ASSISTANCE = read('public', 'js', 'assistance.js');
const DM_TOGGLE = read('public', 'js', 'dm-toggle.js');

const JAX = ['jax1.jpg', 'jax2.jpg', 'jax3.jpg'];

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

/** Boots index.html with the assistant (and the real DMs/Rooms wiring) live. */
async function startPage({ signedIn = false } = {}) {
  const dom = new JSDOM(PAGE, {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });
  const win = dom.window;

  // Room creation asks for a name through prompt(); keep it inert here.
  win.prompt = () => 'Test Room';
  win.confirm = () => false;

  if (signedIn) {
    win.localStorage.setItem('cw_session_v1', JSON.stringify({ username: 'bob', display: 'Bob' }));
  }

  win.eval(DM_TOGGLE);
  win.eval(ASSISTANCE);

  await new Promise(resolve => {
    if (win.document.readyState !== 'loading') return resolve();
    win.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

  const doc = win.document;

  return {
    win,
    doc,
    byId: id => doc.getElementById(id),
    /** The Assistance button the desktop action row shows. */
    assistanceButton: () => doc.querySelectorAll('[id="btnAssistance"]')[1],
    popup: () => doc.getElementById('assistancePopup'),
    display: id => (doc.getElementById(id) || {}).style?.display,
    messages: () => Array.from(doc.querySelectorAll('#assistanceMessages .assistance-msg'))
      .filter(el => !el.classList.contains('assistance-typing')),
    lastMessage: () => {
      const list = Array.from(doc.querySelectorAll('#assistanceMessages .assistance-msg'))
        .filter(el => !el.classList.contains('assistance-typing'));
      return list[list.length - 1] || null;
    },
    /** Ask a question and wait for the reply to land. */
    async ask(text) {
      win.Assistance.ask(text);
      await tick(700);
    },
    async close() {
      await tick(100);
      win.close();
    }
  };
}

test('the action rows both carry an Assistance button', async () => {
  const page = await startPage();
  try {
    const buttons = page.doc.querySelectorAll('[id="btnAssistance"]');
    assert.equal(buttons.length, 2, 'mobile and desktop action rows');
    buttons.forEach(button => {
      assert.equal(button.textContent.trim(), 'Assistance');
      assert.ok(button.parentElement.classList.contains('actions'), 'lives in the action row');
    });
    assert.ok(PAGE.includes('/js/assistance.js'), 'the page loads assistance.js');
  } finally {
    await page.close();
  }
});

test('the window holds a portrait, a chat box and an input bar with Send', async () => {
  const page = await startPage();
  try {
    assert.equal(page.display('assistancePopup'), 'none');

    page.assistanceButton().click();

    assert.equal(page.display('assistancePopup'), 'flex', 'the Assistance button opens the window');
    assert.ok(page.byId('assistanceMessages'), 'chat message box');
    assert.ok(page.byId('assistanceInput'), 'chat input');
    assert.equal(page.byId('assistanceSend').textContent.trim(), 'Send');
    assert.ok(
      page.messages().some(m => m.classList.contains('assistant')),
      'the assistant greets the user on first open'
    );
  } finally {
    await page.close();
  }
});

test('the portrait above the chat box is a random Jax image', async () => {
  const page = await startPage();
  try {
    const seen = new Set();

    for (let i = 0; i < 6; i++) {
      page.assistanceButton().click();
      const src = page.byId('assistanceImage').getAttribute('src');
      assert.match(src, /^\/images\/jax[123]\.jpg$/, `portrait was "${src}"`);
      seen.add(src);
      page.byId('assistanceClose').click();
    }

    assert.ok(seen.size > 1, 'opening the window repeatedly re-rolls the portrait');

    // Every portrait the assistant can pick is a file that ships with the site.
    JAX.forEach(file => {
      assert.ok(fs.existsSync(path.join(ROOT, 'public', 'images', file)), `${file} exists`);
    });
    page.win.Assistance.images.forEach(src => {
      assert.ok(JAX.includes(src.replace('/images/', '')), `${src} is one of the Jax portraits`);
    });
  } finally {
    await page.close();
  }
});

test('every answer can open a window that really exists on the page', async () => {
  const page = await startPage();
  try {
    const topics = page.win.Assistance.topics;
    assert.ok(topics.length >= 20, `topic list has ${topics.length} entries`);

    topics.forEach(topic => {
      assert.ok(topic.answer && topic.answer.length > 20, `${topic.id} explains something`);
      assert.ok(topic.keywords.length, `${topic.id} has keywords`);
      if (!topic.action) return;

      const controls = page.doc.querySelectorAll(`[id="${topic.action.buttonId}"]`);
      assert.ok(controls.length, `${topic.id}: #${topic.action.buttonId} is on the page`);
      if (topic.action.popupId) {
        assert.ok(page.byId(topic.action.popupId), `${topic.id}: #${topic.action.popupId} is on the page`);
      }
      if (topic.action.then) {
        assert.ok(
          page.doc.querySelectorAll(`[id="${topic.action.then}"]`).length,
          `${topic.id}: follow-up #${topic.action.then} is on the page`
        );
      }
    });
  } finally {
    await page.close();
  }
});

test('a question about the site is explained, not acted on', async () => {
  const page = await startPage();
  try {
    page.assistanceButton().click();
    await page.ask('how do I send a direct message?');

    const reply = page.lastMessage();
    assert.ok(reply.classList.contains('assistant'));
    assert.match(reply.textContent, /DMs window/, 'explains where DMs live');

    // Nothing was opened just because the user asked how it works.
    assert.notEqual(page.display('dmSidebar'), 'flex');

    // ...but the explanation offers to do it, and that really opens the
    // DM sidebar through the app's own btnDMs handler (dm-toggle.js).
    const openButton = reply.querySelector('.assistance-actions button');
    assert.equal(openButton.textContent, 'Open DMs');
    openButton.click();

    assert.equal(page.display('dmSidebar'), 'flex', 'the DMs window opened');
    assert.equal(page.display('assistancePopup'), 'none', 'the assistant steps aside');
  } finally {
    await page.close();
  }
});

test('being asked to open something opens that window straight away', async () => {
  const page = await startPage();
  try {
    page.assistanceButton().click();
    assert.equal(page.display('assistancePopup'), 'flex');

    await page.ask('open the rooms');

    assert.equal(page.display('roomsSidebar'), 'flex', 'the Rooms window opened');
    assert.equal(page.display('assistancePopup'), 'none', 'the assistant stepped aside');
    assert.match(page.messages().at(-1).textContent, /Opening the Rooms/);
  } finally {
    await page.close();
  }
});

test('the quick questions under the portrait ask themselves', async () => {
  const page = await startPage();
  try {
    page.assistanceButton().click();

    const chips = page.doc.querySelectorAll('#assistanceQuickReplies button');
    assert.ok(chips.length >= 4, `${chips.length} quick questions offered`);
    assert.equal(chips[0].textContent, 'Open the Arena');

    chips[0].click();
    await tick(700);

    assert.equal(page.messages().at(-2).textContent, 'Open the Arena', 'the chip asks its question');
    assert.match(page.messages().at(-1).textContent, /Opening the Arena/);
    assert.equal(page.display('chatPopup'), 'flex', 'the Arena opened for them');
    assert.equal(page.display('assistancePopup'), 'none');
  } finally {
    await page.close();
  }
});

test('the input bar sends from the Send button and from Enter', async () => {
  const page = await startPage();
  try {
    page.assistanceButton().click();
    const input = page.byId('assistanceInput');
    const send = page.byId('assistanceSend');

    input.value = 'where are the story archives?';
    send.click();
    assert.equal(input.value, '', 'the input clears after sending');
    assert.equal(page.messages().at(-1).textContent, 'where are the story archives?');

    await tick(700);
    assert.match(page.lastMessage().textContent, /Archives/);

    input.value = 'what are the rules here?';
    input.dispatchEvent(new page.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(input.value, '', 'Enter sends too');
    await tick(700);
    assert.match(page.lastMessage().textContent, /Site Rules/);
  } finally {
    await page.close();
  }
});

test('a question it does not know offers the support report', async () => {
  const page = await startPage();
  try {
    page.assistanceButton().click();
    await page.ask('what is the airspeed velocity of an unladen swallow?');

    const reply = page.lastMessage();
    assert.match(reply.textContent, /support report/);

    reply.querySelector('.assistance-actions button').click();
    assert.equal(page.display('supportPopup'), 'flex', 'the support report form opened');
  } finally {
    await page.close();
  }
});

test('account windows need a sign-in, and the assistant opens Login instead', async () => {
  const page = await startPage();
  try {
    page.assistanceButton().click();
    await page.ask('how do I change my password?');

    const reply = page.lastMessage();
    assert.match(reply.textContent, /signed out/);
    assert.equal(reply.querySelector('.assistance-actions button').textContent, 'Open Login');

    reply.querySelector('.assistance-actions button').click();
    assert.equal(page.display('modalLogin'), 'flex');
  } finally {
    await page.close();
  }
});

test('signed in, "change my password" opens Account Settings for them', async () => {
  const page = await startPage({ signedIn: true });
  try {
    page.assistanceButton().click();
    await page.ask('change my password');

    assert.equal(page.display('modalAccountSettings'), 'flex');
    assert.equal(page.display('assistancePopup'), 'none');
  } finally {
    await page.close();
  }
});

test('the transcript survives closing, and Escape / backdrop close the window', async () => {
  const page = await startPage();
  try {
    page.assistanceButton().click();
    await page.ask('how do I report a problem?');
    const before = page.messages().length;
    assert.ok(before >= 3, 'greeting + question + answer');

    page.doc.dispatchEvent(new page.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(page.display('assistancePopup'), 'none', 'Escape closes it');

    page.assistanceButton().click();
    assert.equal(page.messages().length, before, 'the conversation is still there');

    page.popup().dispatchEvent(new page.win.MouseEvent('click', { bubbles: true }));
    assert.equal(page.display('assistancePopup'), 'none', 'clicking the backdrop closes it');
  } finally {
    await page.close();
  }
});
