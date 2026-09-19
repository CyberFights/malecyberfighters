/**
 * Tests for the action-button categories (public/index.html +
 * public/js/nav-groups.js).
 *
 * The page is loaded into jsdom and nav-groups.js is evaluated against it,
 * so these exercise the real markup: both copies of the action row (the
 * mobile block and the desktop header), the real button ids, and the real
 * category toggles.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const PAGE = read('public', 'index.html');
const NAV_GROUPS = read('public', 'js', 'nav-groups.js');
const I18N = read('public', 'js', 'i18n.js');

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

/** What the user asked for: every action button filed under a category. */
const EXPECTED_GROUPS = {
  account: ['btnLogin', 'btnRegister', 'btnBookmarks', 'btnPreferences'],
  chatrooms: ['btnOpenChat', 'btnRooms', 'btnDMs'],
  community: ['btnRoster', 'btnForums', 'btnArchives'],
  matches: ['btnLfg', 'btnChallenges', 'btnRecord', 'btnAchievements'],
  help: ['openSupport', 'btnAssistance', 'btnGuide']
};

async function startPage({ scripts = [NAV_GROUPS] } = {}) {
  const dom = new JSDOM(PAGE, {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });
  const win = dom.window;
  scripts.forEach(code => win.eval(code));

  await new Promise(resolve => {
    if (win.document.readyState !== 'loading') return resolve();
    win.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

  const doc = win.document;
  /** The desktop copy of a category (the second .actions block on the page). */
  const desktopRow = () => doc.querySelectorAll('.actions')[1];
  const group = key => desktopRow().querySelector(`.nav-group[data-nav-group="${key}"]`);
  const toggle = key => group(key).querySelector('.nav-group-toggle');
  const menu = key => group(key).querySelector('.nav-group-menu');

  return {
    win,
    doc,
    desktopRow,
    group,
    toggle,
    menu,
    isOpen: key => toggle(key).getAttribute('aria-expanded') === 'true' && !menu(key).hidden,
    press: (el, key, init = {}) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })),
    pointerDown: el => el.dispatchEvent(new win.Event('pointerdown', { bubbles: true, cancelable: true })),
    close: () => win.close()
  };
}

test('both action rows carry the same five categories, each holding its buttons', async () => {
  const page = await startPage();
  try {
    const rows = page.doc.querySelectorAll('.actions');
    assert.equal(rows.length, 2, 'mobile block and desktop header');

    rows.forEach(row => {
      const keys = Array.from(row.querySelectorAll('.nav-group')).map(g => g.dataset.navGroup);
      assert.deepEqual(keys, Object.keys(EXPECTED_GROUPS), 'categories in order');

      Object.entries(EXPECTED_GROUPS).forEach(([key, ids]) => {
        const groupEl = row.querySelector(`.nav-group[data-nav-group="${key}"]`);
        const toggleEl = groupEl.querySelector(':scope > .nav-group-toggle');
        const menuEl = groupEl.querySelector(':scope > .nav-group-menu');
        assert.ok(toggleEl, `${key} has a toggle`);
        assert.ok(menuEl, `${key} has a menu`);
        assert.equal(toggleEl.getAttribute('aria-expanded'), 'false', `${key} starts closed`);
        assert.equal(menuEl.hidden, true, `${key} menu starts hidden`);
        assert.equal(toggleEl.getAttribute('aria-controls'), menuEl.id, `${key} toggle controls its menu`);

        const inside = Array.from(menuEl.querySelectorAll('button')).map(b => b.id);
        assert.deepEqual(inside, ids, `${key} holds exactly its buttons`);
      });
    });

    // Every original button still exists twice (once per row) so the
    // existing scripts, which bind by id, keep finding both copies.
    Object.values(EXPECTED_GROUPS).flat().forEach(id => {
      assert.equal(page.doc.querySelectorAll(`[id="${id}"]`).length, 2, `${id} present in both rows`);
    });

    const ids = Array.from(page.doc.querySelectorAll('.nav-group-menu[id]')).map(m => m.id);
    assert.equal(new Set(ids).size, ids.length, 'minted menu ids are unique');
    assert.ok(PAGE.includes('/js/nav-groups.js'), 'the page loads nav-groups.js');
  } finally {
    page.close();
  }
});

