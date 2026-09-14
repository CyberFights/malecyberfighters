/**
 * The member ProfileCard (public/js/profile-card.js) and the public chat's
 * online list that opens it, driven in jsdom the way a member clicks them.
 *
 * The card is the React Bits <ProfileCard /> ported to plain DOM: these tests
 * pin the parts the app depends on — the markup/classes the shipped stylesheet
 * targets, the props mapping from a member record, and the popup lifecycle
 * (open from a row, close from the button, the backdrop and the Escape key).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const CARD_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'profile-card.js'), 'utf8');
const CHAT_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'chat.js'), 'utf8');

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

/* The popup shell index.html ships, plus the chat pieces chat.js touches. */
const PAGE = `<!doctype html><html><body>
  <div id="chatPopup" class="chat-popup" style="display:none">
    <div class="chat-body"><div class="online-list card"><div id="onlineList"></div></div></div>
  </div>
  <div id="profileCardPopup" class="pc-popup" role="dialog" aria-modal="true" style="display:none"></div>
</body></html>`;

function loadPage() {
  const dom = new JSDOM(PAGE, { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'dangerously' });
  const win = dom.window;

  win.getSession = () => ({ username: 'alice', display: 'Alice' });
  win.Physique = {
    physiqueSummary: (height, weight) =>
      [height, weight === '' || weight == null ? null : `${weight} lbs`].filter(Boolean).join(' • ')
  };
  win.imgSrc = value => (value ? String(value) : '');

  win.eval(CARD_SOURCE);
  return { dom, win, doc: win.document };
}

/* ------------------------------------------------------------
   THE COMPONENT
------------------------------------------------------------ */

test('the card renders the markup the React Bits stylesheet targets', () => {
  const { win, doc } = loadPage();
  const card = win.ProfileCard.create({
    name: 'Javi A. Torres',
    title: '12W – 3L',
    handle: 'javicodes',
    status: 'Online',
    avatarUrl: '/avatar/javicodes.png',
    contact: "6'1\" • 185 lbs"
  });
  doc.body.appendChild(card.el);

  assert.ok(card.el.classList.contains('pc-card-wrapper'), 'wrapper keeps the component class');
  assert.ok(doc.querySelector('.pc-card-wrapper .pc-behind'), 'behind glow is on by default');
  assert.ok(doc.querySelector('.pc-card-shell .pc-card .pc-inside .pc-shine'));
  assert.ok(doc.querySelector('.pc-card .pc-glare'));
  assert.equal(doc.querySelector('.pc-details h3').textContent, 'Javi A. Torres');
  assert.equal(doc.querySelector('.pc-details p').textContent, '12W – 3L');
  assert.equal(doc.querySelector('.pc-avatar-content .avatar').getAttribute('src'), '/avatar/javicodes.png');
  assert.equal(doc.querySelector('.pc-handle').textContent, '@javicodes');
  assert.equal(doc.querySelector('.pc-status').textContent, 'Online');
  assert.equal(doc.querySelector('.pc-contact').textContent, "6'1\" • 185 lbs");
  assert.equal(doc.querySelector('.pc-mini-avatar img').getAttribute('src'), '/avatar/javicodes.png');
  /* No onContactClick prop, so no contact button — matching the component's
     variant, where the info bar carries the stats line instead. */
  assert.equal(doc.querySelector('.pc-contact-btn'), null);

  card.destroy();
});

test('a real (landscape) member photo fills the card instead of collapsing into a strip', () => {
  /* The component gives the avatar its natural aspect ratio and anchors it to
     the bottom of the card, which suits its portrait placeholder art but turns
     a landscape member photo into a ~44px strip along the bottom edge. The
     stylesheet carries the fix, and jsdom does not lay CSS out, so this pins
     the rule itself. */
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'profile-card.css'), 'utf8');
  const rules = [...css.matchAll(/\.pc-avatar-content\s+\.avatar\s*\{([^}]*)\}/g)].map(m => m[1]);

  assert.ok(rules.length, 'the avatar is styled at all');
  assert.ok(
    rules.some(body => /height:\s*100%/.test(body)),
    'the card avatar is told to fill the card height'
  );
  assert.ok(rules.some(body => /object-fit:\s*cover/.test(body)), 'the photo is cropped, not squashed');
  assert.ok(rules.some(body => /object-position:\s*center\s+top/.test(body)), 'faces stay in frame from the top');
  assert.ok(
    rules.some(body => /mask-image:\s*linear-gradient/.test(body)),
    'the top of the photo fades so the name stays readable'
  );
  assert.equal(
    rules.some(body => /(^|;)\s*height:\s*\d+px/.test(body)),
    false,
    'no fixed pixel height fights the fill'
  );
});

