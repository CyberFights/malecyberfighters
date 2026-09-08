/**
 * Tests for the Beginner's Guide (public/guide.html + public/js/guide.js).
 *
 * The guide lives twice: as the public, indexable page at /guide, and as the
 * in-app Beginner's Guide modal. The page is loaded into jsdom together with
 * guide.js, and window.fetch is stubbed to serve the real guide.html — that
 * proves the modal really loads its content from /guide and that only the
 * #guideBody markup is injected, so both presentations share one copy of
 * the text.
 *
 * assistance.js is evaluated for the "how do I cyber wrestle" topic test:
 * the assistant's guide answer has to drive the real btnGuide handler.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const PAGE = read('public', 'index.html');
const GUIDE_JS = read('public', 'js', 'guide.js');
const GUIDE_HTML = read('public', 'guide.html');
const ASSISTANCE = read('public', 'js', 'assistance.js');
const SERVER = read('index.js');
const SITEMAP = read('public', 'sitemap.xml');
const ROBOTS = read('public', 'robots.txt');
const DESKTOP_CSS = read('public', 'css', 'desktop.css');
const MOBILE_CSS = read('public', 'css', 'mobile.css');

const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

/** A fetch() stub that serves guide.html for /guide and counts the calls. */
function stubFetch({ fail = false } = {}) {
  const calls = [];
  const fn = (url) => {
    calls.push(String(url));
    if (fail || String(url) !== '/guide') {
      return Promise.reject(new Error('network error'));
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve(GUIDE_HTML) });
  };
  fn.calls = calls;
  return fn;
}

