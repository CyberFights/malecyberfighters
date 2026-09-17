#!/usr/bin/env node
/**
 * Front-end asset build.
 *
 * The site ships hand-written classic scripts — no modules, no framework. Each
 * page loads its own run of ~30 `<script src="/js/...">` tags, all of which
 * share one global scope: a top-level `function` in one file is visible to the
 * next, and where two files declare the same name the *later* file wins. That
 * ordering is load-bearing (for example `chat.js` declares an
 * `openPrivateWindow` shim that `pm.js`, loaded after it, replaces with the
 * real implementation).
 *
 * So this build deliberately does NOT use a module bundler. Wrapping the files
 * in an IIFE would hide those globals and tree-shaking would drop declarations
 * that only other files (or inline HTML handlers) reference — both verified to
 * happen with `esbuild --bundle`. Instead it:
 *
 *   1. minifies each file with esbuild's *transform* only (`bundle: false`),
 *      which strips whitespace and comments and simplifies syntax but never
 *      renames or removes a top-level declaration, because esbuild treats an
 *      unbundled file's top level as global;
 *   2. concatenates a page's local scripts in their original order, separated
 *      by `;` so no two files can be joined into one statement;
 *   3. minifies the stylesheets the same way;
 *   4. writes everything to `public/dist/` under a content-hash filename and
 *      rewrites the page HTML to point at it.
 *
 * Content-hashed names are what makes `Cache-Control: immutable` safe: the URL
 * changes whenever the bytes change, so a stale file can never be served. That
 * replaces the old `/js/x.js?v=9` convention, which needed a hand-edited bump
 * on every deploy and still revalidated 30 files per visit.
 *
 * The build is optional by design. If esbuild is unavailable, a file fails to
 * minify, or anything else goes wrong, it logs and exits 0 having written no
 * manifest — and the server then serves `public/` exactly as it does today.
 * A broken optimisation must never stop the site from booting.
 *
 * Run with `npm run build` (or automatically via `prestart`).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DIST_DIR = path.join(PUBLIC_DIR, 'dist');
const PAGES_DIR = path.join(DIST_DIR, 'pages');

/** Pages whose local script run gets bundled, in the order they are written. */
const PAGES = [
  'index.html',
  'mobile.html',
  'mobile2.html',
  'guide.html',
  'offline.html',
  'reset-password.html',
  'landing.html'
];

/** Never bundled: served by the socket.io library itself, or third-party. */
function isBundlableScript(src) {
  if (!src.startsWith('/js/')) return false;
  if (src.includes('socket.io')) return false;
  return true;
}

function shortHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/** Lazily required so a missing esbuild degrades instead of throwing at load. */
function loadEsbuild() {
  try {
    return require('esbuild');
  } catch (err) {
    console.warn(`[build] esbuild unavailable (${err.message}) — skipping asset build`);
    return null;
  }
}

async function minifyJs(esbuild, code, filename) {
  const result = await esbuild.transform(code, {
    loader: 'js',
    minify: true,
    // `transform` (never `build`) is what keeps this safe: with no bundling,
    // esbuild treats a file's top level as global scope, so it minifies local
    // names only and never renames or drops a top-level declaration that other
    // scripts on the page depend on.
    target: ['es2019'],
    sourcefile: filename,
    legalComments: 'none'
  });
  return result.code;
}

async function minifyCss(esbuild, code, filename) {
  const result = await esbuild.transform(code, {
    loader: 'css',
    minify: true,
    sourcefile: filename
  });
  return result.code;
}

/**
 * A page's `<script src="...">` tags, in document order, with the exact match
 * so they can be spliced out.
 */
function findScriptTags(html) {
  const tags = [];
  const re = /<script\s+[^>]*?src=["']([^"']+)["'][^>]*?>\s*<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    tags.push({ full: match[0], src: match[1], index: match.index });
  }
  return tags;
}