test('the Chatrooms category opens to Open Arena, Rooms and DMs', async () => {
  const page = await startPage();
  try {
    assert.equal(page.isOpen('chatrooms'), false);
    page.toggle('chatrooms').click();
    assert.equal(page.isOpen('chatrooms'), true, 'a click opens the menu');
    assert.ok(page.group('chatrooms').classList.contains('nav-group-open'));

    const labels = Array.from(page.menu('chatrooms').querySelectorAll('button'))
      .map(b => b.firstChild.textContent.trim());
    assert.deepEqual(labels, ['Open Arena', 'Rooms', 'DMs']);

    page.toggle('chatrooms').click();
    assert.equal(page.isOpen('chatrooms'), false, 'a second click closes it again');
  } finally {
    page.close();
  }
});

test('only one category is open at a time', async () => {
  const page = await startPage();
  try {
    page.toggle('account').click();
    assert.equal(page.isOpen('account'), true);

    page.toggle('matches').click();
    assert.equal(page.isOpen('matches'), true);
    assert.equal(page.isOpen('account'), false, 'opening Matches closed Account');
  } finally {
    page.close();
  }
});

test('MCFNav.open() opens a category by key and closes the others', async () => {
  const page = await startPage();
  try {
    assert.equal(page.win.MCFNav.open('help'), true);
    assert.equal(page.isOpen('help'), true);
    assert.equal(page.win.MCFNav.isOpen('help'), true);

    assert.equal(page.win.MCFNav.open('community'), true);
    assert.equal(page.isOpen('help'), false);
    assert.equal(page.isOpen('community'), true);

    assert.equal(page.win.MCFNav.open('nope'), false, 'unknown keys are refused');
    page.win.MCFNav.closeAll();
    assert.equal(page.isOpen('community'), false);
  } finally {
    page.close();
  }
});

test('pressing a button inside a menu runs its handler, then the menu closes', async () => {
  const page = await startPage();
  try {
    let fired = 0;
    // The existing scripts bind directly on the button; stand in for one.
    page.menu('chatrooms').querySelector('#btnRooms').addEventListener('click', () => { fired += 1; });

    page.toggle('chatrooms').click();
    page.menu('chatrooms').querySelector('#btnRooms').click();
    assert.equal(fired, 1, 'the button did its job');
    assert.equal(page.isOpen('chatrooms'), true, 'still open on the same tick (popup-dissolve measures the button)');

    await tick();
    assert.equal(page.isOpen('chatrooms'), false, 'closed a tick later');
  } finally {
    page.close();
  }
});

test('a press outside the menu closes it; a press on the menu does not', async () => {
  const page = await startPage();
  try {
    page.toggle('community').click();
    assert.equal(page.isOpen('community'), true);

    page.pointerDown(page.menu('community'));
    assert.equal(page.isOpen('community'), true, 'pressing inside the panel keeps it open');

    page.pointerDown(page.doc.body);
    assert.equal(page.isOpen('community'), false, 'pressing the page closes it');
  } finally {
    page.close();
  }
});

test('Escape closes the open menu and hands focus back to its toggle', async () => {
  const page = await startPage();
  try {
    page.toggle('help').click();
    const guide = page.menu('help').querySelector('#btnGuide');
    guide.focus();
    assert.equal(page.doc.activeElement, guide);

    page.press(guide, 'Escape');
    assert.equal(page.isOpen('help'), false);
    assert.equal(page.doc.activeElement, page.toggle('help'), 'focus returned to the Help toggle');
  } finally {
    page.close();
  }
});