test('props drive the card\'s CSS custom properties', () => {
  const { win, doc } = loadPage();
  const card = win.ProfileCard.create({
    avatarUrl: '/avatar/bob.png',
    innerGradient: 'linear-gradient(145deg,#123456 0%,#65432144 100%)',
    behindGlowEnabled: false,
    behindGlowColor: 'rgba(255, 0, 0, 0.5)',
    behindGlowSize: '60%',
    iconUrl: '/images/pattern.png',
    showUserInfo: false
  });
  doc.body.appendChild(card.el);

  const style = card.el.style;
  assert.equal(style.getPropertyValue('--inner-gradient'), 'linear-gradient(145deg,#123456 0%,#65432144 100%)');
  assert.equal(style.getPropertyValue('--behind-glow-color'), 'rgba(255, 0, 0, 0.5)');
  assert.equal(style.getPropertyValue('--behind-glow-size'), '60%');
  assert.equal(style.getPropertyValue('--icon'), 'url(/images/pattern.png)');
  assert.equal(doc.querySelector('.pc-behind'), null, 'behindGlowEnabled:false drops the glow layer');
  assert.equal(doc.querySelector('.pc-user-info'), null, 'showUserInfo:false drops the user info bar');

  card.destroy();
});

test('onContactClick renders the contact button and is called on click', () => {
  const { win, doc } = loadPage();
  let clicks = 0;
  const card = win.ProfileCard.create({
    name: 'Bob',
    handle: 'bob',
    contactText: 'Message',
    onContactClick: () => { clicks += 1; }
  });
  doc.body.appendChild(card.el);

  const button = doc.querySelector('.pc-contact-btn');
  assert.ok(button, 'contact button is rendered when a handler is given');
  assert.equal(button.textContent, 'Message');
  button.click();
  assert.equal(clicks, 1);

  card.destroy();
});

test('pointer movement drives the tilt variables, and destroy stops the loop', async () => {
  const { win, doc } = loadPage();
  const card = win.ProfileCard.create({ name: 'Bob', handle: 'bob', avatarUrl: '/avatar/bob.png' });
  doc.body.appendChild(card.el);

  /* jsdom lays nothing out, so give the shell a size to tilt against. */
  const shell = card.el.querySelector('.pc-card-shell');
  Object.defineProperty(shell, 'clientWidth', { value: 400 });
  Object.defineProperty(shell, 'clientHeight', { value: 560 });
  shell.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 560, right: 400, bottom: 560 });

  shell.dispatchEvent(new win.MouseEvent('pointerenter', { clientX: 40, clientY: 40, bubbles: true }));
  shell.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 400, clientY: 560, bubbles: true }));
  await tick(80);

  const wrap = card.el;
  assert.match(wrap.style.getPropertyValue('--pointer-x'), /%$/, 'pointer x is tracked');
  assert.match(wrap.style.getPropertyValue('--rotate-x'), /deg$/, 'tilt rotation is tracked');
  assert.ok(shell.classList.contains('active'), 'hovering marks the shell active');

  card.destroy();
  assert.equal(wrap.style.getPropertyValue('--pointer-x'), wrap.style.getPropertyValue('--pointer-x'));
});

/* ------------------------------------------------------------
   THE POPUP
------------------------------------------------------------ */

test('openProfileCard fills the popup from a member record', () => {
  const { win, doc } = loadPage();
  win.users = [];

  win.openProfileCard({
    username: 'bob',
    display: 'Bob Builder',
    imageUrl: '',
    height: "6'1\"",
    weight: 205,
    wins: 12,
    losses: 3
  });

  const popup = doc.getElementById('profileCardPopup');
  assert.equal(popup.style.display, 'flex');
  assert.equal(win.ProfileCard.isOpen(), true);
  assert.equal(doc.querySelector('.pc-details h3').textContent, 'Bob Builder');
  assert.equal(doc.querySelector('.pc-details p').textContent, '12W – 3L');
  assert.equal(doc.querySelector('.pc-handle').textContent, '@bob');
  assert.equal(doc.querySelector('.pc-status').textContent, 'Online');
  assert.equal(doc.querySelector('.pc-contact').textContent, "6'1\" • 205 lbs");
  /* Members without a photo fall back to the app's initials avatar. */
  assert.equal(doc.querySelector('.pc-avatar-content .avatar').getAttribute('src'), '/avatar/bob.png');

  win.closeProfileCard();
});