function findStylesheetTags(html) {
  const tags = [];
  const re = /<link\s+[^>]*?rel=["']stylesheet["'][^>]*?>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = /href=["']([^"']+)["']/i.exec(match[0]);
    if (href) tags.push({ full: match[0], href: href[1], index: match.index });
  }
  return tags;
}

/** Strip a leading slash and any `?v=N` cache-buster from a served path. */
function toFilePath(urlPath) {
  return urlPath.split('?')[0].replace(/^\/+/, '');
}

/**
 * Names declared in the *global* scope of a classic script — the ones other
 * scripts on the same page can call, and therefore the ones a minifier must
 * never rename or drop.
 *
 * A line-based scan is not enough here: this codebase has plenty of function
 * bodies written at column 0 (`utils.js` declares a local `avatarHtml`,
 * `register.js` a local `res`), so indentation says nothing about scope. This
 * walks the text tracking brace depth while skipping comments, strings,
 * template literals (including nested `${}`) and regex literals, and collects
 * declarations seen at depth 0.
 *
 * Used as a build guard: if any of these names is missing from the minified
 * output, the file was treated as a module and the page is left unbundled
 * rather than shipping a silent break. See tests/build.test.js.
 */
function topLevelNames(code) {
  const names = new Set();
  const src = String(code);
  let depth = 0;
  let i = 0;
  /**
   * One frame per open template literal: 0 means "inside the literal text",
   * n > 0 means "inside n nested braces of a ${ ... } expression". Kept as a
   * stack because a `${}` expression can contain another template literal.
   */
  const templates = [];
  /** The last significant token, used to tell `/regex/` from division. */
  let prev = '';

  const isIdentChar = c => /[\w$]/.test(c);
  const wordAt = pos => {
    let end = pos;
    while (end < src.length && isIdentChar(src[end])) end += 1;
    return src.slice(pos, end);
  };
  const inTemplateText = () => templates.length && templates[templates.length - 1] === 0;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // --- template literal text ---
    // Checked first: inside the text of a `...` literal, quotes, slashes and
    // braces are ordinary characters, and the closing backtick must pop the
    // frame rather than open a new one.
    if (inTemplateText()) {
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && next === '{') { templates[templates.length - 1] = 1; i += 2; continue; }
      if (c === '`') { templates.pop(); i += 1; prev = 'str'; continue; }
      if (c === '\n') { /* stay in text, nothing to track */ }
      i += 1;
      continue;
    }

    // --- comments ---
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    // --- strings ---
    if (c === '"' || c === "'") {
      i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') break; // unterminated; do not swallow the file
        i += 1;
      }
      i += 1;
      prev = 'str';
      continue;
    }

    // --- opening a template literal (also from inside a ${} expression) ---
    if (c === '`') { templates.push(0); i += 1; continue; }

    // --- braces belonging to a ${ ... } expression ---
    if (templates.length) {
      const open = templates[templates.length - 1];
      if (c === '{') { templates[templates.length - 1] = open + 1; i += 1; continue; }
      if (c === '}') { templates[templates.length - 1] = open - 1; i += 1; continue; }
    }

    // --- regex literals (heuristic on the previous significant token) ---
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev) ||
        /^(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const rc = src[j];
        if (rc === '\\') { j += 2; continue; }
        if (rc === '\n') break; // not a regex after all — it is division
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) break;
        j += 1;
      }
      if (j < src.length && src[j] === '/') {
        i = j + 1;
        while (i < src.length && /[a-z]/.test(src[i])) i += 1; // flags
        prev = 'str';
        continue;
      }
    }

    // --- braces in real code ---
    if (!templates.length) {
      if (c === '{') depth += 1;
      else if (c === '}') depth = Math.max(0, depth - 1);
    }

    // --- identifiers and declarations ---
    if (/[a-zA-Z_$]/.test(c) && !isIdentChar(src[i - 1] || '')) {
      const word = wordAt(i);
      if (depth === 0 && !templates.length &&
          (word === 'const' || word === 'let' || word === 'var' ||
           word === 'class' || word === 'function')) {
        let j = i + word.length;
        while (j < src.length && /\s/.test(src[j])) j += 1;
        // `function (` is an anonymous function expression, not a declaration.
        if (/[A-Za-z_$]/.test(src[j] || '')) names.add(wordAt(j));
        prev = word;
        i = j;
        continue;
      }
      prev = word;
      i += word.length;
      continue;
    }

    if (!/\s/.test(c)) prev = c;
    i += 1;
  }

  return names;
}