test('arrow keys open a category and step through its buttons', async () => {
  const page = await startPage();
  try {
    const t = page.toggle('matches');
    t.focus();
    page.press(t, 'ArrowDown');
    assert.equal(page.isOpen('matches'), true, 'ArrowDown on the toggle opens the menu');

    const items = Array.from(page.menu('matches').querySelectorAll('button'));
    assert.equal(page.doc.activeElement, items[0], 'and lands on the first button');

    page.press(items[0], 'ArrowDown');
    assert.equal(page.doc.activeElement, items[1]);

    page.press(items[1], 'End');
    assert.equal(page.doc.activeElement, items[items.length - 1]);

    page.press(items[items.length - 1], 'ArrowDown');
    assert.equal(page.doc.activeElement, items[0], 'wraps around');

    page.press(items[0], 'ArrowUp');
    assert.equal(page.doc.activeElement, items[items.length - 1], 'wraps the other way');

    page.press(items[items.length - 1], 'Home');
    assert.equal(page.doc.activeElement, items[0]);
  } finally {
    page.close();
  }
});

test('tabbing out of an open menu closes it', async () => {
  const page = await startPage();
  try {
    page.toggle('account').click();
    const last = page.menu('account').querySelector('#btnPreferences');
    last.focus();

    const outside = page.desktopRow().querySelector('#btnTOS');
    last.dispatchEvent(new page.win.FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    await tick();
    assert.equal(page.isOpen('account'), false);

    // Moving focus within the group (toggle ↔ its buttons) keeps it open.
    page.toggle('account').click();
    last.dispatchEvent(new page.win.FocusEvent('focusout', { bubbles: true, relatedTarget: page.toggle('account') }));
    await tick();
    assert.equal(page.isOpen('account'), true);
  } finally {
    page.close();
  }
});

test('the Chatrooms toggle shows the DMs unread count while the menu is closed', async () => {
  const page = await startPage();
  try {
    const badge = page.toggle('chatrooms').querySelector('.nav-group-badge');
    assert.ok(badge, 'the toggle carries a badge slot');
    assert.equal(badge.hidden, true, 'nothing unread yet');

    // Exactly what pm.js's updateDMBadge() does to #dmBadge.
    const dmBadge = page.menu('chatrooms').querySelector('#dmBadge');
    dmBadge.textContent = '3';
    dmBadge.style.display = 'inline-block';
    await tick();

    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, '3');
    assert.equal(badge.classList.contains('nav-group-badge-dot'), false);

    dmBadge.textContent = '99+';
    await tick();
    assert.equal(badge.textContent, '99+');

    dmBadge.textContent = '';
    dmBadge.style.display = 'none';
    await tick();
    assert.equal(badge.hidden, true, 'clears with the count');
  } finally {
    page.close();
  }
});

test('the Matches toggle shows a dot when Challenges or Find a Match flag activity', async () => {
  const page = await startPage();
  try {
    const badge = page.toggle('matches').querySelector('.nav-group-badge');
    assert.equal(badge.hidden, true);

    // What challenges.js's ping() / lfg.js's renderBadge() append.
    const dot = page.doc.createElement('span');
    dot.className = 'mcf-btn-badge';
    dot.textContent = '•';
    page.menu('matches').querySelector('#btnChallenges').appendChild(dot);
    await tick();

    assert.equal(badge.hidden, false);
    assert.ok(badge.classList.contains('nav-group-badge-dot'));

    dot.remove();
    await tick();
    assert.equal(badge.hidden, true);
  } finally {
    page.close();
  }
});

test('i18n translates the category labels and keeps the badge and caret intact', async () => {
  const page = await startPage({ scripts: [NAV_GROUPS, I18N] });
  try {
    page.win.localStorage.setItem('mcf_lang', 'es');
    page.win.MCFI18N.apply();

    const t = page.toggle('chatrooms');
    assert.equal(t.firstChild.nodeType, 3, 'label is still the first text node');
    assert.equal(t.firstChild.textContent, 'Salas de chat');
    assert.ok(t.querySelector('.nav-group-badge'), 'badge slot survived');
    assert.ok(t.querySelector('.nav-caret'), 'caret survived');
    assert.equal(page.doc.querySelectorAll('#navAccount')[0].firstChild.textContent, 'Cuenta', 'the mobile copy too');
  } finally {
    page.close();
  }
});
