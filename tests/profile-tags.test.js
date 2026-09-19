/**
 * Tests for the tag UI (public/js/tags.js + public/js/profile-tags.js) and the
 * roster search built on it (public/js/chat.js, public/js/mobile.js).
 *
 * The picker is the register / edit-profile half of the feature and the roster
 * search is the other half, so these run the real scripts against the real
 * shells: the widget on its own in jsdom, the desktop roster through chat.js
 * (the same way profile-card.test.js drives it), and a wiring check that all
 * three shells actually ship the containers and the two scripts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const TAGS_SOURCE = read('public', 'js', 'tags.js');
const PROFILE_TAGS_SOURCE = read('public', 'js', 'profile-tags.js');
const CHAT_SOURCE = read('public', 'js', 'chat.js');

/** jsdom objects come from the page's realm; compare plain copies. */
const plain = value => JSON.parse(JSON.stringify(value));

const MEMBERS = [
  {
    username: 'heeler', display: 'Heeler',
    createdAt: '2024-01-03T00:00:00.000Z',
    tags: { style: ['pro'], fetish: ['boots'], role: ['heel', 'heel-jobber'], position: ['top'] }
  },
  {
    username: 'jobberkid', display: 'Jobber Kid',
    createdAt: '2024-01-02T00:00:00.000Z',
    tags: { style: [], fetish: ['singlet'], role: ['jobber'], position: ['bottom'] }
  },
  {
    username: 'plain', display: 'Plain Member',
    createdAt: '2024-01-01T00:00:00.000Z',
    tags: {}
  }
];

/* ------------------------------------------------------------
   A page with the widget loaded
------------------------------------------------------------ */

const WIDGET_PAGE = `<!doctype html><html><body>
  <div id="regTags" class="tag-picker-slot"></div>
  <div id="vpTags"></div>
  <select id="rosterTagFilter"></select>
</body></html>`;

function loadWidgetPage() {
  const dom = new JSDOM(WIDGET_PAGE, { url: 'http://localhost/', runScripts: 'dangerously' });
  const win = dom.window;
  win.eval(TAGS_SOURCE);
  win.eval(PROFILE_TAGS_SOURCE);
  return { dom, win, doc: win.document };
}

/* ------------------------------------------------------------
   THE PICKER
------------------------------------------------------------ */

test('the picker renders every tag as a checkbox, grouped by category', () => {
  const { win, doc } = loadWidgetPage();
  const slot = doc.getElementById('regTags');
  win.ProfileTags.renderPicker(slot, { idPrefix: 'regTags' });

  const groups = slot.querySelectorAll('.tag-group');
  assert.equal(groups.length, win.Tags.CATEGORIES.length, 'one fieldset per category');

  win.Tags.CATEGORIES.forEach(category => {
    const group = slot.querySelector(`.tag-group[data-category="${category.key}"]`);
    assert.ok(group, `${category.key} has a group`);
    assert.equal(group.querySelector('.tag-group-label').textContent, category.label);
    assert.equal(group.querySelectorAll('input[type=checkbox]').length, category.tags.length);
    assert.equal(group.querySelector('.tag-group-count').textContent, `0 / ${category.max}`);
  });

  assert.ok(slot.querySelector('#regTags-singlet'), 'input ids are prefixed with the container');
  assert.equal(doc.querySelector('input#singlet'), null, 'nothing leaks into the global id space');
});

test('ticking tags updates the selection, the count and the caps', () => {
  const { win, doc } = loadWidgetPage();
  const slot = doc.getElementById('regTags');
  const changed = [];
  win.ProfileTags.renderPicker(slot, { idPrefix: 'regTags', onChange: selection => changed.push(selection) });

  const role = win.Tags.CATEGORIES.find(category => category.key === 'role');
  const group = slot.querySelector('.tag-group[data-category="role"]');
  const boxes = [...group.querySelectorAll('input[type=checkbox]')];

  boxes[0].checked = true;
  boxes[0].dispatchEvent(new win.Event('change'));

  assert.equal(group.querySelector('.tag-group-count').textContent, `1 / ${role.max}`);
  assert.ok(boxes[0].closest('.tag-chip').classList.contains('is-on'), 'the chip shows as chosen');
  assert.equal(changed.length, 1, 'the change is reported');
  assert.deepEqual(plain(changed[0]).role, [boxes[0].value]);

  // Fill the category to its limit: the rest are locked out, not dropped late.
  boxes.slice(1, role.max).forEach(box => {
    box.checked = true;
    box.dispatchEvent(new win.Event('change'));
  });

  assert.equal(group.querySelector('.tag-group-count').textContent, `${role.max} / ${role.max}`);
  assert.ok(group.querySelector('.tag-group-count').classList.contains('is-full'));
  boxes.forEach(box => assert.equal(box.disabled, !box.checked, `${box.value} is locked out`));

  // Unticking frees a slot again.
  boxes[0].checked = false;
  boxes[0].dispatchEvent(new win.Event('change'));
  assert.equal(boxes[boxes.length - 1].disabled, false);
  assert.equal(win.ProfileTags.pickerSelection(slot).role.length, role.max - 1);
});

