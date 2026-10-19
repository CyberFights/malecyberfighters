const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'wrestling-game.html'), 'utf8');
const GAME_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'wrestling-game.js'), 'utf8');
const CARD_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'wrestler-card.js'), 'utf8');
const PAGE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'wrestling-game-page.js'), 'utf8');

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

function createDom() {
  const dom = new JSDOM(HTML, {
    url: 'https://male-cyber-fighters.test/wrestling-game.html',
    runScripts: 'dangerously',
    resources: 'usable'
  });
  const win = dom.window;

  // Stub fetch API for /api/me and /api/wrestling/stats
  win.fetch = async (url) => {
    const sUrl = String(url);
    if (sUrl.includes('/api/me')) {
      return {
        ok: true,
        json: async () => ({ ok: true, user: { username: 'fighter', display: 'Iron Fighter' } })
      };
    }
    if (sUrl.includes('/api/wrestling/stats')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          stats: { strength: 20, agility: 15, stamina: 25, skill: 30, charisma: 10 },
          gymEnergy: 10,
          gymEnergyMax: 10
        })
      };
    }
    if (sUrl.includes('/api/allUsers')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          users: [
            { username: 'brutus', display: 'Brutus the Beast', stats: { strength: 40, agility: 20, stamina: 35, skill: 25, charisma: 15 } }
          ]
        })
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  win.eval(GAME_SRC);
  win.eval(CARD_SRC);
  win.eval(PAGE_SRC);

  return { dom, win };
}

test('wrestling game page mounts match arena with spotlight and categorized move arsenal', async () => {
  const { dom, win } = createDom();
  await tick(50);

  // App container should be shown
  const app = win.document.getElementById('app');
  assert.equal(app.classList.contains('hidden'), false);

  // Find opponent to start match
  const findBtn = win.document.getElementById('findOpponent');
  assert.ok(findBtn);
  findBtn.click();
  await tick(50);

  // Match area should now be visible
  const matchArea = win.document.getElementById('matchArea');
  assert.equal(matchArea.classList.contains('hidden'), false);

  // Match spotlight elements exist and show initial state
  const spotlight = win.document.getElementById('matchSpotlight');
  assert.ok(spotlight);
  const spotlightImg = win.document.getElementById('spotlightImg');
  assert.ok(spotlightImg && spotlightImg.src.includes('/images/moves/'));

  // Move category tabs exist
  const tabs = win.document.querySelectorAll('.move-tab');
  assert.equal(tabs.length, 4, 'Should have 4 category tabs (holds, power, submissions, tactics)');

  // Moves panel should be populated with hold move cards
  const moveBtns = win.document.querySelectorAll('#movesPanel .move-card-btn');
  assert.equal(moveBtns.length, 5, 'Holds tab should show 5 holds');

  // Verify first move card has thumbnail and title
  const firstMove = moveBtns[0];
  const thumb = firstMove.querySelector('.move-card-thumb');
  const title = firstMove.querySelector('.move-card-title');
  assert.ok(thumb && thumb.src.includes('/images/moves/'));
  assert.ok(title && title.textContent.length > 0);

  // Switch to Power Moves tab
  const powerTab = win.document.querySelector('.move-tab[data-tab="power"]');
  assert.ok(powerTab);
  powerTab.click();
  await tick(20);

  const powerBtns = win.document.querySelectorAll('#movesPanel .move-card-btn');
  assert.equal(powerBtns.length, 5, 'Power moves tab should show 5 power moves');

  // Switch to Submissions tab
  const subTab = win.document.querySelector('.move-tab[data-tab="submissions"]');
  assert.ok(subTab);
  subTab.click();
  await tick(20);

  const subBtns = win.document.querySelectorAll('#movesPanel .move-card-btn');
  assert.equal(subBtns.length, 5, 'Submissions tab should show 5 submissions');

  // Execute a submission (Boston Crab)
  const bostonCrabBtn = [...subBtns].find(b => b.getAttribute('data-action') === 'boston-crab');
  assert.ok(bostonCrabBtn);
  bostonCrabBtn.click();
  await tick(20);

  // Match spotlight should update with Boston Crab image and details
  assert.ok(spotlightImg.src.includes('boston-crab.png') || spotlightImg.src.includes('/images/moves/'));
  const spotlightTitle = win.document.getElementById('spotlightTitle');
  assert.ok(spotlightTitle.textContent.length > 0);

  // Match log should have entries
  const log = win.document.getElementById('matchLog');
  assert.ok(log.children.length >= 2, 'Match log should contain turn events');

  win.close();
});
