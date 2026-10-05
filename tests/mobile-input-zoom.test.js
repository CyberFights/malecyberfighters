const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('shared styles prevent focus zoom in mobile chat composers', () => {
  const css = read('css', 'features.css');
  const marker = 'iOS Safari and WKWebView zoom the whole page';
  const start = css.indexOf(marker);

  assert.notEqual(start, -1, 'the shared stylesheet should contain the iOS focus-zoom guard');

  const guard = css.slice(start, css.indexOf('\n}\n', start) + 3);
  assert.match(guard, /@media\s*\(max-width:\s*768px\),\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)/);

  for (const selector of [
    '#publicMessage',
    '#dmInput',
    '#roomMessageInput',
    '.pm-input input[type="text"]',
    '.assistance-input-bar input[type="text"]'
  ]) {
    assert.ok(guard.includes(selector), `${selector} should be protected from mobile focus zoom`);
  }

  assert.match(guard, /font-size:\s*16px\s*!important/);
});

test('every chat app shell loads the shared focus-zoom guard', () => {
  for (const page of ['index.html', 'mobile.html']) {
    assert.match(
      read(page),
      /<link\s+rel="stylesheet"\s+href="\/css\/features\.css(?:\?[^"\s>]*)?">/i,
      `${page} should load features.css`
    );
  }
});
