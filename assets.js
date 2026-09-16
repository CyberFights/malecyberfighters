/**
 * Built-asset lookup.
 *
 * `npm run build` (and `prestart`) writes `public/dist/`: minified,
 * content-hashed JS bundles and stylesheets, plus copies of the pages that
 * reference them. This module is the server's only view of that output.
 *
 * The contract is deliberately forgiving. `public/dist/` is a build artefact,
 * not source — it is gitignored, and a deploy that cannot build it (esbuild
 * missing, a file that fails to minify) must still serve the site. So every
 * lookup here falls back to the hand-written file in `public/`, and a missing
 * or corrupt manifest simply means "serve exactly what is in the repository".
 *
 * Hashed filenames are what make the immutable cache headers safe: the URL
 * changes whenever the bytes change, so a browser can never hold a stale copy.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
// Overridable so a test can point the lookups at a fixture directory instead
// of the real build output.
const DIST_DIR = process.env.MCF_DIST_DIR
  ? path.resolve(process.env.MCF_DIST_DIR)
  : path.join(PUBLIC_DIR, 'dist');
const PAGES_DIR = path.join(DIST_DIR, 'pages');
const MANIFEST_PATH = path.join(DIST_DIR, 'manifest.json');

/** How long a content-hashed asset may be cached: forever, in practice. */
const IMMUTABLE_MAX_AGE = '365d';

let cachedManifest;
let cachedMtimeMs;

function readManifest() {
  try {
    const stat = fs.statSync(MANIFEST_PATH);
    if (cachedManifest && cachedMtimeMs === stat.mtimeMs) return cachedManifest;
    cachedManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    cachedMtimeMs = stat.mtimeMs;
    return cachedManifest;
  } catch (_) {
    // No build output — the unbundled site is served instead.
    cachedManifest = null;
    cachedMtimeMs = undefined;
    return null;
  }
}

/**
 * The URL to serve for a source asset path such as `/css/desktop.css` or
 * `/js/utils.js`. Returns the hashed `/dist/...` URL when the build produced
 * one, otherwise the original path (still correct, just unoptimised).
 */
function assetUrl(sourcePath, kind) {
  const manifest = readManifest();
  if (!manifest) return sourcePath;
  const table = kind ? manifest[kind] : null;
  if (table && table[sourcePath]) return table[sourcePath];

  // Fall back to searching every table, so a caller does not have to know
  // whether a path was treated as js or css.
  for (const key of ['js', 'css']) {
    const hit = manifest[key] && manifest[key][sourcePath];
    if (hit) return hit;
  }
  return sourcePath;
}

/** True when the build produced a hashed copy of this asset. */
function hasBuiltAsset(sourcePath) {
  return assetUrl(sourcePath) !== sourcePath;
}

/**
 * The HTML file to serve for a page name: the rewritten copy under
 * `public/dist/pages/` when the build made one, else the source page.
 */
function pageFile(pageName) {
  const built = path.join(PAGES_DIR, pageName);
  if (fs.existsSync(built)) return built;
  return path.join(PUBLIC_DIR, pageName);
}

/** True when at least one page was rewritten by the build. */
function builtPagesExist() {
  const manifest = readManifest();
  return !!(manifest && manifest.pages && Object.keys(manifest.pages).length);
}

/** Drop the cached manifest (tests swap the dist directory underneath). */
function _resetCache() {
  cachedManifest = undefined;
  cachedMtimeMs = undefined;
}

module.exports = {
  _resetCache,
  readManifest,
  assetUrl,
  hasBuiltAsset,
  pageFile,
  builtPagesExist,
  PUBLIC_DIR,
  DIST_DIR,
  PAGES_DIR,
  MANIFEST_PATH,
  IMMUTABLE_MAX_AGE
};
