/**
 * The federation a member wrestles for, shown on their profile.
 *
 * Three places draw a profile — the desktop view-profile modal (chat.js), the
 * phone's modal (mobile.js) and the floating ProfileCard the online list
 * opens — and all three read the name through MCF.federationName. These tests
 * drive the real scripts so the row cannot drift from the markup the pages
 * ship, and check that a member with no federation gets no empty field.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const PAGE = read('public', 'index.html');
const MOBILE = read('public', 'mobile.html');
const CORE = read('public', 'js', 'features-core.js');
const CHAT = read('public', 'js', 'chat.js');
const MOBILE_JS = read('public', 'js', 'mobile.js');
const CARD = read('public', 'js', 'profile-card.js');

const FEDERATED = {
  username: 'heeler',
  display: 'Heeler',
  info: 'Boots and a bad attitude.',
  wins: 4,
  losses: 1,
  federation: { id: 'fed1', name: 'Iron Ring Federation', role: 'member' }
};

const LONER = {
  username: 'jobber',
  display: 'Jobber Kid',
  info: 'Happy to be here.',
  wins: 0,
  losses: 9,
  federation: null
};

/* ---------------------------------------------------------------
   The shared reading of a member's federation
--------------------------------------------------------------- */

test('MCF.federationName reads the federation off a member record', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://mcf.test/',
    runScripts: 'outside-only'
  });
  const { window } = dom;
  window.eval(CORE);

  assert.equal(window.MCF.federationName(FEDERATED), 'Iron Ring Federation');
  assert.equal(window.MCF.federationName({ federation: { name: '  Steel Cage  ' } }), 'Steel Cage', 'trimmed');
  assert.equal(window.MCF.federationName(LONER), '');
  assert.equal(window.MCF.federationName({}), '');
  assert.equal(window.MCF.federationName(null), '');
  assert.equal(window.MCF.federationName({ federation: { name: '' } }), '');

  window.close();
});

/* ---------------------------------------------------------------
   The desktop view-profile modal, through the real chat.js
--------------------------------------------------------------- */

const PROFILE_PAGE = `<!doctype html><html><body>
  <div id="modalRoster" style="display:none">
    <input id="rosterSearch" type="text">
    <select id="rosterTagFilter"></select>
    <button id="rosterTagClear" type="button" style="display:none">Clear</button>
    <div id="rosterPage"></div>
    <span id="rosterPageNumber"></span>
    <button id="rosterPrev"></button><button id="rosterNext"></button>
    <button id="rosterClose"></button>
  </div>
  <div id="modalViewProfile" style="display:none">
    <h3 id="vpName"></h3><span id="vpUsername"></span>
    <div id="vpLastSeen"></div>
    <div id="vpFederationRow" style="display:none"><div id="vpFederation"></div></div>
    <div id="vpBio"></div><div id="vpTags"></div><div id="vpExtraPhotos"></div>
    <div id="vpWins"></div><div id="vpLosses"></div><div id="vpLang"></div>
    <div id="vpAge"></div><div id="vpHeight"></div><div id="vpWeight"></div>
    <div id="vpColorBox"></div><img id="vpAvatar">
    <button id="vpDMButton"></button><button id="vpBlockButton"></button>
    <div id="vpRelationshipSection"><select id="vpRelationshipSelect"></select></div>
    <button id="vpRelationshipSend"></button>
    <div id="profileStories"></div><div id="profileRelationships"></div><div id="profileTimeline"></div>
  </div>
</body></html>`;

function loadProfilePage() {
  const dom = new JSDOM(PROFILE_PAGE, { url: 'http://localhost/', runScripts: 'dangerously' });
  const win = dom.window;

  win.getSession = () => ({ username: 'alice', display: 'Alice' });
  win.escapeHtml = value => String(value == null ? '' : value);
  win.chatImgSrc = value => (value ? String(value) : '');
  win.imgSrc = win.chatImgSrc;
  // The profile kicks off stories / relationships / timeline loads; leaving
  // them pending keeps them from running after the window is closed.
  const pending = () => new Promise(() => {});
  win.authFetch = pending;
  win.fetch = pending;
  // chat.js registers presence handlers at load, so the page brings a socket.
  win.socket = { on: () => {}, emit: () => {} };

  win.eval(CORE);
  win.eval(CHAT);

  win.allUsers = [FEDERATED, LONER];
  return { dom, win, doc: win.document };
}