test('the picker can be pre-filled from a member record and cleared', () => {
  const { win, doc } = loadWidgetPage();
  const slot = doc.getElementById('regTags');
  const picker = win.ProfileTags.renderPicker(slot, { idPrefix: 'regTags' });

  picker.setSelection(win.ProfileTags.selectionOf(MEMBERS[0]));

  assert.equal(slot.querySelector('#regTags-heel').checked, true);
  assert.equal(slot.querySelector('#regTags-boots').checked, true);
  assert.equal(slot.querySelector('#regTags-singlet').checked, false);
  assert.deepEqual(plain(win.ProfileTags.pickerSelection(slot)), {
    style: ['pro'], fetish: ['boots'], role: ['heel', 'heel-jobber'], position: ['top']
  });

  picker.clear();
  assert.equal(slot.querySelectorAll('input[type=checkbox]:checked').length, 0);
  assert.deepEqual(plain(win.ProfileTags.pickerSelection(slot)), plain(win.Tags.emptySelection()));
});

test('an unprefilled picker with no controller still reads what is ticked', () => {
  /* The shell can be served without the widget (an old cached page); the save
     handlers then fall back to reading the DOM, so nothing ticked is lost. */
  const { win, doc } = loadWidgetPage();
  const slot = doc.getElementById('regTags');
  slot.innerHTML = '<input type="checkbox" value="heel" checked><input type="checkbox" value="singlet" checked>';

  assert.deepEqual(plain(win.ProfileTags.pickerSelection(slot)), {
    style: [], fetish: ['singlet'], role: ['heel'], position: []
  });
  assert.deepEqual(plain(win.ProfileTags.pickerSelection(null)), plain(win.Tags.emptySelection()));
});

/* ------------------------------------------------------------
   THE CHIPS
------------------------------------------------------------ */

test('chips render the labels, in category order, as text', () => {
  const { win, doc } = loadWidgetPage();
  const target = doc.getElementById('vpTags');

  const rendered = win.ProfileTags.renderChips(target, MEMBERS[0].tags);

  assert.equal(rendered, 5);
  assert.deepEqual(
    [...target.querySelectorAll('.tag-chip')].map(chip => chip.textContent),
    ['Pro Style', 'Boots', 'Heel', 'Heel Jobber', 'Top']
  );
  assert.deepEqual(
    [...target.querySelectorAll('.tag-chip')].map(chip => chip.dataset.tag),
    ['pro', 'boots', 'heel', 'heel-jobber', 'top']
  );

  // Nothing here is markup: a label that contained HTML would show as text.
  assert.equal(target.querySelector('img, script'), null);
});

test('an empty selection shows the note it was given, or nothing', () => {
  const { win, doc } = loadWidgetPage();
  const target = doc.getElementById('vpTags');

  assert.equal(win.ProfileTags.renderChips(target, {}, { empty: 'No tags yet' }), 0);
  assert.equal(target.textContent, 'No tags yet');

  assert.equal(win.ProfileTags.renderChips(target, {}, { empty: null }), 0);
  assert.equal(target.textContent, '');
  assert.equal(target.children.length, 0);
});

test('the roster line keeps itself to three tags plus a count', () => {
  const { win } = loadWidgetPage();

  assert.equal(win.ProfileTags.tagSummary(MEMBERS[0].tags), 'Pro Style · Boots · Heel +2');
  assert.equal(win.ProfileTags.tagSummary({ role: ['heel'] }), 'Heel');
  assert.equal(win.ProfileTags.tagSummary({}), '');
});

/* ------------------------------------------------------------
   THE ROSTER FILTER
------------------------------------------------------------ */

