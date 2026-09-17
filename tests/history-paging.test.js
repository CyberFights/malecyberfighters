/**
 * Tests for the cursor paging shared by the arena feed and the DM feed
 * (historyPaging.js).
 *
 * Both routes answer "give me the page behind what I already have", and both
 * clients scroll up to ask. These pin the contract down: how big a page may be,
 * what a missing or malformed cursor means, and when the response says there is
 * another page behind it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PAGE,
  MAX_PAGE,
  parseLimit,
  parseBefore,
  beforeFilter,
  pagingRequest,
  pageEnvelope
} = require('../historyPaging');

const at = iso => new Date(iso);
const row = iso => ({ _id: iso, time: at(iso), text: `message ${iso}` });

test('no cursor means the newest page, at the default size', () => {
  const request = pagingRequest({});

  assert.equal(request.limit, DEFAULT_PAGE);
  assert.equal(request.before, null);
  // An empty filter, so the query is the one that has always been served.
  assert.deepEqual(request.filter, {});
});

test('a page size is clamped, never trusted', () => {
  assert.equal(parseLimit('50'), 50);
  assert.equal(parseLimit(50), 50);
  assert.equal(parseLimit('100000'), MAX_PAGE, 'a client cannot ask for the whole collection');
  assert.equal(parseLimit('0'), DEFAULT_PAGE);
  assert.equal(parseLimit('-20'), DEFAULT_PAGE);
  assert.equal(parseLimit('all of them'), DEFAULT_PAGE);
  assert.equal(parseLimit(undefined), DEFAULT_PAGE);
});

test('each feed keeps its own default and ceiling', () => {
  const request = pagingRequest({}, { page: 25, max: 40 });
  assert.equal(request.limit, 25);
  assert.equal(pagingRequest({ limit: '500' }, { page: 25, max: 40 }).limit, 40);
});

test('a query string and a JSON body page the same way', () => {
  // GET arrives with strings, POST with whatever JSON carried; one contract.
  const fromQuery = pagingRequest({ limit: '100', before: '2026-09-01T00:00:00.000Z' });
  const fromBody = pagingRequest({ limit: 100, before: '2026-09-01T00:00:00.000Z' });

  assert.equal(fromQuery.limit, fromBody.limit);
  assert.deepEqual(fromQuery.filter, fromBody.filter);
  assert.equal(fromQuery.before.toISOString(), '2026-09-01T00:00:00.000Z');
});

test('the cursor becomes a strictly-older filter', () => {
  const cursor = at('2026-09-01T12:00:00.000Z');

  assert.deepEqual(beforeFilter(cursor), { time: { $lt: cursor } });
  assert.deepEqual(beforeFilter(null), {});
  // A collection that timestamps on a different field can still be paged.
  assert.deepEqual(beforeFilter(cursor, 'createdAt'), { createdAt: { $lt: cursor } });
});

test('a malformed cursor falls back to the newest page instead of an empty one', () => {
  assert.equal(parseBefore('not a date'), null);
  assert.equal(parseBefore(''), null);
  assert.equal(parseBefore(null), null);
  assert.deepEqual(pagingRequest({ before: 'yesterday-ish' }).filter, {});
});

test('the envelope reports the cursor for the next page and whether there is one', () => {
  const messages = [row('2026-09-01T00:00:00.000Z'), row('2026-09-02T00:00:00.000Z')];

  // A full page: there is probably more behind it.
  const full = pageEnvelope(messages, { limit: 2 });
  assert.equal(full.hasMore, true);
  assert.deepEqual(full.oldest, at('2026-09-01T00:00:00.000Z'));
  assert.equal(full.messages.length, 2);

  // A short page: the reader has reached the beginning.
  const short = pageEnvelope(messages, { limit: 5 });
  assert.equal(short.hasMore, false);

  const empty = pageEnvelope([], { limit: 5 });
  assert.deepEqual(empty, { messages: [], oldest: null, hasMore: false });

  // A missing array is an empty page, not an exception.
  assert.deepEqual(pageEnvelope(undefined, { limit: 5 }).messages, []);
});

test('the cursor round-trips without repeating or skipping a message', () => {
  // Everything the site has, newest last.
  const all = [
    row('2026-09-01T00:00:00.000Z'),
    row('2026-09-02T00:00:00.000Z'),
    row('2026-09-03T00:00:00.000Z'),
    row('2026-09-04T00:00:00.000Z'),
    row('2026-09-05T00:00:00.000Z')
  ];

  /** What the route does: newest first, limited, then back into display order. */
  const serve = (filter, limit) => all
    .filter(r => !filter.time || r.time < filter.time.$lt)
    .sort((a, b) => b.time - a.time)
    .slice(0, limit)
    .reverse();

  const first = pagingRequest({ limit: '2' });
  const pageOne = serve(first.filter, first.limit);
  const envelopeOne = pageEnvelope(pageOne, { limit: first.limit });

  assert.deepEqual(pageOne.map(r => r._id), [
    '2026-09-04T00:00:00.000Z',
    '2026-09-05T00:00:00.000Z'
  ]);
  assert.equal(envelopeOne.hasMore, true);

  // The client sends back exactly what the envelope gave it.
  const second = pagingRequest({ limit: '2', before: envelopeOne.oldest });
  const pageTwo = serve(second.filter, second.limit);
  const envelopeTwo = pageEnvelope(pageTwo, { limit: second.limit });

  assert.deepEqual(pageTwo.map(r => r._id), [
    '2026-09-02T00:00:00.000Z',
    '2026-09-03T00:00:00.000Z'
  ]);
  assert.equal(envelopeTwo.hasMore, true);

  const third = pagingRequest({ limit: '2', before: envelopeTwo.oldest });
  const pageThree = serve(third.filter, third.limit);
  const envelopeThree = pageEnvelope(pageThree, { limit: third.limit });

  assert.deepEqual(pageThree.map(r => r._id), ['2026-09-01T00:00:00.000Z']);
  assert.equal(envelopeThree.hasMore, false, 'the last page is short, so paging stops');

  // Walking the archive backwards sees every message exactly once. The pages
  // arrive newest-batch-first, but each one is internally chronological, which
  // is what the feed prepends.
  const seen = [...pageOne, ...pageTwo, ...pageThree].map(r => r._id);
  assert.deepEqual([...seen].sort(), all.map(r => r._id).sort());
  assert.equal(new Set(seen).size, all.length, 'nothing repeated, nothing skipped');
  assert.deepEqual(pageOne.map(r => r._id), [...pageOne.map(r => r._id)].sort());
});

test('a message that lands mid-scroll does not shift the pages', () => {
  // The reason the cursor is a timestamp rather than an offset: an arrival
  // changes every offset after it, but nothing about "older than this moment".
  const stored = [row('2026-09-01T00:00:00.000Z'), row('2026-09-02T00:00:00.000Z')];
  const cursor = at('2026-09-03T00:00:00.000Z');

  const before = stored.filter(r => r.time < cursor).map(r => r._id);
  stored.push(row('2026-09-05T00:00:00.000Z')); // a newer message arrives
  const after = stored.filter(r => r.time < cursor).map(r => r._id);

  assert.deepEqual(before, after, 'the older page is unchanged by a new arrival');
});