test('the desktop profile names the federation the member is in', () => {
  const { win, doc } = loadProfilePage();

  win.openUserProfile('heeler');

  const row = doc.getElementById('vpFederationRow');
  assert.equal(doc.getElementById('vpFederation').textContent, 'Iron Ring Federation');
  assert.equal(row.style.display, '', 'the row is shown');
  assert.match(row.textContent, /Federation/);

  win.close();
});

test('a member with no federation gets no federation row at all', () => {
  const { win, doc } = loadProfilePage();

  // Open the federated member first, so a stale name would be caught below.
  win.openUserProfile('heeler');
  win.openUserProfile('jobber');

  assert.equal(doc.getElementById('vpFederation').textContent, '');
  assert.equal(doc.getElementById('vpFederationRow').style.display, 'none');

  win.close();
});

/* ---------------------------------------------------------------
   The floating ProfileCard
--------------------------------------------------------------- */

function loadCardPage() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });
  const win = dom.window;

  win.getSession = () => ({ username: 'alice', display: 'Alice' });
  win.Physique = { physiqueSummary: (height, weight) => [height, weight == null ? null : `${weight} lbs`].filter(Boolean).join(' • ') };
  win.imgSrc = value => (value ? String(value) : '');

  win.eval(CORE);
  win.eval(CARD);
  return { dom, win, doc: win.document };
}

test('the profile card carries the federation under the handle', () => {
  const { win, doc } = loadCardPage();

  win.openProfileCard(FEDERATED);

  assert.equal(doc.querySelector('.pc-handle').textContent, '@heeler');
  assert.equal(doc.querySelector('.pc-federation').textContent, 'Iron Ring Federation');

  win.closeProfileCard();
  win.openProfileCard(LONER);

  assert.equal(doc.querySelector('.pc-federation'), null, 'no federation, no line');

  win.close();
});

test('ProfileCard.federationFor is the card’s own way of reading it', () => {
  const { win } = loadCardPage();

  assert.equal(win.ProfileCard.federationFor(FEDERATED), 'Iron Ring Federation');
  assert.equal(win.ProfileCard.federationFor(LONER), '');
  assert.equal(win.ProfileCard.federationFor({ federation: { name: 'Apex Club' } }), 'Apex Club');

  win.close();
});

/* ---------------------------------------------------------------
   The pages and the scripts behind them
--------------------------------------------------------------- */

test('both pages ship the federation row in their profile modal', () => {
  [PAGE, MOBILE].forEach((page, index) => {
    const dom = new JSDOM(page);
    const { document } = dom.window;
    const where = index === 0 ? 'desktop' : 'phone';

    assert.ok(document.getElementById('vpFederationRow'), `the row exists on the ${where} page`);
    assert.ok(document.getElementById('vpFederation'), `the slot exists on the ${where} page`);
    assert.match(
      document.getElementById('vpFederationRow').textContent,
      /Federation/,
      `the ${where} profile labels it`
    );

    dom.window.close();
  });
});

test('both profile renderers fill the row from the member record', () => {
  assert.match(CHAT, /vpFederationRow/, 'the desktop profile sets the row');
  assert.match(CHAT, /vpFederation'\)\.textContent/, 'the desktop profile names the federation');
  assert.match(MOBILE_JS, /vpFederationRow/, 'the phone profile sets the row');
  assert.match(MOBILE_JS, /federationName/, 'the phone profile names the federation');
  assert.match(CARD, /federationFor/, 'the card reads the federation too');

  // The records the profiles are built from must carry it: /api/allUsers for
  // the roster and every profile open, the presence feed for the live list.
  const server = read('index.js');
  assert.match(server, /\.select\("username display[^"]*federation[^"]*"\)/, '/api/allUsers selects the federation');
  assert.equal(
    (server.match(/role federation createdAt -_id/g) || []).length,
    3,
    'every presence broadcast carries the federation'
  );
});

test('the helper is exported with the rest of the shared core', () => {
  assert.match(CORE, /federationName: federationName/);
  assert.match(CARD, /federationFor,/);
});