test('the roster search matches names, tags and aliases', () => {
  const { win } = loadWidgetPage();
  const names = users => users.map(user => user.username);

  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, {}))), ['heeler', 'jobberkid', 'plain']);
  // "job" is inside the Heel Jobber aliases too, so both tagged members match.
  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { query: 'job' }))), ['heeler', 'jobberkid']);
  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { query: 'HEELER' }))), ['heeler']);

  // A tag: "jobber" is the Jobber tag and the Heel Jobber tag.
  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { query: 'jobber' }))), ['heeler', 'jobberkid']);
  // An alias: "sports entertainment" is a Pro Style alias, not part of the label.
  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { query: 'sports entertainment' }))), ['heeler']);
  // A word no member carries.
  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { query: 'zzz' }))), []);
});

test('the tag menu filters by one exact tag', () => {
  const { win } = loadWidgetPage();
  const names = users => users.map(user => user.username);

  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { tag: 'heel' }))), ['heeler']);
  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { tag: 'singlet' }))), ['jobberkid']);
  // A member who has not tagged themselves is not a match for a tag.
  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { tag: 'boots' }))), ['heeler']);
  // Text and tag together are both applied.
  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { query: 'heeler', tag: 'singlet' }))), []);
  // No tag selected means everything else still filters by text.
  assert.deepEqual(plain(names(win.ProfileTags.filterRoster(MEMBERS, { tag: '' }))), ['heeler', 'jobberkid', 'plain']);
});

test('the tag menu is filled with every tag, grouped by category', () => {
  const { win, doc } = loadWidgetPage();
  const select = doc.getElementById('rosterTagFilter');

  win.ProfileTags.fillTagFilter(select);

  assert.equal(select.options[0].value, '', 'the first entry clears the filter');
  assert.equal(select.options[0].textContent, 'All tags');
  assert.equal(select.querySelectorAll('optgroup').length, win.Tags.CATEGORIES.length);

  const group = select.querySelectorAll('optgroup')[0];
  const style = win.Tags.CATEGORIES[0];
  assert.equal(group.label, style.label);
  assert.equal(group.querySelectorAll('option').length, style.tags.length);
  assert.equal(group.querySelector('option').textContent, style.tags[0].label);

  select.value = 'heel-jobber';
  win.ProfileTags.fillTagFilter(select, { keepValue: true });
  assert.equal(select.value, 'heel-jobber', 'a re-render keeps the chosen tag');
});

/* ------------------------------------------------------------
   THE DESKTOP ROSTER, THROUGH THE REAL chat.js
------------------------------------------------------------ */

const ROSTER_PAGE = `<!doctype html><html><body>
  <div id="modalRoster" style="display:none">
    <input id="rosterSearch" type="text">
    <div class="roster-tag-filter">
      <select id="rosterTagFilter"></select>
      <button id="rosterTagClear" type="button" style="display:none">Clear</button>
    </div>
    <div id="rosterPage" class="roster-list"></div>
    <span id="rosterPageNumber"></span>
    <button id="rosterPrev"></button><button id="rosterNext"></button>
  </div>
  <div id="modalViewProfile" style="display:none">
    <h3 id="vpName"></h3><span id="vpUsername"></span><div id="vpBio"></div>
    <div id="vpTags"></div><div id="vpExtraPhotos"></div>
    <div id="vpWins"></div><div id="vpLosses"></div><div id="vpLang"></div>
    <div id="vpAge"></div><div id="vpHeight"></div><div id="vpWeight"></div>
    <div id="vpColorBox"></div><img id="vpAvatar">
    <button id="vpDMButton"></button><button id="vpBlockButton"></button>
    <div id="vpRelationshipSection"><select id="vpRelationshipSelect"></select></div>
    <button id="vpRelationshipSend"></button>
    <div id="profileStories"></div><div id="profileRelationships"></div><div id="profileTimeline"></div>
  </div>
</body></html>`;

function loadRosterPage() {
  const dom = new JSDOM(ROSTER_PAGE, { url: 'http://localhost/', runScripts: 'dangerously' });
  const win = dom.window;

  win.getSession = () => ({ username: 'alice', display: 'Alice' });
  win.escapeHtml = value => String(value == null ? '' : value);
  win.chatImgSrc = value => (value ? String(value) : '');
  win.imgSrc = win.chatImgSrc;
  win.authFetch = () => Promise.resolve({ status: 200, json: async () => ({ success: true, users: [] }) });
  win.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) });

  // chat.js registers presence handlers at load, so the page brings a socket.
  win.socket = { on: () => {}, emit: () => {} };

  win.eval(TAGS_SOURCE);
  win.eval(PROFILE_TAGS_SOURCE);
  win.eval(CHAT_SOURCE);

  win.allUsers = MEMBERS;
  return { dom, win, doc: win.document };
}

