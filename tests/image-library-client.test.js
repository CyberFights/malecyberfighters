const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'image-library.html'), 'utf8');
const IMAGE_PROXY = fs.readFileSync(path.join(ROOT, 'public', 'js', 'image-proxy.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'js', 'image-library.js'), 'utf8');
const CATEGORIES = [
  { id: 'fighter-photos', label: 'Fighter Photos' },
  { id: 'artwork', label: 'Artwork' }
];

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await tick();
  }
  return predicate();
}

test('the library UI loads member images and switches category filters', async () => {
  const dom = new JSDOM(PAGE, {
    url: 'https://example.test/image-library.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const win = dom.window;
  const requests = [];

  win.fetch = async input => {
    const url = new URL(String(input), win.location.origin);
    requests.push(url);
    const category = url.searchParams.get('category') || 'all';
    const image = {
      _id: category === 'artwork' ? 'b'.repeat(24) : 'a'.repeat(24),
      imageUrl: `https://i.ibb.co/gallery/${category}.png`,
      category: category === 'artwork' ? 'artwork' : 'fighter-photos',
      caption: category === 'artwork' ? 'Arena poster' : 'Fighter portrait',
      uploadedBy: 'alice',
      createdAt: '2026-10-01T12:00:00.000Z',
      canDelete: true
    };
    return {
      status: 200,
      ok: true,
      json: async () => ({ ok: true, categories: CATEGORIES, images: [image], hasMore: false })
    };
  };

  try {
    win.eval(IMAGE_PROXY);
    win.eval(CLIENT);
    assert.equal(await waitFor(() => !win.document.getElementById('libraryApp').hidden), true);
    assert.equal(win.document.querySelectorAll('.image-card').length, 1);
    assert.equal(win.document.querySelector('.image-card-caption').textContent, 'Fighter portrait');
    assert.equal(win.document.getElementById('imageCategory').options.length, CATEGORIES.length);
    assert.equal(win.document.getElementById('imageCategory').value, 'fighter-photos');
    assert.equal(win.document.querySelector('[data-category="all"]').getAttribute('aria-pressed'), 'true');

    win.document.querySelector('[data-category="artwork"]').click();
    assert.equal(await waitFor(() => requests.length === 2), true);
    assert.equal(await waitFor(() => win.document.querySelector('.image-card-caption')?.textContent === 'Arena poster'), true);
    assert.equal(requests[1].searchParams.get('category'), 'artwork');
    assert.equal(win.document.querySelector('[data-category="artwork"]').getAttribute('aria-pressed'), 'true');
  } finally {
    win.close();
  }
});

test('unauthenticated members receive a sign-in prompt instead of the library', async () => {
  const dom = new JSDOM(PAGE, {
    url: 'https://example.test/image-library.html',
    runScripts: 'dangerously'
  });
  const win = dom.window;
  win.fetch = async () => ({
    status: 401,
    ok: false,
    json: async () => ({ ok: false, error: 'auth_required' })
  });

  try {
    win.eval(IMAGE_PROXY);
    win.eval(CLIENT);
    assert.equal(await waitFor(() => !win.document.getElementById('memberGate').hidden), true);
    assert.equal(win.document.getElementById('libraryApp').hidden, true);
    assert.match(win.document.getElementById('memberGateMessage').textContent, /sign in/i);
  } finally {
    win.close();
  }
});
