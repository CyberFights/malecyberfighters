/**
 * Tests for build.js — the front-end asset build.
 *
 * The build replaces each page's run of ~30 `<script>` tags with one
 * concatenated, minified bundle. That is only safe if the bundle still means
 * exactly what the separate files meant: these are classic scripts sharing one
 * global scope, where a top-level `function` in one file is callable from the
 * next and a redeclaration in a later file deliberately overrides an earlier
 * one (`chat.js` declares an `openPrivateWindow` shim that `pm.js` replaces).
 *
 * So the rules under test are the two that would otherwise fail silently in a
 * browser: the scope scanner must tell a global from a local, and the build
 * must refuse to ship a page bundle that lost a global or does not parse.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  topLevelNames,
  hasIdentifier,
  compiles,
  findScriptTags,
  findStylesheetTags,
  isBundlableScript,
  toFilePath,
  build,
  DIST_DIR,
  PAGES_DIR
} = require('../build');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = rel => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

/* ---------------------------------------------------------------
   The scope scanner
--------------------------------------------------------------- */

test('finds a top-level declaration of each kind', () => {
  const names = topLevelNames([
    "const A = 1;",
    "let B = 2;",
    "var C = 3;",
    "class D {}",
    "function E() {}",
    "async function F() {}"
  ].join('\n'));

  for (const expected of ['A', 'B', 'C', 'D', 'E']) {
    assert.ok(names.has(expected), `expected ${expected} to be global`);
  }
});

test('ignores declarations inside a function, block or IIFE', () => {
  const names = topLevelNames([
    'function outer() {',
    '  const inner = 1;',
    '  if (inner) { let deeper = 2; }',
    '}',
    '(function () {',
    "  const wrapped = 'no';",
    '})();',
    'const real = 1;'
  ].join('\n'));

  assert.deepEqual([...names], ['outer', 'real']);
});

test('ignores locals written at column 0, which this codebase does', () => {
  // The exact shape found in public/js/utils.js and public/js/register.js:
  // a function body whose lines are not indented.
  const names = topLevelNames([
    'function updateProfileCard(user) {',
    'const avatarHtml = user.imageUrl',
    "  ? '<img>'",
    "  : 'x';",
    'return avatarHtml;',
    '}',
    'async function checkAvailability(username){',
    'const res = await fetch("/api/check-availability", {});',
    'return res.json();',
    '}',
    'let uploadedImageUrl = "";'
  ].join('\n'));

  assert.deepEqual([...names], ['updateProfileCard', 'checkAvailability', 'uploadedImageUrl']);
});

