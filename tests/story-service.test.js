/**
 * The story authoring rules (storyService.js).
 *
 * These are the decisions that used to be scattered through the route bodies
 * in index.js — who may approve, what an edit does, when a story stops being
 * public. They are pure functions, so they can be checked without a database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STORY_LIMITS,
  isParticipant,
  isPublished,
  validateNewStory,
  validateEdit,
  editFields,
  approveFields,
  declineFields,
  canEdit,
  canView,
  archivesQuery,
  paginate,
  approvalDmText,
  statusDmText
} = require('../storyService');

const story = (over = {}) => ({
  owner: 'alice',
  partner: 'bob',
  title: 'The Rooftop Match',
  story: 'We met on the roof.',
  approvalOwner: true,
  approvalPartner: false,
  approved: false,
  declined: false,
  revision: 0,
  ...over
});

const published = (over = {}) => story({ approvalPartner: true, approved: true, approvedAt: new Date('2026-01-01'), ...over });

/* ---------- validation ---------- */

test('a new story needs two different members and some text', () => {
  assert.equal(validateNewStory({ owner: 'alice', partner: 'bob', title: 'T', story: 'once' }).ok, true);

  assert.equal(validateNewStory({ owner: '', partner: 'bob', title: 'T', story: 'x' }).error, 'missing_participant');
  assert.equal(validateNewStory({ owner: 'alice', partner: 'alice', title: 'T', story: 'x' }).error, 'same_participant');
  assert.equal(validateNewStory({ owner: 'alice', partner: 'bob', title: 'T', story: '   ' }).error, 'empty_story');
});

test('titles and bodies are capped, and text is trimmed and normalised', () => {
  const long = 'x'.repeat(STORY_LIMITS.body + 1);
  assert.equal(validateNewStory({ owner: 'alice', partner: 'bob', title: 'T', story: long }).error, 'story_too_long');

  const title = 'y'.repeat(STORY_LIMITS.title + 1);
  assert.equal(validateNewStory({ owner: 'alice', partner: 'bob', title, story: 'x' }).error, 'title_too_long');

  const result = validateNewStory({
    owner: ' alice ', partner: 'bob', title: '  A title  ', story: ' line one\r\nline two '
  });
  assert.deepEqual(result.value, {
    owner: 'alice', partner: 'bob', title: 'A title', story: 'line one\nline two'
  });
});

test('an edit carries the same limits as a new story', () => {
  assert.equal(validateEdit({ title: 'T', story: 'text' }).ok, true);
  assert.equal(validateEdit({ title: 'T', story: '' }).error, 'empty_story');
  assert.equal(validateEdit({ title: 'T', story: 'x'.repeat(STORY_LIMITS.body + 1) }).error, 'story_too_long');
});

/* ---------- approval ---------- */

test('only the two people in a story can approve it, and each clears their own flag', () => {
  const s = story();

  assert.equal(approveFields(s, 'mallory').error, 'not_participant');
  assert.equal(approveFields(s, undefined).error, 'not_participant');

  const author = approveFields(s, 'alice');
  assert.equal(author.ok, true);
  assert.equal(author.already, true, 'the author approves by writing it');
  assert.deepEqual(author.fields, {});

  const partner = approveFields(s, 'bob');
  assert.equal(partner.approved, true);
  assert.equal(partner.fields.approvalPartner, true);
  assert.equal(partner.fields.approved, true);
  assert.ok(partner.fields.approvedAt instanceof Date, 'publication is stamped');

  // ...but a stranger cannot publish it on the partner's behalf.
  assert.equal(approveFields(s, 'mallory').ok, false);
});

test('approving twice does not re-stamp the publication date', () => {
  const s = published();
  const again = approveFields(s, 'bob');
  assert.equal(again.already, true);
  assert.deepEqual(again.fields, {});
});

test('a declined story cannot be approved until it is revised', () => {
  const s = story({ declined: true, declinedBy: 'bob' });
  assert.equal(approveFields(s, 'bob').error, 'declined');
});

/* ---------- editing re-opens approval ---------- */

test('editing an approved story sends it back for approval', () => {
  const s = published({ revision: 1 });
  const fields = editFields(s, { title: 'Fixed title', story: 'Fixed text', clipUrl: null, clipType: null });

  assert.equal(fields.approved, false);
  assert.equal(fields.approvalPartner, false, 'the partner has to approve the change');
  assert.equal(fields.approvalOwner, true);
  assert.equal(fields.revision, 2, 'revisions are counted so the partner can see it changed');
  assert.equal(fields.declined, false);
  assert.ok(fields.updatedAt instanceof Date);
  assert.equal(fields.clipUrl, null);
  assert.equal(fields.clipType, null);
});

test('a clip keeps its type, and only GIFs are treated as GIFs', () => {
  assert.equal(editFields(story(), { title: 'T', story: 'x', clipUrl: '/clips/aaaa.mp4', clipType: 'video' }).clipType, 'video');
  assert.equal(editFields(story(), { title: 'T', story: 'x', clipUrl: '/clips/aaaa.gif', clipType: 'gif' }).clipType, 'gif');
  assert.equal(editFields(story(), { title: 'T', story: 'x', clipUrl: '/clips/aaaa.mp4', clipType: 'nonsense' }).clipType, 'video');
});

