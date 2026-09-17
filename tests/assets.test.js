/**
 * Tests for assets.js — the server's view of the build output.
 *
 * The rule that matters is the fallback: `public/dist/` is a gitignored build
 * artefact, so a deploy that could not produce it must still serve the site.
 * Every lookup therefore has to degrade to the hand-written file in `public/`
 * rather than throw or 404.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');

/** Load assets.js against a chosen dist directory (it reads the env at load). */
function loadAssets(distDir) {
  process.env.MCF_DIST_DIR = distDir;
  delete require.cache[require.resolve('../assets')];
  const mod = require('../assets');
  mod._resetCache();
  return mod;
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcf-dist-'));
  return dir;
}

/* ---------------------------------------------------------------
   No build output
--------------------------------------------------------------- */

test('without a manifest every lookup falls back to the source file', () => {
  const assets = loadAssets(path.join(fixture(), 'missing'));

  assert.equal(assets.readManifest(), null);
  assert.equal(assets.assetUrl('/css/desktop.css'), '/css/desktop.css');
  assert.equal(assets.assetUrl('/js/utils.js', 'js'), '/js/utils.js');
  assert.equal(assets.hasBuiltAsset('/css/desktop.css'), false);
  assert.equal(assets.builtPagesExist(), false);
  assert.equal(assets.pageFile('index.html'), path.join(PUBLIC, 'index.html'));
  assert.ok(fs.existsSync(assets.pageFile('index.html')), 'the source page must exist');
});

test('a corrupt manifest is treated as no manifest', () => {
  const dir = fixture();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json');

  const assets = loadAssets(dir);
  assert.equal(assets.readManifest(), null);
  assert.equal(assets.assetUrl('/css/desktop.css'), '/css/desktop.css');
  assert.equal(assets.pageFile('index.html'), path.join(PUBLIC, 'index.html'));
});

/* ---------------------------------------------------------------
   With build output
--------------------------------------------------------------- */

test('a manifest resolves assets to their hashed copies', () => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    js: { '/js/utils.js': '/dist/js/utils.abc123def456.js' },
    css: { '/css/desktop.css': '/dist/css/desktop.abc123def456.css' },
    pages: { '/index.html': '/dist/pages/index.html' }
  }));
  fs.writeFileSync(path.join(dir, 'pages', 'index.html'), '<html>built</html>');

  const assets = loadAssets(dir);

  assert.equal(assets.assetUrl('/css/desktop.css', 'css'), '/dist/css/desktop.abc123def456.css');
  assert.equal(assets.assetUrl('/js/utils.js', 'js'), '/dist/js/utils.abc123def456.js');
  assert.equal(assets.hasBuiltAsset('/css/desktop.css'), true);
  assert.equal(assets.builtPagesExist(), true);
  assert.equal(assets.pageFile('index.html'), path.join(dir, 'pages', 'index.html'));
});

test('the kind hint is optional — every table is searched', () => {
  const dir = fixture();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    js: {},
    css: { '/css/mobile.css': '/dist/css/mobile.deadbeef0000.css' },
    pages: {}
  }));

  const assets = loadAssets(dir);
  assert.equal(assets.assetUrl('/css/mobile.css', 'js'), '/dist/css/mobile.deadbeef0000.css');
  assert.equal(assets.assetUrl('/css/mobile.css'), '/dist/css/mobile.deadbeef0000.css');
});

test('an asset the build did not produce keeps its source URL', () => {
  const dir = fixture();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    js: {}, css: { '/css/desktop.css': '/dist/css/desktop.x.css' }, pages: {}
  }));

  const assets = loadAssets(dir);
  assert.equal(assets.assetUrl('/css/never-built.css', 'css'), '/css/never-built.css');
});

test('a page with no built copy is served from public/', () => {
  const dir = fixture();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ js: {}, css: {}, pages: {} }));

  const assets = loadAssets(dir);
  assert.equal(assets.builtPagesExist(), false);
  assert.equal(assets.pageFile('offline.html'), path.join(PUBLIC, 'offline.html'));
});

/* ---------------------------------------------------------------
   Against the real build, when one exists
--------------------------------------------------------------- */

test('the real build output resolves the app shell and its stylesheet', t => {
  delete process.env.MCF_DIST_DIR;
  delete require.cache[require.resolve('../assets')];
  const assets = require('../assets');
  assets._resetCache();

  const manifest = assets.readManifest();
  if (!manifest || !manifest.pages['/index.html']) {
    t.skip('no build output present (run npm run build)');
    return;
  }

  const shell = assets.pageFile('index.html');
  assert.ok(shell.includes(path.join('dist', 'pages')), 'the built shell should win');
  assert.ok(fs.existsSync(shell));

  const builtCss = assets.assetUrl('/css/desktop.css', 'css');
  assert.match(builtCss, /^\/dist\/css\/desktop\.[0-9a-f]{12}\.css$/);
  assert.ok(fs.existsSync(path.join(PUBLIC, builtCss.replace(/^\//, ''))), 'the hashed file must exist on disk');

  // The rewritten shell must actually reference what the manifest advertises.
  const html = fs.readFileSync(shell, 'utf8');
  assert.ok(html.includes(assets.assetUrl('/js/utils.js', 'js').split('/').pop().split('.')[0]) ||
    /\/dist\/js\/index\.[0-9a-f]{12}\.js/.test(html),
    'the shell should reference a bundle under /dist/js/');
});