/** Boots index.html with guide.js (and optionally assistance.js) live. */
async function startPage({ withAssistance = false, fetchStub = stubFetch() } = {}) {
  const dom = new JSDOM(PAGE, {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });
  const win = dom.window;

  win.fetch = fetchStub;

  win.eval(GUIDE_JS);
  if (withAssistance) win.eval(ASSISTANCE);

  await new Promise(resolve => {
    if (win.document.readyState !== 'loading') return resolve();
    win.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

  const doc = win.document;

  return {
    win,
    doc,
    byId: id => doc.getElementById(id),
    fetchStub,
    buttons: () => doc.querySelectorAll('[id="btnGuide"]'),
    /** The Beginner's Guide button the desktop action row shows. */
    desktopButton: () => doc.querySelectorAll('[id="btnGuide"]')[1],
    modal: () => doc.getElementById('modalGuide'),
    display: id => (doc.getElementById(id) || {}).style?.display,
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

test('both action rows carry a Beginner\'s Guide button', async () => {
  const page = await startPage();
  try {
    const buttons = page.buttons();
    assert.equal(buttons.length, 2, 'mobile and desktop action rows');
    buttons.forEach(button => {
      assert.equal(button.textContent.trim(), "Beginner's Guide");
      assert.ok(button.parentElement.classList.contains('actions'), 'lives in the action row');
    });
    assert.ok(PAGE.includes('/js/guide.js'), 'the page loads guide.js');
    assert.ok(PAGE.includes('id="modalGuide"'), 'the guide modal is on the page');
  } finally {
    await page.close();
  }
});

test('the button opens the modal and loads the /guide page into it', async () => {
  const page = await startPage();
  try {
    assert.equal(page.display('modalGuide'), 'none');

    page.desktopButton().click();

    assert.equal(page.display('modalGuide'), 'flex', 'the Beginner\'s Guide button opens the modal');
    await tick(100);

    assert.deepEqual(page.fetchStub.calls, ['/guide'], 'the guide page was fetched once');

    const content = page.byId('guideContent');
    assert.ok(content.textContent.includes('What is cyber wrestling?'), 'the guide body was injected');
    assert.ok(content.querySelector('#guide-what'), 'section anchors come along');
    assert.equal(content.querySelector('#guideBody'), null, 'only the #guideBody markup is used');
    assert.ok(!content.textContent.includes('Loading'), 'the loading placeholder is gone');
  } finally {
    await page.close();
  }
});

test('the guide is fetched once and reused when the modal reopens', async () => {
  const page = await startPage();
  try {
    page.desktopButton().click();
    await tick(100);
    page.byId('closeGuide').click();

    page.buttons()[0].click(); // the mobile action row copy this time
    await tick(100);

    assert.equal(page.display('modalGuide'), 'flex');
    assert.equal(page.fetchStub.calls.length, 1, 'still just one fetch of /guide');
    assert.ok(page.byId('guideContent').textContent.includes('quick-start checklist'));
  } finally {
    await page.close();
  }
});

test('Escape, the backdrop and the Close button all close the modal', async () => {
  const page = await startPage();
  try {
    page.desktopButton().click();
    await tick(50);
    assert.equal(page.display('modalGuide'), 'flex');

    page.doc.dispatchEvent(new page.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(page.display('modalGuide'), 'none', 'Escape closes it');

    page.desktopButton().click();
    page.modal().dispatchEvent(new page.win.MouseEvent('click', { bubbles: true }));
    assert.equal(page.display('modalGuide'), 'none', 'clicking the backdrop closes it');

    page.desktopButton().click();
    page.byId('closeGuide').click();
    assert.equal(page.display('modalGuide'), 'none', 'the Close button closes it');
  } finally {
    await page.close();
  }
});

test('a failed load says so instead of showing an empty window', async () => {
  const page = await startPage({ fetchStub: stubFetch({ fail: true }) });
  try {
    page.desktopButton().click();
    await tick(100);

    const content = page.byId('guideContent');
    assert.match(content.textContent, /could not be loaded/i);
    assert.ok(content.textContent.includes('/guide'), 'points at the public page');
  } finally {
    await page.close();
  }
});

test('the assistant answers how-to-wrestle questions with the guide', async () => {
  const page = await startPage({ withAssistance: true });
  try {
    // The topic drives the real btnGuide wiring (guide.js).
    const topic = page.win.Assistance.topics.find(t => t.id === 'how-to-wrestle');
    assert.ok(topic, 'the beginner\'s guide topic exists');
    assert.equal(topic.action.buttonId, 'btnGuide');
    assert.equal(topic.action.popupId, 'modalGuide');

    // A quick question about it is one of the chips under the portrait
    // (the chips render when the Assistance window opens).
    page.byId('btnAssistance').click();
    const chips = page.doc.querySelectorAll('#assistanceQuickReplies button');
    assert.ok(
      Array.from(chips).some(c => c.textContent.includes('cyber wrestle')),
      'a quick question points at the guide'
    );

    await page.ask('how do I cyber wrestle?');

    const reply = Array.from(page.doc.querySelectorAll('#assistanceMessages .assistance-msg'))
      .filter(el => !el.classList.contains('assistance-typing'))
      .pop();
    assert.match(reply.textContent, /Beginner/i, 'the answer points at the guide');

    // The offered button opens the guide modal through btnGuide's own handler.
    const openButton = reply.querySelector('.assistance-actions button');
    assert.equal(openButton.textContent, 'Open the Beginner\u2019s Guide');
    openButton.click();

    assert.equal(page.display('modalGuide'), 'flex', 'the guide modal opened');
    await tick(100);
    assert.ok(page.byId('guideContent').textContent.includes('cyber wrestling'), 'the guide loaded');
  } finally {
    await page.close();
  }
});

test('the guide body is one numbered tour with a nav link for every stop', () => {
  const dom = new JSDOM(GUIDE_HTML);
  const doc = dom.window.document;

  const nav = Array.from(doc.querySelectorAll('.guide-nav a'));
  assert.ok(nav.length >= 12, 'every section is reachable from the sticky nav');
  nav.forEach(link => {
    const hash = link.getAttribute('href');
    assert.match(hash, /^#guide-/, `${link.textContent}: nav links point at guide anchors`);
    assert.ok(doc.querySelector(`#guideBody ${hash}`), `${hash} exists inside the shared guide body`);
  });

  // Sections are numbered in order, and the numbers match their position —
  // renumbering the guide means editing the headings, not the nav.
  const headings = Array.from(doc.querySelectorAll('#guideBody > section > h2'));
  assert.equal(headings.length, nav.length, 'one nav link per section');
  headings.forEach((h2, i) => {
    assert.ok(h2.textContent.trim().startsWith(`${i + 1}. `), `section ${i + 1} is numbered "${h2.textContent.trim()}"`);
  });

  // Cross-references inside the prose still land on real sections.
  Array.from(doc.querySelectorAll('#guideBody a[href^="#"]')).forEach(a => {
    assert.ok(doc.getElementById(a.getAttribute('href').slice(1)), `the guide links to ${a.getAttribute('href')}`);
  });
});

test('the guide teaches the classic rules of cyber fighting, not just the app', () => {
  const dom = new JSDOM(GUIDE_HTML);
  const text = dom.window.document.getElementById('guideBody').textContent;

  // A move is a movement plus one or two actions, and the turn ends with "yt".
  assert.match(text, /one or two actions/i, 'a move is defined');
  assert.match(text, /\byt\b/, 'the turn signal is taught');
  assert.match(text, /block, an escape, a reversal|block, escape, reversal/i, 'defensive actions count as moves');

  // Realism: condition, position, flexibility, and no godmodding.
  ['physical condition', 'position', 'flexibility', 'sell', 'accept defeat'].forEach(term => {
    assert.ok(text.toLowerCase().includes(term.toLowerCase()), `the rules cover "${term}"`);
  });

  // Both narration styles are welcome.
  assert.match(text, /First person/, 'first person is explained');
  assert.match(text, /third person/i, 'third person is explained');

  // The eight rules are all there, numbered, and fun comes last.
  const rules = dom.window.document.querySelectorAll('#guide-rules ol > li');
  assert.equal(rules.length, 8, 'eight rules of the ring');
  assert.match(rules[7].textContent, /fun/i, 'the last rule is the important one');

  // Style vocabulary the scene expects you to know.
  ['Pro wrestling', 'Sub wrestling', 'Accepted sub', 'NHB', 'Anything goes', 'Extreme',
   'Death match', 'Fistfight', 'Boxing', 'Kickboxing', 'Catfight', 'Apartment wrestling',
   'Sexfight', 'Multi-round', 'Image / GIF match'].forEach(style => {
    assert.ok(text.includes(style), `the style list covers ${style}`);
  });

  // Win conditions, with the site's own engine named next to each.
  ['three-count pin', 'I give', 'Knockout', 'asphyxiation'].forEach(term => {
    assert.ok(text.toLowerCase().includes(term.toLowerCase()), `the finishes cover "${term}"`);
  });
  assert.match(text, /\/move pin/, 'the pin is tied to the dice command');
  assert.match(text, /\/move escape/, 'escaping a hold is tied to the dice command');

  // Everything that looks optional is consent-first.
  assert.match(text, /opt-in/i, 'the erotic conventions are explicitly opt-in');
  assert.match(text, /never a default|never something you inherit/i, 'adult content is never assumed');

  // New terms are defined for the reader, not just named.
  const glossary = dom.window.document.getElementById('guide-glossary');
  const defined = Array.from(glossary.querySelectorAll('dt')).map(dt => dt.textContent.trim().toLowerCase());
  ['yt', 'move / turn', 'nhb', 'accepted sub', 'catfight', 'pin / three-count', 'knockout (ko)'].forEach(term => {
    assert.ok(defined.some(dt => dt.includes(term)), `the glossary defines "${term}"`);
  });
});

test('the in-app modal carries the merged sections too', async () => {
  const page = await startPage();
  try {
    page.desktopButton().click();
    await tick(100);

    const content = page.byId('guideContent');
    assert.ok(content.querySelector('#guide-styles'), 'match styles come into the modal');
    assert.ok(content.querySelector('#guide-rules'), 'the eight rules come into the modal');
    assert.match(content.textContent, /Match styles/, 'the styles section is readable there');
    assert.match(content.textContent, /eight rules/i, 'the rules section is readable there');
  } finally {
    await page.close();
  }
});

test('the public page, the app and the server all point at the same guide', () => {
  // The public page is a real, indexable document.
  assert.match(GUIDE_HTML, /<link rel="canonical" href="https:\/\/male-cyber-fighters\.com\/guide"/);
  assert.match(GUIDE_HTML, /<meta name="rating" content="adult">/);
  assert.match(GUIDE_HTML, /<link rel="stylesheet" href="\/css\/guide\.css">/);
  assert.match(GUIDE_HTML, /id="guideBody"/);
  assert.match(GUIDE_HTML, /18\+/);
  assert.match(GUIDE_HTML, /og:url" content="https:\/\/male-cyber-fighters\.com\/guide"/);

  // The guide teaches the real match commands and stats.
  ['/create-game', '/join-game', '/move attack', '/move submission', '/move escape',
   '/move teasing', '/move pin', '/move recover', '/game-state', '/end-game',
   '/get-move', '/help'].forEach(command => {
    assert.ok(GUIDE_HTML.includes(command), `the guide covers ${command}`);
  });
  ['ATK', 'DEF', 'SlamDB', 'Arena', 'sell', 'godmodding'].forEach(term => {
    assert.ok(GUIDE_HTML.includes(term), `the guide explains "${term}"`);
  });

  // The server serves it at the canonical /guide URL.
  assert.match(SERVER, /app\.get\('\/guide'/, 'index.js registers the /guide route');

  // Discovery: sitemap lists it, robots keeps the static-file duplicate out.
  assert.ok(SITEMAP.includes('https://male-cyber-fighters.com/guide'), 'sitemap lists /guide');
  assert.ok(ROBOTS.includes('Disallow: /guide.html'), 'robots blocks the /guide.html duplicate');

  // Both UIs style the injected guide content.
  [DESKTOP_CSS, MOBILE_CSS].forEach(css => {
    assert.ok(css.includes('#guideContent'), 'the stylesheet covers the guide modal content');
  });
});