test('is not fooled by braces inside strings, templates, regexes or comments', () => {
  const names = topLevelNames([
    'const a = "a { that never closes";',
    "const b = 'same }';",
    'const c = `template ${ { nested: 1 } } text {`;',
    'const d = `outer ${ `inner ${ 1 }` }`;',
    'const e = /[{}"\']+/g;',
    'const f = "x".replace(/[&<>"\']/g, c => c);',
    '/* a comment with { an unmatched brace',
    '   and a quote " */',
    '// another } comment',
    'const g = 1;'
  ].join('\n'));

  assert.deepEqual([...names], ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('treats division as division, not as a regex literal', () => {
  const names = topLevelNames([
    'function ratio(total, count) {',
    '  const per = total / count / 2;',
    '  return per;',
    '}',
    'const after = 1;'
  ].join('\n'));

  assert.deepEqual([...names], ['ratio', 'after']);
});

test('reads the real client files without losing their known globals', () => {
  const utils = topLevelNames(read('js/utils.js'));
  // Declared at the top level of utils.js and called from other files.
  for (const name of ['show', 'hide', 'escapeHtml', 'setSession', 'getSession', 'clearSession', 'STORAGE_SESSION']) {
    assert.ok(utils.has(name), `utils.js should expose ${name}`);
  }
  // Declared inside updateProfileCard — a local, despite sitting at column 0.
  assert.ok(!utils.has('avatarHtml'), 'avatarHtml is local to a function');

  const register = topLevelNames(read('js/register.js'));
  assert.ok(register.has('uploadedImageUrl'));
  assert.ok(register.has('checkAvailability'));
  assert.ok(!register.has('res'), 'res is local to checkAvailability');

  // Files written as one big IIFE expose nothing at the top level.
  assert.equal(topLevelNames(read('js/assistance.js')).size, 0);
  assert.equal(topLevelNames(read('js/story-ui.js')).size, 0);
});

/* ---------------------------------------------------------------
   The bundle guards
--------------------------------------------------------------- */

test('hasIdentifier matches whole identifiers only', () => {
  assert.ok(hasIdentifier('function setSession(){}', 'setSession'));
  assert.ok(hasIdentifier('window.setSession=setSession', 'setSession'));
  assert.ok(!hasIdentifier('setSessionFoo', 'setSession'));
  assert.ok(!hasIdentifier('mysetSession', 'setSession'));
  assert.ok(!hasIdentifier('nothing here', 'setSession'));
  assert.ok(hasIdentifier('$helper', '$helper'), 'a $ name is matched literally');
});

test('compiles accepts a concatenation and rejects a broken one', () => {
  assert.equal(compiles('const a = 1;\n;\nfunction b(){}\n;\n'), null);
  assert.ok(compiles('const a = 1;\nfunction b( {}\n'), 'a malformed bundle must be reported');
});

test('joining two files with ";" keeps them two statements', () => {
  // The hazard concatenation introduces: a file ending in an expression
  // followed by one starting with "(" parses as a *call* on that expression
  // (1(...) is legal syntax), so the second file never runs as its own
  // statement. The separator is what keeps them apart.
  const vm = require('node:vm');
  const first = 'globalThis.value = 1';
  const second = '(function () { globalThis.ranSecond = true; })()';

  const joined = vm.createContext();
  vm.runInContext([first, second].join('\n;\n'), joined);
  assert.equal(joined.value, 1);
  assert.equal(joined.ranSecond, true);

  const merged = vm.createContext();
  let threw = false;
  try {
    vm.runInContext([first, second].join('\n'), merged);
  } catch (_) {
    threw = true; // 1(...) is a TypeError at runtime
  }
  assert.ok(threw || merged.ranSecond !== true, 'without the separator the second file is swallowed');
});

/* ---------------------------------------------------------------
   Script selection
--------------------------------------------------------------- */

test('only local /js/ scripts are bundlable', () => {
  assert.ok(isBundlableScript('/js/utils.js'));
  assert.ok(!isBundlableScript('/socket.io/socket.io.js'));
  assert.ok(!isBundlableScript('https://cdn.jsdelivr.net/npm/eruda'));
  assert.ok(!isBundlableScript('/landing.js'));
});

test('findScriptTags keeps document order and ignores inline scripts', () => {
  const html = [
    '<script type="application/ld+json">{"a":1}</script>',
    '<script src="/socket.io/socket.io.js"></script>',
    '<script src="/js/a.js?v=1"></script>',
    '<script>inline()</script>',
    '<script src="/js/b.js"></script>'
  ].join('\n');

  const tags = findScriptTags(html).map(tag => tag.src);
  assert.deepEqual(tags, ['/socket.io/socket.io.js', '/js/a.js?v=1', '/js/b.js']);

  const bundlable = findScriptTags(html).filter(tag => isBundlableScript(tag.src.split('?')[0]));
  assert.deepEqual(bundlable.map(tag => tag.src), ['/js/a.js?v=1', '/js/b.js']);
  assert.ok(bundlable[0].index < bundlable[1].index, 'offsets stay in document order');
});

test('findStylesheetTags picks up href and offset', () => {
  const html = '<link rel="stylesheet" href="/css/desktop.css?v=9">\n<link rel="icon" href="/x.png">';
  const tags = findStylesheetTags(html);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].href, '/css/desktop.css?v=9');
});

test('toFilePath strips the cache-buster query', () => {
  assert.equal(toFilePath('/js/utils.js?v=9'), 'js/utils.js');
  assert.equal(toFilePath('/css/desktop.css'), 'css/desktop.css');
});

/* ---------------------------------------------------------------
   The build itself
--------------------------------------------------------------- */

/**
 * manifest.pages maps a page to its *rewritten HTML*; the bundle is the single
 * /dist/js/ script that HTML now references.
 */
function bundleUrlFor(pageUrl) {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'manifest.json'), 'utf8'));
  const pagePath = manifest.pages[pageUrl];
  assert.ok(pagePath, `${pageUrl} should have been bundled`);
  const html = fs.readFileSync(path.join(PUBLIC, pagePath), 'utf8');
  const bundles = findScriptTags(html).filter(tag => tag.src.startsWith('/dist/js/'));
  assert.equal(bundles.length, 1, `${pageUrl} should reference exactly one bundle`);
  return { html, url: bundles[0].src, file: path.join(PUBLIC, toFilePath(bundles[0].src)) };
}