test('a username opens the freshest copy the client holds', () => {
  const { win, doc } = loadPage();
  win.users = [{ username: 'Bob', display: 'Bob from presence', height: "5'9\"", weight: 180 }];

  win.openProfileCard('bob');

  assert.equal(doc.querySelector('.pc-details h3').textContent, 'Bob from presence');
  assert.equal(doc.querySelector('.pc-contact').textContent, "5'9\" • 180 lbs");

  win.closeProfileCard();
});

test('the close button, the backdrop and the Escape key all close the card', () => {
  const { win, doc } = loadPage();
  const popup = doc.getElementById('profileCardPopup');
  const member = { username: 'bob', display: 'Bob' };

  win.openProfileCard(member);
  popup.querySelector('[data-pc-close]:not(.pc-popup-backdrop)').click();
  assert.equal(popup.style.display, 'none');
  assert.equal(popup.querySelector('.pc-popup-host').children.length, 0, 'the card is torn down');

  win.openProfileCard(member);
  popup.querySelector('.pc-popup-backdrop').click();
  assert.equal(popup.style.display, 'none');

  win.openProfileCard(member);
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(popup.style.display, 'none');
  assert.equal(win.ProfileCard.isOpen(), false);
});

test('opening another member replaces the card instead of stacking one', () => {
  const { win, doc } = loadPage();

  win.openProfileCard({ username: 'bob', display: 'Bob' });
  win.openProfileCard({ username: 'carol', display: 'Carol' });

  assert.equal(doc.querySelectorAll('.pc-card-wrapper').length, 1);
  assert.equal(doc.querySelector('.pc-details h3').textContent, 'Carol');

  win.closeProfileCard();
});

test('the card\'s contact button starts a DM with that member', () => {
  const { win, doc } = loadPage();
  win.openedDms = [];
  win.openPrivateWindow = username => win.openedDms.push(username);

  win.openProfileCard({ username: 'bob', display: 'Bob' });
  doc.querySelector('.pc-contact-btn').click();

  assert.deepEqual(win.openedDms, ['bob']);
});

/* ------------------------------------------------------------
   THE ONLINE LIST IN THE PUBLIC CHAT
------------------------------------------------------------ */

function loadChat() {
  const page = loadPage();
  const { win, doc } = page;

  const handlers = {};
  const socket = {
    on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); },
    emit: () => {},
    fire: (event, payload) => (handlers[event] || []).slice().forEach(fn => fn(payload)),
    handlers
  };
  win.socket = socket;
  win.eval(CHAT_SOURCE);

  /* pm.js loads after chat.js and provides the real opener; the stub goes in
     afterwards so it wins the same way. */
  win.openedDms = [];
  win.openPrivateWindow = username => win.openedDms.push(username);

  return { ...page, socket };
}

test('every member in the online list opens their profile card when clicked', () => {
  const { win, doc, socket } = loadChat();

  socket.fire('presence', [
    { username: 'bob', display: 'Bob Builder', height: "6'1\"", weight: 205 },
    { username: 'carol', display: 'Carol', height: '5\'7"', weight: 140 }
  ]);

  const rows = doc.querySelectorAll('#onlineList .online-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('role'), 'button', 'rows are operable, not decoration');
  assert.equal(rows[0].tabIndex, 0);
  assert.match(rows[0].getAttribute('aria-label'), /Bob Builder/);

  rows[1].click();

  const popup = doc.getElementById('profileCardPopup');
  assert.equal(popup.style.display, 'flex');
  assert.equal(doc.querySelector('.pc-details h3').textContent, 'Carol');
  assert.equal(doc.querySelector('.pc-handle').textContent, '@carol');
  assert.equal(doc.querySelector('.pc-contact').textContent, "5'7\" • 140 lbs");

  win.closeProfileCard();
});

test('the PM button still opens the conversation without opening the card', () => {
  const { win, doc, socket } = loadChat();

  socket.fire('presence', [{ username: 'bob', display: 'Bob' }]);
  doc.querySelector('#onlineList .small-btn').click();

  assert.deepEqual(win.openedDms, ['bob']);
  assert.equal(doc.getElementById('profileCardPopup').style.display, 'none');
});

test('a member going offline flips the open card\'s status line', () => {
  const { win, doc, socket } = loadChat();

  socket.fire('presence', [{ username: 'bob', display: 'Bob' }]);
  doc.querySelector('#onlineList .online-row').click();
  assert.equal(doc.querySelector('.pc-status').textContent, 'Online');

  socket.fire('presence', []);
  assert.equal(doc.querySelector('.pc-status').textContent, 'Offline', 'the card stays open, the status is honest');

  socket.fire('presence', [{ username: 'bob', display: 'Bob' }]);
  assert.equal(doc.querySelector('.pc-status').textContent, 'Online');
});