const rowNames = doc => [...doc.querySelectorAll('#rosterPage .roster-user .roster-name')]
  .map(node => node.textContent);

test('the roster renders members and a line of their tags', () => {
  const { win, doc } = loadRosterPage();
  win.renderRosterPopup();

  assert.deepEqual(rowNames(doc), ['Heeler', 'Jobber Kid', 'Plain Member']);
  assert.deepEqual(
    [...doc.querySelectorAll('#rosterPage .roster-tags')].map(node => node.textContent),
    ['Pro Style · Boots · Heel +2', 'Singlet · Jobber · Bottom'],
    'a member with no tags gets no line at all'
  );
});

test('typing a tag into the roster search filters the list', () => {
  const { win, doc } = loadRosterPage();

  doc.getElementById('rosterSearch').value = 'jobber';
  win.renderRosterPopup();
  assert.deepEqual(rowNames(doc), ['Heeler', 'Jobber Kid']);

  // The page's own listener reacts to typing.
  doc.getElementById('rosterSearch').value = 'singlet';
  doc.getElementById('rosterSearch').dispatchEvent(new win.Event('input'));
  assert.deepEqual(rowNames(doc), ['Jobber Kid']);

  doc.getElementById('rosterSearch').value = 'plain';
  win.renderRosterPopup();
  assert.deepEqual(rowNames(doc), ['Plain Member']);
  assert.equal(doc.getElementById('rosterPageNumber').textContent, 'Page 1 / 1');
});

test('the tag dropdown filters the roster, and Clear drops it', () => {
  const { win, doc } = loadRosterPage();

  win.fillRosterTagFilter();
  assert.ok(doc.getElementById('rosterTagFilter').options.length > 1, 'the menu is filled on open');

  const select = doc.getElementById('rosterTagFilter');
  const clear = doc.getElementById('rosterTagClear');

  select.value = 'heel';
  select.dispatchEvent(new win.Event('change'));
  assert.deepEqual(rowNames(doc), ['Heeler']);
  assert.notEqual(clear.style.display, 'none', 'Clear appears while a tag is filtering');

  clear.dispatchEvent(new win.Event('click'));
  assert.equal(select.value, '');
  assert.deepEqual(rowNames(doc), ['Heeler', 'Jobber Kid', 'Plain Member']);
  assert.equal(clear.style.display, 'none');
});

test('the view-profile popup shows the member tags', () => {
  const { win, doc } = loadRosterPage();

  win.openUserProfile('heeler');

  assert.deepEqual(
    [...doc.querySelectorAll('#vpTags .tag-chip')].map(chip => chip.textContent),
    ['Pro Style', 'Boots', 'Heel', 'Heel Jobber', 'Top']
  );

  win.openUserProfile('plain');
  assert.equal(doc.getElementById('vpTags').textContent, 'No tags yet');
});

/* ------------------------------------------------------------
   THE FORMS SEND THEM
   The desktop shells (index.html / mobile2.html) run the real register.js and
   profile.js against the real page, so this covers the payloads the API
   actually receives — a sticky picker would show up here and nowhere else.
------------------------------------------------------------ */

/** Boot index.html with the scripts a form needs, and record every fetch. */
async function loadFormPage() {
  const dom = new JSDOM(read('public', 'index.html'), {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });
  const win = dom.window;
  const doc = win.document;

  await new Promise(resolve => {
    if (doc.readyState !== 'loading') return resolve();
    doc.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

  const calls = [];
  win.alert = () => {};
  win.fetch = (url, options) => {
    calls.push({ url, body: options && options.body ? JSON.parse(options.body) : null });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, conflict: {}, user: { username: 'alice', display: 'Alice' } })
    });
  };

  // physique.js is what fills the height menus the forms validate against.
  ['physique.js', 'tags.js', 'profile-tags.js', 'utils.js'].forEach(file => {
    win.eval(read('public', 'js', file));
  });

  return { dom, win, doc, calls };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 250));