test('the build produces one bundle per page and rewrites the page', async () => {
  const ok = await build();
  assert.ok(ok, 'the build should succeed in this repository');

  const { html, url } = bundleUrlFor('/index.html');
  assert.match(url, /^\/dist\/js\/index\.[0-9a-f]{12}\.js$/);

  // None of the original per-file tags may survive, or the scripts run twice.
  assert.ok(
    !findScriptTags(html).some(tag => tag.src.startsWith('/js/')),
    'the unbundled script tags should all be gone'
  );

  // The socket.io client is not ours to bundle and must survive.
  assert.ok(findScriptTags(html).some(tag => tag.src.includes('/socket.io/')));

  // Stylesheets point at hashed copies.
  const styles = findStylesheetTags(html);
  assert.ok(styles.length >= 4, 'index.html loads four stylesheets');
  for (const tag of styles) {
    assert.match(tag.href, /^\/dist\/css\/[a-z-]+\.[0-9a-f]{12}\.css$/, tag.href);
  }
});

test('every bundle keeps the globals of the files it was built from', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'manifest.json'), 'utf8'));

  for (const pageUrl of Object.keys(manifest.pages)) {
    const pageName = pageUrl.replace(/^\//, '');
    const source = read(pageName);
    const { file } = bundleUrlFor(pageUrl);
    const bundle = fs.readFileSync(file, 'utf8');

    // The page's own scripts, in order, are the bundle's inputs.
    const inputs = findScriptTags(source)
      .filter(tag => isBundlableScript(tag.src.split('?')[0]))
      .map(tag => toFilePath(tag.src));

    assert.ok(inputs.length >= 1, `${pageName} should have at least one script`);

    for (const rel of inputs) {
      for (const name of topLevelNames(read(rel))) {
        assert.ok(
          hasIdentifier(bundle, name),
          `${pageName} bundle lost the global "${name}" from ${rel}`
        );
      }
    }

    assert.equal(compiles(bundle), null, `${pageName} bundle must parse`);
  }
});

test('the last declaration still wins, so overrides keep their meaning', async () => {
  // chat.js declares an openPrivateWindow shim; pm.js, loaded after it,
  // declares the real one. Concatenation must preserve that order, because a
  // classic script's later `function` declaration replaces the earlier one.
  const { file } = bundleUrlFor('/index.html');
  const bundle = fs.readFileSync(file, 'utf8');

  const shim = /function openPrivateWindow\((\w*)\)\{return window\.openPrivateWindow\(/.exec(bundle);
  assert.ok(shim, 'the chat.js shim should still be present');

  const shimAt = shim.index;
  const realAt = bundle.lastIndexOf('function openPrivateWindow');
  assert.ok(realAt > shimAt, 'pm.js must still be concatenated after chat.js');
  assert.ok(
    !/return window\.openPrivateWindow/.test(bundle.slice(realAt, realAt + 200)),
    'the surviving declaration must be the real pm.js one, not the shim'
  );

});

test('concatenation reproduces the classic-script "last declaration wins" rule', () => {
  // The reason order matters at all: two classic scripts on a page may declare
  // the same global function, and the browser keeps the later one. A bundle has
  // to behave identically, which it does only if the order is untouched.
  const vm = require('node:vm');
  const context = vm.createContext({});

  const separate = vm.createContext({});
  vm.runInContext('function pick(){ return "first"; }', separate);
  vm.runInContext('function pick(){ return "second"; }', separate);

  vm.runInContext(['function pick(){ return "first"; }', 'function pick(){ return "second"; }'].join('\n;\n'), context);

  assert.equal(context.pick(), separate.pick());
  assert.equal(context.pick(), 'second');
});

test('minifying shrinks the payload', async () => {
  const { file } = bundleUrlFor('/index.html');
  const bundle = fs.statSync(file).size;

  const source = read('index.html');
  let raw = 0;
  for (const tag of findScriptTags(source)) {
    if (!isBundlableScript(tag.src.split('?')[0])) continue;
    raw += fs.statSync(path.join(PUBLIC, toFilePath(tag.src))).size;
  }

  assert.ok(bundle < raw * 0.8, `bundle ${bundle} should be well under the ${raw} bytes it replaces`);
});
