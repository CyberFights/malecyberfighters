/**
 * Tests for the fighter tag catalogue (public/js/tags.js).
 *
 * The same file is the browser's catalogue and the server's validator — it is
 * what index.js requires for /api/register, /api/update-profile and the roster
 * search — so these tests pin the rules both sides depend on:
 *
 *   • the four categories, their per-category limits and their stable ids
 *   • what /api/* accepts (an unknown id must never fail a save)
 *   • what a bad shape does (a 400 with invalid_tags, not a silent write)
 *   • what a search means ("vers" finds Vers Top; "babyface" finds Face)
 *   • the Mongo fragments the roster query is built from
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Tags = require(path.join(__dirname, '..', 'public', 'js', 'tags.js'));

/** Every tag id in the catalogue, in order. */
const ALL_IDS = Tags.categoryKeys.flatMap(key =>
  Tags.CATEGORIES.find(category => category.key === key).tags.map(tag => tag.id)
);

/* ------------------------------------------------------------
   THE CATALOGUE
------------------------------------------------------------ */

test('the four categories are style, fetish, role and position', () => {
  assert.deepEqual(Tags.categoryKeys, ['style', 'fetish', 'role', 'position']);

  Tags.CATEGORIES.forEach(category => {
    assert.ok(category.label, `${category.key} has a label`);
    assert.ok(category.hint, `${category.key} explains itself to the member`);
    assert.ok(category.max > 0, `${category.key} has a limit`);
    assert.ok(category.tags.length > 0, `${category.key} offers tags`);
  });
});

test('every tag carries a stable id, a label and searchable aliases', () => {
  const seen = new Set();

  Tags.CATEGORIES.forEach(category => {
    category.tags.forEach(tag => {
      assert.match(tag.id, /^[a-z0-9-]+$/, `${tag.id} is a slug`);
      assert.ok(tag.label, `${tag.id} has a label`);
      assert.ok(Array.isArray(tag.aliases), `${tag.id} has an alias list`);
      assert.equal(seen.has(tag.id), false, `${tag.id} is used once`);
      seen.add(tag.id);
      assert.equal(Tags.lookup(tag.id).category, category.key, `${tag.id} knows its category`);
    });
  });

  // The four the feature was asked for, one per category.
  ['submission', 'singlet', 'heel', 'jobber', 'top', 'bottom'].forEach(id => {
    assert.ok(Tags.lookup(id), `${id} is in the catalogue`);
  });
});

test('lookup takes an id, a label or an alias', () => {
  assert.equal(Tags.lookup('High-Flyer').id, 'high-flyer');
  assert.equal(Tags.lookup('vers').id, 'versatile', 'an alias resolves');
  assert.equal(Tags.lookup(' Babyface ').id, 'face', 'case and padding are ignored');
  assert.equal(Tags.lookup('not-a-tag'), null);
  assert.equal(Tags.lookup(''), null);
});

/* ------------------------------------------------------------
   NORMALISING WHAT A CLIENT SENDS
------------------------------------------------------------ */

test('a normal save comes back normalised, with all four categories', () => {
  const result = Tags.normalize({
    style: ['submission', 'pro'],
    fetish: ['singlet', 'boots'],
    role: ['heel'],
    position: ['top', 'dom']
  });

  assert.equal(result.ok, true);
  // Catalogue order, not the order the client sent.
  assert.deepEqual(result.tags, {
    style: ['pro', 'submission'],
    fetish: ['singlet', 'boots'],
    role: ['heel'],
    position: ['top', 'dom']
  });

  // Every category is always present, so a client never reads undefined.
  assert.deepEqual(Object.keys(Tags.normalize({}).tags), Tags.categoryKeys);
});

test('duplicates collapse and unknown ids are dropped, not rejected', () => {
  const result = Tags.normalize({
    style: ['pro', 'pro', 'Pro'],
    fetish: ['singlet', 'retired-tag-from-an-old-page'],
    role: [],
    position: []
  });

  assert.equal(result.ok, true, 'a stale tag must never block a save');
  assert.deepEqual(result.tags.style, ['pro']);
  assert.deepEqual(result.tags.fetish, ['singlet']);
});

test('each category is capped at its own limit', () => {
  const style = Tags.CATEGORIES.find(category => category.key === 'style');
  const fetish = Tags.CATEGORIES.find(category => category.key === 'fetish');

  const full = Tags.normalize({
    style: style.tags.map(tag => tag.id),
    fetish: fetish.tags.map(tag => tag.id)
  });

  assert.equal(full.ok, true);
  assert.equal(full.tags.style.length, style.max);
  assert.equal(full.tags.fetish.length, fetish.max);
  assert.deepEqual(full.tags.style, style.tags.slice(0, style.max).map(tag => tag.id));
});

test('a flat list of ids is filed into the right categories', () => {
  const result = Tags.normalize(['heel', 'singlet', 'vers-top', 'pro']);

  assert.equal(result.ok, true);
  assert.deepEqual(result.tags, {
    style: ['pro'],
    fetish: ['singlet'],
    role: ['heel'],
    position: ['vers-top']
  });
});

test('a tag sent in the wrong category lands in the one it belongs to', () => {
  const result = Tags.normalize({ style: ['heel'], role: [], fetish: [], position: [] });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tags.style, []);
  assert.deepEqual(result.tags.role, ['heel']);
});

