/**
 * Tests for the shared scroll-back controller (public/js/scroll-back.js).
 *
 * The module only needs a scroller it can measure and something to click, so
 * these drive it with plain fakes rather than a DOM — which also means the
 * scroll arithmetic can be asserted exactly, something a real browser's layout
 * engine would only approximate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'scroll-back.js'), 'utf8');

/** A scrollable element whose metrics the test controls. */
function fakeScroller({ scrollHeight = 2000, clientHeight = 400, scrollTop = 1600 } = {}) {
  const target = new EventTarget();
  return {
    scrollHeight,
    clientHeight,
    scrollTop,
    addEventListener: (type, fn, opts) => target.addEventListener(type, fn, opts),
    removeEventListener: (type, fn) => target.removeEventListener(type, fn),
    /** Fire the scroll event the way a reader reaching the top would. */
    scroll() { target.dispatchEvent(new Event('scroll')); }
  };
}

function fakeButton() {
  const target = new EventTarget();
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    addEventListener: (type, fn) => target.addEventListener(type, fn),
    removeEventListener: (type, fn) => target.removeEventListener(type, fn),
    click() { target.dispatchEvent(new Event('click')); }
  };
}

function fakeBar() { return { hidden: true }; }
function fakeStatus() { return { textContent: '' }; }

/** Run the module in a sandbox with just enough of a browser for it to load. */
function loadModule() {
  const sandbox = { window: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return sandbox.window.MCFScrollBack;
}

/** A two-page history: page 1 (newest) then page 2 (older), then the end. */
function history(pages) {
  const requests = [];
  return {
    requests,
    load: async before => {
      requests.push(before);
      const page = pages.shift();
      if (!page) return { messages: [], oldest: null, hasMore: false };
      return page;
    }
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a controller with nothing to page is inert rather than an exception', () => {
  const { create } = loadModule();
  const controller = create({});
  controller.reset({ hasMore: true, oldest: 'x' });
  assert.equal(typeof controller.loadOlder, 'function');
  controller.destroy();
});

test('the bar only appears when the server says there is more history', () => {
  const { create } = loadModule();
  const scroller = fakeScroller();
  const bar = fakeBar();
  const button = fakeButton();

  const controller = create({
    scroller,
    ui: { bar, button, status: fakeStatus() },
    load: async () => ({ messages: [], oldest: null, hasMore: false }),
    prepend: () => {}
  });

  controller.reset({ oldest: null, hasMore: false });
  assert.equal(bar.hidden, true, 'a short conversation offers no control');

  controller.reset({ oldest: '2026-01-01T00:00:00.000Z', hasMore: true });
  assert.equal(bar.hidden, false);
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /earlier/i);
});

test('reaching the top asks for the page behind the oldest message on screen', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller();
  const prepended = [];
  const server = history([
    { messages: ['older-1', 'older-2'], oldest: '2025-12-01T00:00:00.000Z', hasMore: true }
  ]);

  const controller = create({
    scroller,
    ui: { bar: fakeBar(), button: fakeButton(), status: fakeStatus() },
    load: server.load,
    prepend: messages => prepended.push(...messages)
  });
  controller.reset({ oldest: '2026-01-01T00:00:00.000Z', hasMore: true });

  scroller.scrollTop = 10; // a reader who scrolled to the top
  scroller.scroll();
  await tick();

  // The cursor is the oldest timestamp already rendered, which is what makes
  // the next page continue the conversation instead of repeating it.
  assert.deepEqual(server.requests, ['2026-01-01T00:00:00.000Z']);
  assert.deepEqual(prepended, ['older-1', 'older-2']);
});

test('a reader who scrolls up keeps their place when the older page lands', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller({ scrollHeight: 2000, clientHeight: 400, scrollTop: 300 });
  const server = history([
    { messages: ['a', 'b'], oldest: 'older', hasMore: true }
  ]);

  const controller = create({
    scroller,
    ui: { bar: fakeBar(), button: fakeButton(), status: fakeStatus() },
    load: server.load,
    // Prepending grows the content above the viewport by 500px.
    prepend: () => { scroller.scrollHeight += 500; }
  });
  controller.reset({ oldest: 'cursor', hasMore: true });

  scroller.scrollTop = 20;
  scroller.scroll();
  await tick();

  // Without the correction the message being read would slide 500px down and
  // off the screen; with it, the same content is still under the reader.
  assert.equal(scroller.scrollTop, 520);
});

test('a reader watching the live end stays pinned to the bottom', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller({ scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 });
  const server = history([{ messages: ['a'], oldest: 'older', hasMore: true }]);

  const controller = create({
    scroller,
    ui: { bar: fakeBar(), button: fakeButton(), status: fakeStatus() },
    load: server.load,
    prepend: () => { scroller.scrollHeight += 500; }
  });
  controller.reset({ oldest: 'cursor', hasMore: true });

  // scrollTop 1600 + clientHeight 400 === scrollHeight 2000: at the bottom.
  scroller.scrollTop = 0;
  scroller.scrollHeight = 400; // a feed too short to scroll is also "at bottom"
  scroller.scroll();
  await tick();

  assert.equal(scroller.scrollTop, scroller.scrollHeight);
});