test('registering sends the tags that were ticked', async () => {
  const { win, doc, calls } = await loadFormPage();
  win.eval(read('public', 'js', 'register.js'));

  doc.getElementById('btnRegister').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.ok(doc.querySelector('#regTags .tag-group'), 'the picker is built when the modal opens');

  doc.getElementById('regUser').value = 'newbie';
  doc.getElementById('regEmail').value = 'newbie@example.com';
  doc.getElementById('regPass').value = 'secret123';
  doc.getElementById('regDisplay').value = 'Newbie';
  doc.getElementById('regAge').value = '30';
  doc.getElementById('regHeight').value = "6'0\"";
  doc.getElementById('regWeight').value = '190';

  ['heel', 'singlet', 'vers-top'].forEach(id => {
    const box = doc.getElementById(`regTags-${id}`);
    box.checked = true;
    box.dispatchEvent(new win.Event('change'));
  });

  doc.getElementById('regSubmit').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle();

  const register = calls.find(call => call.url === '/api/register');
  assert.ok(register, 'the account was submitted');
  assert.deepEqual(register.body.tags, {
    style: [], fetish: ['singlet'], role: ['heel'], position: ['vers-top']
  });
});

test('editing a profile pre-fills the picker and saves the changes', async () => {
  const { win, doc, calls } = await loadFormPage();
  win.eval(read('public', 'js', 'profile.js'));

  win.localStorage.setItem('cw_session_v1', JSON.stringify({ username: 'alice', display: 'Alice' }));
  win.openEditProfileModal({
    username: 'alice',
    display: 'Alice',
    tags: { style: ['pro'], fetish: [], role: ['heel'], position: ['top'] }
  });

  assert.equal(doc.getElementById('editTags-pro').checked, true, 'saved tags pre-fill the picker');
  assert.equal(doc.getElementById('editTags-heel').checked, true);
  assert.equal(doc.getElementById('editTags-singlet').checked, false);

  // Add one, drop one — what the member sees is what is saved.
  const singlet = doc.getElementById('editTags-singlet');
  singlet.checked = true;
  singlet.dispatchEvent(new win.Event('change'));

  const heel = doc.getElementById('editTags-heel');
  heel.checked = false;
  heel.dispatchEvent(new win.Event('change'));

  doc.getElementById('editSubmit').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle();

  const update = calls.find(call => call.url === '/api/update-profile');
  assert.ok(update, 'the profile was saved');
  assert.deepEqual(update.body.updates.tags, {
    style: ['pro'], fetish: ['singlet'], role: [], position: ['top']
  });
});

/* ------------------------------------------------------------
   THE MOBILE ROSTER, THROUGH THE REAL mobile.js
------------------------------------------------------------ */

