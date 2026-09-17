/**
 * Cursor paging for a transcript feed.
 *
 * Two feeds on the site page backwards through history — the arena transcript
 * (`GET /api/public-messages`) and a DM conversation (`POST /api/dm/history`) —
 * and both need the same four things decided the same way:
 *
 *   - how big a page is, and how big a client may ask for
 *   - what "older than this" means when the cursor is missing or unparsable
 *   - which timestamp field the filter is built on
 *   - what the response says about whether another page exists
 *
 * Written twice, those drift; a client that pages one feed then the other would
 * see two different contracts. This is the single copy, and because it is a
 * module rather than inline route code it can be tested without a database
 * (tests/history-paging.test.js).
 *
 * The cursor is a timestamp rather than an offset on purpose. An offset shifts
 * whenever a message arrives while the reader is scrolling, which skips or
 * repeats a row; "everything strictly older than the oldest thing I have" is
 * stable no matter what lands in between.
 */
'use strict';

/** What a client gets when it does not ask for a size. */
const DEFAULT_PAGE = 200;
/** What a client gets when it asks for something absurd. */
const MAX_PAGE = 500;

/**
 * A page size the server is willing to serve. Anything that is not a positive
 * integer falls back to the default rather than to "no limit".
 */
function parseLimit(value, { page = DEFAULT_PAGE, max = MAX_PAGE } = {}) {
  const requested = parseInt(value, 10);
  if (!Number.isFinite(requested) || requested <= 0) return page;
  return Math.min(requested, max);
}

/**
 * The cursor, or null when the client is asking for the newest page. An
 * unparsable value is treated as "no cursor": failing open to the newest page
 * is a shrug, where failing closed would hide the whole feed.
 */
function parseBefore(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The filter fragment that restricts a query to one side of the cursor. */
function beforeFilter(before, field = 'time') {
  return before ? { [field]: { $lt: before } } : {};
}

/**
 * Read a paging request out of a query string or a JSON body — the two feeds
 * use different verbs, and the contract should not depend on that.
 */
function pagingRequest(source, options = {}) {
  const src = source || {};
  const field = options.field || 'time';
  const limit = parseLimit(src.limit, options);
  const before = parseBefore(src.before);
  return { limit, before, filter: beforeFilter(before, field) };
}

/**
 * The response envelope. `messages` arrive oldest-first, the order a feed
 * renders, so the first row is the cursor for the next page back.
 */
function pageEnvelope(messages, { limit = DEFAULT_PAGE, field = 'time' } = {}) {
  const rows = messages || [];
  return {
    messages: rows,
    oldest: rows.length ? rows[0][field] : null,
    // A full page means there is probably more behind it; a short one means the
    // reader has reached the beginning and the client can stop asking.
    hasMore: rows.length === limit
  };
}

module.exports = {
  DEFAULT_PAGE,
  MAX_PAGE,
  parseLimit,
  parseBefore,
  beforeFilter,
  pagingRequest,
  pageEnvelope
};