test('only one page is in flight however hard the reader scrolls', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller();
  let resolveFirst;
  const requests = [];

  const controller = create({
    scroller,
    ui: { bar: fakeBar(), button: fakeButton(), status: fakeStatus() },
    load: async before => {
      requests.push(before);
      if (requests.length === 1) {
        await new Promise(resolve => { resolveFirst = resolve; });
      }
      return { messages: [], oldest: null, hasMore: false };
    },
    prepend: () => {}
  });
  controller.reset({ oldest: 'cursor', hasMore: true });

  scroller.scrollTop = 0;
  scroller.scroll();
  scroller.scroll();
  scroller.scroll();
  await tick();

  // A trackpad flick at the top fires dozens of scroll events; each one must
  // not become its own request for the same page.
  assert.equal(requests.length, 1);
  resolveFirst();
  await tick();
});

test('the end of the history says so and stops asking', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller();
  const bar = fakeBar();
  const button = fakeButton();
  const status = fakeStatus();
  const server = history([
    { messages: ['last-page'], oldest: 'oldest-ever', hasMore: false }
  ]);

  const controller = create({
    scroller,
    ui: { bar, button, status },
    load: server.load,
    prepend: () => {}
  });
  controller.reset({ oldest: 'cursor', hasMore: true });

  scroller.scrollTop = 0;
  scroller.scroll();
  await tick();

  assert.equal(server.requests.length, 1);
  assert.equal(bar.hidden, true, 'nothing left to load, nothing to offer');
  assert.match(status.textContent, /beginning/i);

  scroller.scroll();
  await tick();
  assert.equal(server.requests.length, 1, 'a second scroll does not re-ask');
});

test('a short page ends the paging even if the server over-promised', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller();
  const bar = fakeBar();
  const server = history([
    // hasMore true but no rows: trust the rows, not the flag.
    { messages: [], oldest: null, hasMore: true }
  ]);

  const controller = create({
    scroller,
    ui: { bar, button: fakeButton(), status: fakeStatus() },
    load: server.load,
    prepend: () => { throw new Error('should not be asked to render nothing'); }
  });
  controller.reset({ oldest: 'cursor', hasMore: true });

  scroller.scrollTop = 0;
  scroller.scroll();
  await tick();

  assert.equal(bar.hidden, true);
});

test('the button works for a reader who would rather click than scroll', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller();
  const button = fakeButton();
  const server = history([{ messages: ['a'], oldest: 'o', hasMore: true }]);

  const controller = create({
    scroller,
    ui: { bar: fakeBar(), button, status: fakeStatus() },
    load: server.load,
    prepend: () => {}
  });
  controller.reset({ oldest: 'cursor', hasMore: true });

  // Not scrolled anywhere near the top.
  scroller.scrollTop = 1500;
  button.click();
  await tick();

  assert.deepEqual(server.requests, ['cursor']);
});

test('a failed page load reports itself and leaves the reader able to retry', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller();
  const button = fakeButton();
  const status = fakeStatus();
  let attempt = 0;

  const controller = create({
    scroller,
    ui: { bar: fakeBar(), button, status },
    load: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('server_error');
      return { messages: ['recovered'], oldest: 'o', hasMore: false };
    },
    prepend: () => {}
  });
  controller.reset({ oldest: 'cursor', hasMore: true });

  scroller.scrollTop = 0;
  scroller.scroll();
  await tick();

  assert.match(status.textContent, /could not load/i);
  assert.equal(button.disabled, false, 'not stuck in a loading state');
  assert.match(button.textContent, /earlier/i);

  scroller.scroll();
  await tick();
  assert.equal(attempt, 2, 'the reader can try again');
});

test('a render failure does not wedge the controller either', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller();
  const status = fakeStatus();
  const server = history([
    { messages: ['a'], oldest: 'o', hasMore: true },
    { messages: ['b'], oldest: 'o2', hasMore: false }
  ]);

  let prependCalls = 0;
  const controller = create({
    scroller,
    ui: { bar: fakeBar(), button: fakeButton(), status },
    load: server.load,
    prepend: () => {
      prependCalls += 1;
      if (prependCalls === 1) throw new Error('dom exploded');
    }
  });
  controller.reset({ oldest: 'cursor', hasMore: true });

  scroller.scrollTop = 0;
  scroller.scroll();
  await tick();
  assert.match(status.textContent, /could not display/i);

  scroller.scroll();
  await tick();
  assert.equal(prependCalls, 2);
});

test('destroying the controller unhooks the feed', async () => {
  const { create } = loadModule();
  const scroller = fakeScroller();
  const bar = fakeBar();
  const server = history([{ messages: ['a'], oldest: 'o', hasMore: true }]);

  const controller = create({
    scroller,
    ui: { bar, button: fakeButton(), status: fakeStatus() },
    load: server.load,
    prepend: () => {}
  });
  controller.reset({ oldest: 'cursor', hasMore: true });
  controller.destroy();

  assert.equal(bar.hidden, true);
  scroller.scrollTop = 0;
  scroller.scroll();
  await tick();
  assert.equal(server.requests.length, 0, 'a closed DM window must not keep paging');
});