test('the mobile roster shows and searches tags too', async () => {
  const dom = new JSDOM(read('public', 'mobile.html'), {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });
  const win = dom.window;
  const doc = win.document;

  win.alert = () => {};
  win.io = () => ({ on: () => {}, emit: () => {}, emitted: [], fire: () => {} });
  win.fetch = async url => {
    if (String(url).includes('/api/allUsers')) {
      return { ok: true, status: 200, json: async () => ({ success: true, users: MEMBERS }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, messages: [], partners: [], stories: [] }) };
  };
  win.localStorage.setItem('cw_session_v1', JSON.stringify({ username: 'bob', display: 'Bob' }));
  // The page loads physique.js for this; jsdom does not run the page's scripts.
  win.renderMessageAvatar = (from, display) =>
    `<div class="avatar-fallback">${String(display || from || '?')[0]}</div>`;

  ['tags.js', 'profile-tags.js', 'unread-badge.js', 'scroll-back.js', 'mobile.js'].forEach(file => {
    win.eval(read('public', 'js', file));
  });

  await new Promise(resolve => {
    if (doc.readyState !== 'loading') return resolve();
    doc.addEventListener('DOMContentLoaded', resolve, { once: true });
  });
  doc.getElementById('confirmBtn').click();
  await new Promise(resolve => setTimeout(resolve, 250));

  const names = () => [...doc.querySelectorAll('#rosterList .roster-user .roster-name')]
    .map(node => node.textContent);

  win.__cw.openRoster();
  await new Promise(resolve => setTimeout(resolve, 400));

  assert.deepEqual(names(), ['Heeler', 'Jobber Kid', 'Plain Member']);
  assert.deepEqual(
    [...doc.querySelectorAll('#rosterList .roster-tags')].map(node => node.textContent),
    ['Pro Style · Boots · Heel +2', 'Singlet · Jobber · Bottom']
  );

  // A tag typed into the search…
  doc.getElementById('rosterSearch').value = 'heel';
  doc.getElementById('rosterSearch').dispatchEvent(new win.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(names(), ['Heeler']);

  // …and a tag picked from the menu, with Clear to drop it.
  const select = doc.getElementById('rosterTagFilter');
  assert.ok(select.options.length > 1, 'the tag menu is filled on open');
  select.value = 'boots';
  select.dispatchEvent(new win.Event('change'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(names(), ['Heeler']);
  assert.notEqual(doc.getElementById('rosterTagClear').style.display, 'none');

  // The mobile profile popup carries the chips as well.
  win.__cw.openProfile('heeler');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(
    [...doc.querySelectorAll('#vpTags .tag-chip')].map(chip => chip.textContent),
    ['Pro Style', 'Boots', 'Heel', 'Heel Jobber', 'Top']
  );
});

/* ------------------------------------------------------------
   THE SHELLS SHIP IT
------------------------------------------------------------ */

test('every shell carries the picker slots, the tag filter and both scripts', () => {
  const shells = [
    ['public', 'index.html'],
    ['public', 'mobile.html'],
    ['public', 'mobile2.html']
  ];

  shells.forEach(parts => {
    const html = read(...parts);
    const name = parts.join('/');

    ['regTags', 'editTags', 'vpTags', 'rosterTagFilter', 'rosterTagClear'].forEach(id => {
      assert.ok(html.includes(`id="${id}"`), `${name} has #${id}`);
    });

    assert.match(html, /<script src="\/js\/tags\.js"><\/script>/, `${name} loads the catalogue`);
    assert.match(html, /<script src="\/js\/profile-tags\.js"><\/script>/, `${name} loads the picker`);
    assert.ok(
      html.indexOf('/js/tags.js') < html.indexOf('/js/profile-tags.js'),
      `${name} loads the catalogue first`
    );
  });
});

test('both mobile shells wire the roster search through the shared filter', () => {
  // mobile.html asks ProfileTags for the roster filter; mobile2.html reuses
  // chat.js, which is covered above. If the call is dropped, mobile silently
  // goes back to name-only search.
  const mobile = read('public', 'js', 'mobile.js');
  assert.match(mobile, /ProfileTags\.filterRoster\(/, 'mobile.js filters through ProfileTags');
  assert.match(mobile, /ProfileTags\.renderChips\(/, 'mobile.js renders the profile chips');
  assert.match(mobile, /tagSelection\("regTags"\)|tagSelection\('regTags'\)/, 'registration sends tags');
  assert.match(mobile, /tagSelection\("editTags"\)|tagSelection\('editTags'\)/, 'the profile editor sends tags');

  // The desktop pair (chat.js / profile.js / register.js) is driven above and
  // here pins the payloads, which a DOM test cannot see.
  assert.match(read('public', 'js', 'register.js'), /tags: registerTagSelection\(\)/);
  assert.match(read('public', 'js', 'profile.js'), /tags: editTagSelection\(\)/);
});

test('the server stores and searches the same catalogue the browser renders', () => {
  const server = read('index.js');

  assert.match(server, /require\('\.\/public\/js\/tags\.js'\)/, 'one catalogue, both sides');
  assert.match(server, /function readTagSelection/, 'register / update-profile normalise through it');
  assert.match(server, /tags: tagSelection\.tags/, 'register stores the selection');
  assert.match(server, /safeUpdates\.tags = tagSelection\.tags/, 'update-profile stores the selection');
  assert.match(server, /app\.get\('\/api\/tags'/, 'the catalogue is offered to API consumers');
  assert.match(server, /tags\.mongoFilter\(matchedTags, 'any'\)/, 'the roster search covers tags');
  assert.match(server, /tags: userTags\(user\)/, 'the session payload carries the tags');
  assert.match(server, /tags: userTags\(user\)\n  \};/, 'and so does the login payload');
  assert.equal(
    (server.match(/error: 'invalid_tags'/g) || []).length,
    2,
    'register and update-profile both answer a broken selection with 400 invalid_tags'
  );

  // The roster feed has to select the field, or the search has nothing to read.
  const allUsers = server.slice(server.indexOf('app.get("/api/allUsers"'));
  assert.match(allUsers.slice(0, allUsers.indexOf('app.get', 10)), /select\("username[\s\S]*tags/, 'the roster selects tags');
});