test('a shape that is not a selection is rejected with invalid_tags', () => {
  [
    { wrestling: ['pro'] },          // unknown category
    { style: 5 },                    // not a list
    { style: [42] },                 // not even strings
    { style: { id: 'pro' } },        // an object where a list belongs
    'pro'                            // not a selection at all
  ].forEach(input => {
    const result = Tags.normalize(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} is rejected`);
    assert.equal(result.error, 'invalid_tags');
  });

  // Not sending tags at all is not an error — it clears them.
  assert.deepEqual(Tags.normalize(undefined), { ok: true, tags: Tags.emptySelection() });
  assert.deepEqual(Tags.normalize(null).tags, Tags.emptySelection());
});

/* ------------------------------------------------------------
   READING WHAT IS STORED
------------------------------------------------------------ */

test('a record with no tags reads as an empty selection', () => {
  assert.deepEqual(Tags.selection(undefined), Tags.emptySelection());
  assert.deepEqual(Tags.selection({}), Tags.emptySelection());
  assert.deepEqual(Tags.selection('nonsense'), Tags.emptySelection());
});

test('stored values are re-ordered and re-capped on the way out', () => {
  const style = Tags.CATEGORIES.find(category => category.key === 'style');

  const cleaned = Tags.selection({
    style: ['submission', 'pro', ...style.tags.map(tag => tag.id)],
    fetish: ['ghost-tag'],
    role: ['heel'],
    position: []
  });

  assert.deepEqual(cleaned.style, style.tags.slice(0, style.max).map(tag => tag.id));
  assert.deepEqual(cleaned.fetish, [], 'an id that is no longer in the catalogue is dropped');
  assert.deepEqual(cleaned.role, ['heel']);
});

test('entries and labels follow catalogue order, not the stored order', () => {
  const selection = { style: [], fetish: ['boots', 'singlet'], role: [], position: [] };

  assert.deepEqual(Tags.entries(selection).map(tag => tag.id), ['singlet', 'boots']);
  assert.deepEqual(Tags.labels(selection), ['Singlet', 'Boots']);
  assert.equal(Tags.count(selection), 2);
  assert.equal(Tags.has(selection, 'boots'), true);
  assert.equal(Tags.has(selection, 'mask'), false);
});

/* ------------------------------------------------------------
   SEARCH — the roster's half of the feature
------------------------------------------------------------ */

test('a search matches ids, labels and aliases', () => {
  const vers = { style: [], fetish: [], role: [], position: ['vers-top'] };
  assert.equal(Tags.matches(vers, 'vers'), true, 'an alias prefix');
  assert.equal(Tags.matches(vers, 'vers top'), true, 'an alias');
  assert.equal(Tags.matches(vers, 'top'), true, 'the label');
  assert.equal(Tags.matches(vers, 'bottom'), false);

  const heelJobber = { style: [], fetish: [], role: ['heel-jobber'], position: [] };
  assert.equal(Tags.matches(heelJobber, 'heel'), true, 'one tag can match two searches');
  assert.equal(Tags.matches(heelJobber, 'jobber'), true);

  const face = { style: [], fetish: [], role: ['face'], position: [] };
  assert.equal(Tags.matches(face, 'babyface'), true, 'an alias only');

  assert.equal(Tags.matches({}, 'heel'), false);
  assert.equal(Tags.matches(vers, ''), true, 'an empty search matches everyone');
});

test('a search reports every tag it stands for', () => {
  assert.deepEqual(Tags.matchingTagIds('vers'), ['versatile', 'vers-top', 'vers-bottom']);
  assert.deepEqual(Tags.matchingTagIds('jobber'), ['jobber', 'heel-jobber']);
  assert.deepEqual(Tags.matchingTagIds('SINGLET'), ['singlet'], 'search is case-insensitive');
  assert.deepEqual(Tags.matchingTagIds('zzz'), []);
  assert.deepEqual(Tags.matchingTagIds(''), []);
});

test('the Mongo fragments match any or all of the wanted tags', () => {
  assert.deepEqual(Tags.mongoFilter(['heel', 'top'], 'any'), {
    $or: [{ 'tags.role': 'heel' }, { 'tags.position': 'top' }]
  });

  assert.deepEqual(Tags.mongoFilter(['heel', 'top'], 'all'), {
    $and: [{ 'tags.role': 'heel' }, { 'tags.position': 'top' }]
  });

  // Nothing to filter on — safe to Object.assign into any query.
  assert.deepEqual(Tags.mongoFilter([], 'any'), {});
  assert.deepEqual(Tags.mongoFilter(['not-a-tag'], 'any'), {});
  assert.deepEqual(Tags.mongoFilter(undefined, 'any'), {});
});

test('a query-string tag list is split, trimmed and lower-cased', () => {
  assert.deepEqual(Tags.parseTagList('heel, Vers-Top ,singlet'), ['heel', 'vers-top', 'singlet']);
  assert.deepEqual(Tags.parseTagList(''), []);
  assert.deepEqual(Tags.parseTagList(undefined), []);
});

/* ------------------------------------------------------------
   WHAT THE PICKER RENDERS FROM
------------------------------------------------------------ */

test('the catalogue handed to the browser cannot mutate the module', () => {
  const copy = Tags.catalogue();
  copy[0].tags.length = 0;
  copy[0].label = 'Hacked';

  assert.notEqual(Tags.CATEGORIES[0].tags.length, 0);
  assert.notEqual(Tags.CATEGORIES[0].label, 'Hacked');
  assert.equal(Tags.catalogue().length, Tags.categoryKeys.length);
});

test('allTagIds stay stable — they are what is stored on a member', () => {
  // A canary for accidental renames: ids are the stored value, labels are not.
  assert.ok(ALL_IDS.includes('greco-roman'));
  assert.ok(ALL_IDS.includes('size-difference'));
  assert.ok(ALL_IDS.includes('heel-jobber'));
  assert.ok(ALL_IDS.includes('power-bottom'));
  assert.equal(new Set(ALL_IDS).size, ALL_IDS.length);
});