/* ---------- declining / retracting ---------- */

test('declining records who said no and why, and unpublishes the story', () => {
  const result = declineFields(published(), 'bob', 'this is not what happened');
  assert.equal(result.ok, true);
  assert.equal(result.wasPublished, true, 'the caller is told the story was live');
  assert.equal(result.fields.declined, true);
  assert.equal(result.fields.declinedBy, 'bob');
  assert.equal(result.fields.declineReason, 'this is not what happened');
  assert.equal(result.fields.approved, false);
});

test('declining is limited to the participants, and the reason is capped', () => {
  assert.equal(declineFields(story(), 'mallory', '').error, 'not_participant');
  assert.equal(declineFields(story(), 'bob', 'x'.repeat(STORY_LIMITS.declineReason + 1)).error, 'reason_too_long');
  assert.equal(declineFields(story(), 'bob', '').ok, true, 'a reason is optional');
});

/* ---------- visibility ---------- */

test('a story is public only when it is approved and not declined', () => {
  assert.equal(isPublished(published()), true);
  assert.equal(isPublished(published({ declined: true })), false);
  assert.equal(isPublished(story()), false);
});

test('an unpublished story is visible only to the two people in it', () => {
  const draft = story();
  assert.equal(canView(draft, 'alice'), true);
  assert.equal(canView(draft, 'bob'), true);
  assert.equal(canView(draft, 'mallory'), false);
  assert.equal(canView(draft, undefined), false);

  assert.equal(canView(published(), 'mallory'), true, 'published stories are readable by anyone');

  const refused = story({ declined: true });
  assert.equal(canView(refused, 'mallory'), false, 'a refusal is not a public story');
  assert.equal(canView(null, 'alice'), false);
});

test('only the author may edit or delete', () => {
  const s = story();
  assert.equal(canEdit(s, 'alice'), true);
  assert.equal(canEdit(s, 'bob'), false);
  assert.equal(canEdit(s, 'mallory'), false);
  assert.equal(isParticipant(s, 'bob'), true);
});

/* ---------- archives ---------- */

test('the archives query searches titles, text and both usernames', () => {
  const query = archivesQuery({ q: 'rooftop', escapeRegex: v => v });
  assert.equal(query.approved, true);
  assert.equal(query.declined.$ne, true);
  assert.ok(Array.isArray(query.$or), 'a search term looks in more than one field');
  assert.deepEqual(query.$or.map(clause => Object.keys(clause)[0]), ['title', 'story', 'owner', 'partner']);
});

test('a search term is escaped, so regex characters cannot break the query', () => {
  const escaped = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const query = archivesQuery({ q: 'a+b(c)', escapeRegex: escaped });
  assert.equal(query.$or[0].title.source, 'a\\+b\\(c\\)');
});

test('the archives can be narrowed to one member, and an empty search matches everything', () => {
  const mine = archivesQuery({ participant: 'alice' });
  assert.equal(mine.$or, undefined);
  assert.deepEqual(mine.$and, [{ $or: [{ owner: 'alice' }, { partner: 'alice' }] }]);

  const all = archivesQuery({});
  assert.equal(all.$or, undefined);
  assert.equal(all.$and, undefined);
});

test('paging is clamped, so a caller cannot ask for the whole database at once', () => {
  const items = Array.from({ length: 30 }, (_, i) => i);

  const first = paginate(items, { page: 1, perPage: 12 });
  assert.deepEqual(first.items, items.slice(0, 12));
  assert.equal(first.total, 30);
  assert.equal(first.totalPages, 3);

  const last = paginate(items, { page: 3 });
  assert.equal(last.items.length, 6);

  assert.equal(paginate(items, { page: 99, perPage: 5 }).page, 6, 'past the end lands on the last page');
  assert.equal(paginate(items, { page: 0 }).page, 1);
  assert.equal(paginate(items, { perPage: 1000 }).perPage, 50);
  assert.equal(paginate(items, { perPage: -5 }).perPage, 12);
  assert.deepEqual(paginate(null, {}).items, []);
});

/* ---------- notification copy ---------- */

test('approval copy distinguishes a new story from a revision', () => {
  const s = story({ title: 'The Rooftop Match' });
  assert.match(approvalDmText(s), /alice created a story/);
  assert.match(approvalDmText(s), /Please approve it\./);
  assert.match(approvalDmText(s, { revised: true }), /revised the story/);
  assert.match(approvalDmText({ ...s, title: '' }), /Untitled story/);
});

test('status copy explains what happened to the story', () => {
  assert.match(statusDmText(story(), 'published'), /approved and published/);
  assert.match(statusDmText(story(), 'deleted'), /deleted the story/);

  const declined = story({ declinedBy: 'bob', declineReason: 'not accurate' });
  const message = statusDmText(declined, 'declined');
  assert.match(message, /bob declined/);
  assert.match(message, /not accurate/);
  assert.doesNotMatch(statusDmText(story(), 'declined'), /Reason:/, 'a refusal with no reason says nothing extra');
});