/** Does `name` still occur as a whole identifier in `code`? */
function hasIdentifier(code, name) {
  const escaped = name.replace(/[$]/g, '\\$');
  return new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(code);
}

/**
 * Compile the bundle without running it. Catches the one hazard concatenation
 * introduces — two files joining into a single malformed statement — before it
 * ever reaches a browser.
 */
function compiles(code) {
  try {
    new vm.Script(code, { filename: 'bundle.js' });
    return null;
  } catch (err) {
    return err.message;
  }
}

async function build() {
  const esbuild = loadEsbuild();
  if (!esbuild) return false;

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(PAGES_DIR, { recursive: true });

  /** original served path ("/js/utils.js") -> hashed path ("/dist/js/utils.abc123.js") */
  const manifest = { js: {}, css: {}, pages: {} };

  const stats = { jsIn: 0, jsOut: 0, cssIn: 0, cssOut: 0, pages: 0, requests: 0 };

  // ---------- stylesheets ----------
  const cssDir = path.join(PUBLIC_DIR, 'css');
  const cssFiles = [];
  if (fs.existsSync(cssDir)) {
    cssFiles.push(...fs.readdirSync(cssDir).filter(f => f.endsWith('.css')).map(f => `css/${f}`));
  }
  for (const extra of ['landing.css']) {
    if (fs.existsSync(path.join(PUBLIC_DIR, extra))) cssFiles.push(extra);
  }

  for (const rel of cssFiles) {
    const abs = path.join(PUBLIC_DIR, rel);
    const source = fs.readFileSync(abs, 'utf8');
    let code;
    try {
      code = await minifyCss(esbuild, source, rel);
    } catch (err) {
      console.warn(`[build] ${rel}: minify failed (${err.message}) — serving original`);
      continue;
    }
    const name = `${path.basename(rel, '.css')}.${shortHash(code)}.css`;
    const outRel = path.join('css', name);
    fs.mkdirSync(path.join(DIST_DIR, 'css'), { recursive: true });
    fs.writeFileSync(path.join(DIST_DIR, outRel), code);

    manifest.css[`/${rel}`] = `/dist/${outRel.replace(/\\/g, '/')}`;
    stats.cssIn += Buffer.byteLength(source);
    stats.cssOut += Buffer.byteLength(code);
  }

  // ---------- scripts, bundled per page ----------
  for (const page of PAGES) {
    const pagePath = path.join(PUBLIC_DIR, page);
    if (!fs.existsSync(pagePath)) continue;

    let html = fs.readFileSync(pagePath, 'utf8');
    const scriptTags = findScriptTags(html).filter(tag => isBundlableScript(tag.src.split('?')[0]));
    if (!scriptTags.length) continue;

    const parts = [];
    let failed = false;

    for (const tag of scriptTags) {
      const rel = toFilePath(tag.src);
      const abs = path.join(PUBLIC_DIR, rel);
      if (!fs.existsSync(abs)) {
        console.warn(`[build] ${page}: missing ${rel} — page left unbundled`);
        failed = true;
        break;
      }

      // Minify once per file, reused by every page that loads it.
      if (!manifest.js[`/${rel}`]) {
        const source = fs.readFileSync(abs, 'utf8');
        let code;
        try {
          code = await minifyJs(esbuild, source, rel);
        } catch (err) {
          console.warn(`[build] ${page}: ${rel} failed to minify (${err.message}) — page left unbundled`);
          failed = true;
          break;
        }
        stats.jsIn += Buffer.byteLength(source);
        stats.jsOut += Buffer.byteLength(code);
        // Held in memory; written below as part of each page bundle.
        manifest.js[`/${rel}`] = { code, names: topLevelNames(source) };
      }
      parts.push(manifest.js[`/${rel}`]);
    }

    if (failed) continue;

    // `;` between files: two adjacent files can never be parsed as one
    // statement, and the order (so the last-wins global overrides) is kept.
    const bundle = parts.map(part => part.code).join('\n;\n');

    // Two guards before this bundle is allowed to replace the page's scripts.
    const syntaxError = compiles(bundle);
    if (syntaxError) {
      console.warn(`[build] ${page}: bundle does not compile (${syntaxError}) — page left unbundled`);
      continue;
    }

    const lostGlobals = [];
    for (const part of parts) {
      for (const name of part.names) {
        if (!hasIdentifier(bundle, name)) lostGlobals.push(name);
      }
    }
    if (lostGlobals.length) {
      console.warn(
        `[build] ${page}: minifier dropped top-level global(s) ` +
        `${[...new Set(lostGlobals)].join(', ')} — page left unbundled`
      );
      continue;
    }

    const stem = path.basename(page, '.html');
    const name = `${stem}.${shortHash(bundle)}.js`;
    fs.mkdirSync(path.join(DIST_DIR, 'js'), { recursive: true });
    fs.writeFileSync(path.join(DIST_DIR, 'js', name), bundle);

    const bundleUrl = `/dist/js/${name}`;

    // Single pass over the original offsets: the bundle takes the place of the
    // first script tag (so execution order relative to the remaining,
    // non-bundled tags is unchanged) and the rest are removed.
    const sorted = scriptTags.slice().sort((a, b) => a.index - b.index);
    let out = '';
    let cursor = 0;
    sorted.forEach((tag, i) => {
      out += html.slice(cursor, tag.index);
      out += i === 0 ? `<script src="${bundleUrl}"></script>` : '';
      cursor = tag.index + tag.full.length;
    });
    html = out + html.slice(cursor);

    // Point stylesheets at their hashed copies. Substituting the href value
    // itself keeps this independent of the offsets rewritten above.
    for (const tag of findStylesheetTags(html)) {
      const hashed = manifest.css[`/${toFilePath(tag.href)}`];
      if (!hashed || hashed === tag.href) continue;
      html = html.split(tag.href).join(hashed);
    }

    fs.writeFileSync(path.join(PAGES_DIR, page), html);
    manifest.pages[`/${page}`] = `/dist/pages/${page}`;
    stats.pages += 1;
    stats.requests += scriptTags.length - 1;
  }

  // The per-file `code` payloads were only needed while bundling.
  for (const key of Object.keys(manifest.js)) {
    const rel = toFilePath(key);
    const { code } = manifest.js[key];
    const name = `${path.basename(rel, '.js')}.${shortHash(code)}.js`;
    fs.mkdirSync(path.join(DIST_DIR, 'js'), { recursive: true });
    fs.writeFileSync(path.join(DIST_DIR, 'js', name), code);
    manifest.js[key] = `/dist/js/${name}`;
  }

  fs.writeFileSync(path.join(DIST_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const pct = (before, after) =>
    before ? `${((1 - after / before) * 100).toFixed(1)}%` : '0%';

  console.log(
    `[build] ${stats.pages} page bundle(s), ${stats.requests} request(s) removed\n` +
    `[build] js  ${(stats.jsIn / 1024).toFixed(0)} KB -> ${(stats.jsOut / 1024).toFixed(0)} KB (${pct(stats.jsIn, stats.jsOut)})\n` +
    `[build] css ${(stats.cssIn / 1024).toFixed(0)} KB -> ${(stats.cssOut / 1024).toFixed(0)} KB (${pct(stats.cssIn, stats.cssOut)})`
  );
  return true;
}

if (require.main === module) {
  build()
    .catch(err => {
      // Never fail `npm start`: without dist/ the server serves public/ as-is.
      console.warn(`[build] skipped (${err && err.message ? err.message : err})`);
      return false;
    })
    .then(ok => process.exit(ok ? 0 : 0));
}

module.exports = {
  build,
  topLevelNames,
  hasIdentifier,
  compiles,
  findScriptTags,
  findStylesheetTags,
  isBundlableScript,
  toFilePath,
  shortHash,
  DIST_DIR,
  PAGES_DIR,
  PAGES
};
