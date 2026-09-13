/**
 * The shared story UI (public/js/story-ui.js), loaded into jsdom and driven
 * through the real DOM the way the desktop and mobile pages do.
 *
 * The behaviour under test is the part members actually feel: previewing a
 * draft, not losing one, editing an approved story (which sends it back for
 * approval), refusing one with a reason, and reading a long story in a viewer
 * that scrolls instead of cutting it off.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'story-ui.js'), 'utf8');

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

/** Load story-ui.js into a page with the handful of globals it expects. */
function loadPage({ username = 'alice', html = '' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${html}<div id="storyPopup" class="modal" style="display:none"></div></body></html>`,
    { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'dangerously' }
  );

  const win = dom.window;
  win.getSession = () => ({ username });
  win.calls = [];
  win.responder = () => ({ ok: true });

  win.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    win.calls.push({ url, method: options.method || 'GET', body });
    const payload = win.responder(url, body) || { ok: true };
    return { json: async () => payload, ok: true };
  };

  win.eval(SOURCE);
  return { win, doc: win.document, StoryUI: win.StoryUI };
}

const find = (root, selector) => root.querySelector(`[data-mcf="${selector}"]`);

/** Tick a message row the way a member clicking it would. */
const tickRow = (win, row, checked = true) => {
  const box = row.querySelector('input');
  box.checked = checked;
  box.dispatchEvent(new win.Event('change'));
};

/* ============================================================
   STORY TEXT
============================================================ */

test('the script title font is served locally, because the CSP blocks remote fonts', () => {
  const { win, doc, StoryUI } = loadPage();
  StoryUI.openViewer({ title: 'Rooftop', story: 'x' });

  const css = doc.getElementById('mcfStoryStyles').textContent;
  assert.match(css, /@font-face\{[\s\S]*font-family:"Great Vibes"/);
  assert.match(css, /src:url\("\/fonts\/great-vibes\.woff2"\)/);
  assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.equal(win.document.querySelector('link[href*="googleapis"]'), null, 'no remote stylesheet is requested');
});

test('story text is escaped, so a story cannot inject markup', () => {
  const { StoryUI } = loadPage();
  const html = StoryUI.renderStoryBody('<img src=x onerror="alert(1)"> and <script>bad()</script>');

  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;img src=x/);
});

test('the light story markup renders as emphasis, quotes, headings and scene breaks', () => {
  const { StoryUI } = loadPage();
  const html = StoryUI.renderStoryBody([
    '## Round One',
    'He **won** the *first* exchange.',
    '> "Not this time."',
    '---',
    '- a list item'
  ].join('\n'));

  assert.match(html, /<h3 class="mcf-story-heading">Round One<\/h3>/);
  assert.match(html, /<strong>won<\/strong>/);
  assert.match(html, /<em>first<\/em>/);
  assert.match(html, /<blockquote class="mcf-story-quote">/);
  assert.match(html, /<hr class="mcf-story-break">/);
  assert.match(html, /<li>a list item<\/li>/);
});

test('a story exports as clean text with its byline', () => {
  const { StoryUI } = loadPage();
  const text = StoryUI.storyAsPlainText({
    title: 'Rooftop', owner: 'alice', partner: 'bob', story: 'We met up there.', createdAt: '2026-01-02'
  });

  assert.match(text, /^Rooftop\nby @alice with @bob/);
  assert.match(text, /We met up there\./);
});

/* ============================================================
   TRANSCRIPT BUILDER
============================================================ */

const messages = [
  { from: 'alice', to: 'bob', text: 'Ready?', time: '2026-01-02T20:00:00Z' },
  { from: 'bob', to: 'alice', text: 'Always.', time: '2026-01-02T20:01:00Z' },
  { from: 'alice', to: 'bob', clipUrl: '/clips/abc.mp4', time: '2026-01-02T20:02:00Z' }
];

test('the script style turns messages into dialogue lines', () => {
  const { StoryUI } = loadPage();
  const text = StoryUI.formatTranscript(messages, { style: 'script', sceneBreaks: false });

  assert.equal(text, ['**alice:** Ready?', '**bob:** Always.', '**alice:** (clip)'].join('\n'));
  assert.doesNotMatch(text, /2026/, 'no timestamps unless they are asked for');
});

test('the log style keeps times, and timestamps can be added to the script style', () => {
  const { StoryUI } = loadPage();

  const log = StoryUI.formatTranscript(messages, { style: 'log' });
  assert.match(log.split('\n')[0], /^\[.*\] alice: Ready\?$/);

  const script = StoryUI.formatTranscript(messages, { style: 'script', timestamps: true, sceneBreaks: false });
  assert.match(script.split('\n')[0], /^> \d{1,2}:\d{2} (AM|PM|am|pm)? ?— \*\*alice:\*\* Ready\?$/);
});

test('character names replace usernames, and scenes break when the speaker changes', () => {
  const { StoryUI } = loadPage();
  const text = StoryUI.formatTranscript(messages, {
    style: 'script',
    sceneBreaks: true,
    aliases: { alice: 'Raven', bob: 'Kade' }
  });

  assert.deepEqual(text.split('\n'), [
    '**Raven:** Ready?',
    '',
    '**Kade:** Always.',
    '',
    '**Raven:** (clip)'
  ]);
});

test('empty messages are skipped rather than becoming blank lines', () => {
  const { StoryUI } = loadPage();
  const text = StoryUI.formatTranscript([
    { from: 'alice', text: '   ' },
    { from: 'bob', text: 'hi' }
  ], { style: 'script', sceneBreaks: false });

  assert.equal(text, '**bob:** hi');
});

/* ============================================================
   EDITOR — drafts, preview, saving
============================================================ */

test('the editor opens blank for a new story and saves it against the partner', async () => {
  const { win, doc, StoryUI } = loadPage();
  win.responder = (url) => (url === '/api/story/save' ? { ok: true, storyId: 's1' } : { ok: true });

  StoryUI.openEditor({ partner: 'bob' });

  find(doc, 'title').value = 'Rooftop';
  find(doc, 'body').value = 'We met on the roof.';
  find(doc, 'save').click();
  await tick();

  const call = win.calls.find(c => c.url === '/api/story/save');
  assert.ok(call, 'the story is posted');
  assert.deepEqual(call.body, {
    username: 'alice',
    title: 'Rooftop',
    story: 'We met on the roof.',
    clipUrl: null,
    clipType: null,
    owner: 'alice',
    partner: 'bob'
  });
});

test('messages are loaded, picked and written into the story', async () => {
  const { win, doc, StoryUI } = loadPage();
  win.responder = url => (url === '/api/story/load'
    ? {
        ok: true,
        messages: [
          { from: 'bob', to: 'alice', text: 'You still up for Saturday?', time: '2026-08-23T22:10:00Z' },
          { from: 'alice', to: 'bob', text: 'Depends. Indoor or the usual car park?', time: '2026-08-23T22:12:00Z' },
          { from: 'bob', to: 'alice', text: 'The roof on Campbell.', time: '2026-08-23T22:13:00Z' }
        ]
      }
    : { ok: true });

  StoryUI.openEditor({ partner: 'bob' });

  // The picker starts closed.
  assert.equal(find(doc, 'picker').style.display, 'none');
  find(doc, 'toggle-picker').click();
  assert.equal(find(doc, 'picker').style.display, 'block');

  // Loading asks for the window the member chose, for their own conversation.
  find(doc, 'picker').querySelector('input[type="date"]').value = '2026-08-01';
  find(doc, 'load-messages').click();
  await tick();

  const call = win.calls.at(-1);
  assert.equal(call.url, '/api/story/load');
  assert.deepEqual(call.body, {
    a: 'alice', b: 'bob', requester: 'alice', fromDate: '2026-08-01'
  });
  assert.equal('toDate' in call.body, false, 'an open-ended window sends no end date');

  const rows = find(doc, 'messages').querySelectorAll('[data-mcf="message"]');
  assert.equal(rows.length, 3, 'every message is pickable');

  // Tick two of them and add them as dialogue.
  tickRow(win, rows[0]);
  tickRow(win, rows[1]);
  find(doc, 'insert').click();

  // A blank line separates a change of speaker by default...
  assert.equal(find(doc, 'body').value,
    '**bob:** You still up for Saturday?\n\n**alice:** Depends. Indoor or the usual car park?');

  // ...and turning that off gives a compact exchange.
  find(doc, 'body').value = '';
  find(doc, 'scene-breaks').checked = false;
  find(doc, 'replace').click();
  assert.equal(find(doc, 'body').value,
    '**bob:** You still up for Saturday?\n**alice:** Depends. Indoor or the usual car park?');

  // Adding again does not wipe what is already written.
  tickRow(win, rows[2]);
  find(doc, 'insert').click();
  assert.match(find(doc, 'body').value, /You still up for Saturday\?[\s\S]*\*\*bob:\*\* The roof on Campbell\./);
  assert.match(find(doc, 'body').value, /roof on Campbell/, 'the new line was appended, not swapped in');

  // Replacing a draft that already has text asks first, then carries on.
  let asked = false;
  win.confirm = () => { asked = true; return true; };

  // Timestamps can be switched on for a story that reads as a log.
  find(doc, 'timestamps').checked = true;
  find(doc, 'replace').click();
  assert.equal(asked, true, 'replacing written text is confirmed');
  assert.match(find(doc, 'body').value, /^> \d{1,2}:\d{2}/, 'each line carries its time');
});

test('the picker can filter by speaker and text, and replace the draft on request', async () => {
  const { win, doc, StoryUI } = loadPage();
  win.responder = () => ({
    ok: true,
    messages: [
      { from: 'bob', to: 'alice', text: 'roof on Campbell', time: '2026-08-23T22:13:00Z' },
      { from: 'alice', to: 'bob', text: 'it rained all week', time: '2026-08-23T22:15:00Z' }
    ]
  });

  StoryUI.openEditor({ partner: 'bob' });
  find(doc, 'toggle-picker').click();
  find(doc, 'picker').querySelector('input[type="date"]').value = '2026-08-01';
  find(doc, 'load-messages').click();
  await tick();

  const list = find(doc, 'messages');
  const speaker = find(doc, 'picker').querySelector('select');

  speaker.value = 'them';
  speaker.dispatchEvent(new win.Event('change'));
  assert.equal(list.querySelectorAll('[data-mcf="message"]').length, 1, 'only @bob\'s lines');

  // Ticking a line and then searching must not lose the tick.
  tickRow(win, list.querySelectorAll('[data-mcf="message"]')[0]);
  const search = find(doc, 'picker').querySelector('input[type="search"]');
  search.value = 'campbell';
  search.dispatchEvent(new win.Event('input'));
  assert.equal(list.querySelectorAll('[data-mcf="message"]').length, 1, 'only matching lines');
  search.value = '';
  search.dispatchEvent(new win.Event('input'));
  assert.equal(list.querySelectorAll('input')[0].checked, true, 'the tick survived the filter');

  speaker.value = 'all';
  speaker.dispatchEvent(new win.Event('change'));
  find(doc, 'select-all').click();
  assert.equal([...list.querySelectorAll('input')].every(box => box.checked), true, 'Select all ticks every line');
  find(doc, 'body').value = 'Something I already wrote.';
  win.confirm = () => true;
  find(doc, 'insert').click();

  find(doc, 'replace').click();
  assert.doesNotMatch(find(doc, 'body').value, /Something I already wrote/);
  assert.match(find(doc, 'body').value, /roof on Campbell/);
});

test('an empty story is refused before it reaches the server', async () => {
  const { win, doc, StoryUI } = loadPage();
  StoryUI.openEditor({ partner: 'bob' });

  find(doc, 'title').value = 'Rooftop';
  find(doc, 'save').click();
  await tick();

  assert.equal(win.calls.filter(c => c.url.startsWith('/api/story/')).length, 0);
  assert.match(doc.getElementById('mcfStoryToast').textContent, /still empty/i);
});

test('the character counter warns once the story is over the limit', () => {
  const { doc, StoryUI } = loadPage();
  StoryUI.openEditor({ partner: 'bob' });

  const body = find(doc, 'body');
  body.value = 'x'.repeat(StoryUI.LIMITS.body + 1);
  body.dispatchEvent(new doc.defaultView.Event('input'));

  assert.ok(find(doc, 'counter').querySelector('.mcf-story-warn'), 'the count is flagged');
  assert.match(find(doc, 'counter').textContent, /20,001 \/ 20,000 characters/);

  // ...and the save is refused while it is over the limit.
  find(doc, 'title').value = 'Too long';
  find(doc, 'save').click();
  assert.match(doc.getElementById('mcfStoryToast').textContent, /limited to/);
});

test('Preview shows the draft in the shared viewer without saving it', async () => {
  const { win, doc, StoryUI } = loadPage();
  StoryUI.openEditor({ partner: 'bob' });

  find(doc, 'title').value = 'Rooftop';
  find(doc, 'body').value = 'He **won**.';
  find(doc, 'preview').click();
  await tick();

  const viewer = doc.getElementById('storyViewerPopup');
  assert.ok(viewer, 'the viewer opens');
  assert.match(viewer.textContent, /Rooftop/);
  assert.match(viewer.innerHTML, /<strong>won<\/strong>/);
  assert.equal(win.calls.filter(c => c.url.includes('/api/story/save')).length, 0, 'nothing was saved');
});

test('an unsaved story survives closing the editor, and is offered back', async () => {
  const { win, doc, StoryUI } = loadPage();

  StoryUI.openEditor({ partner: 'bob' });
  find(doc, 'title').value = 'Rooftop';
  const body = find(doc, 'body');
  body.value = 'Half a story.';
  body.dispatchEvent(new win.Event('input'));
  await tick(1400); // the draft autosave is debounced

  // Close it (confirming the unsaved-changes prompt) and open it again.
  win.confirm = () => true;
  find(doc, 'close').click();

  StoryUI.openEditor({ partner: 'bob' });

  const banner = find(doc, 'draft-banner');
  assert.notEqual(banner.style.display, 'none', 'the draft is announced');
  assert.match(banner.textContent, /Unsaved draft/);

  find(doc, 'restore-draft').click();
  assert.equal(find(doc, 'title').value, 'Rooftop');
  assert.equal(find(doc, 'body').value, 'Half a story.');
});

test('a discarded draft is thrown away for good', async () => {
  const { win, doc, StoryUI } = loadPage();

  StoryUI.openEditor({ partner: 'bob' });
  const body = find(doc, 'body');
  body.value = 'Half a story.';
  body.dispatchEvent(new win.Event('input'));
  await tick(1400);

  win.confirm = () => true;
  find(doc, 'close').click();

  StoryUI.openEditor({ partner: 'bob' });
  find(doc, 'discard-draft').click();
  win.confirm = () => true;
  find(doc, 'close').click();

  StoryUI.openEditor({ partner: 'bob' });
  assert.equal(find(doc, 'draft-banner').style.display, 'none', 'the discarded draft is gone');
  assert.equal(find(doc, 'body').value, '');
});

test('closing with unsaved work asks first, and can be cancelled', async () => {
  const { win, doc, StoryUI } = loadPage();
  StoryUI.openEditor({ partner: 'bob' });

  const body = find(doc, 'body');
  body.value = 'Not finished';
  body.dispatchEvent(new win.Event('input'));

  let asked = false;
  win.confirm = () => { asked = true; return false; };
  find(doc, 'close').click();

  assert.equal(asked, true, 'the member is warned');
  assert.equal(doc.getElementById('storyPopup').innerHTML.length > 0, true, 'the editor stays open');

  win.confirm = () => true;
  find(doc, 'close').click();
  assert.equal(doc.getElementById('storyPopup').innerHTML, '');
});

/* ============================================================
   EDITING AN APPROVED STORY
   ============================================================ */

test('editing an approved story posts an update and explains the re-approval', async () => {
  const { win, doc, StoryUI } = loadPage();
  win.responder = url => (url === '/api/story/update'
    ? { ok: true, revision: 2, wasPublished: true, approved: false }
    : { ok: true });

  StoryUI.openEditor({
    partner: 'bob',
    story: { _id: 's1', owner: 'alice', partner: 'bob', title: 'Rooftop', story: 'Old text', approved: true, revision: 1 }
  });

  assert.equal(find(doc, 'title').value, 'Rooftop');
  assert.equal(find(doc, 'body').value, 'Old text');
  assert.ok(find(doc, 'delete'), 'the author can delete their story');

  find(doc, 'body').value = 'New text';
  find(doc, 'save').click();
  await tick();

  const call = win.calls.find(c => c.url === '/api/story/update');
  assert.ok(call, 'the edit is saved through the update route');
  assert.equal(call.body.storyId, 's1');
  assert.equal(call.body.story, 'New text');
  assert.match(doc.getElementById('mcfStoryToast').textContent, /approve the revision/i);
});

test('deleting asks for confirmation and reports the result', async () => {
  const { win, doc, StoryUI } = loadPage();
  win.responder = url => (url === '/api/story/delete' ? { ok: true } : { ok: true });
  win.confirm = () => true;

  StoryUI.openEditor({ partner: 'bob', story: { _id: 's1', owner: 'alice', partner: 'bob', title: 'T', story: 'x' } });
  find(doc, 'delete').click();
  await tick();

  assert.deepEqual(win.calls.at(-1), { url: '/api/story/delete', method: 'POST', body: { storyId: 's1', username: 'alice' } });
  assert.equal(doc.getElementById('storyPopup').innerHTML, '');
});

test('a story that is not yours cannot be opened for editing', async () => {
  const { win, doc, StoryUI } = loadPage();
  win.responder = () => ({ ok: false, error: 'not_owner' });

  StoryUI.openEditor({ partner: 'bob', story: { _id: 's1', owner: 'someone-else', partner: 'bob', title: 'T', story: 'x' } });
  find(doc, 'save').click();
  await tick();

  assert.match(doc.getElementById('mcfStoryToast').textContent, /Only the author/i);
});

/* ============================================================
   VIEWER
   ============================================================ */

test('the viewer scrolls long stories instead of cutting them off', () => {
  const { doc, StoryUI } = loadPage();
  StoryUI.openViewer({ _id: 's1', owner: 'alice', partner: 'bob', title: 'Long', story: 'line\n'.repeat(400) });

  const bodyEl = find(doc, 'viewer-body');
  assert.ok(bodyEl.classList.contains('mcf-story-scroll'));
  assert.equal(bodyEl.style.overflowY || '', '', 'the panel CSS provides the scrolling');
  assert.match(doc.getElementById('mcfStoryStyles').textContent, /\.mcf-story-scroll\{overflow-y:auto/);
});

test('a story can be linked, and Escape closes the viewer', async () => {
  const { win, doc, StoryUI } = loadPage();
  win.navigator.clipboard = { writeText: async text => { win.copied = text; } };

  StoryUI.openViewer({ _id: '5f1b3c4d5e6f7a8b9c0d1e2f', owner: 'alice', partner: 'bob', title: 'Rooftop', story: 'x' });
  find(doc, 'viewer-share').click();
  await tick();

  assert.equal(win.copied, 'http://localhost/story/5f1b3c4d5e6f7a8b9c0d1e2f');

  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(doc.getElementById('storyViewerPopup'), null, 'Escape closes the viewer');
});

test('the viewer steps through the list it was opened from', () => {
  const { doc, StoryUI } = loadPage();
  const list = [
    { _id: 's1', owner: 'alice', partner: 'bob', title: 'One', story: 'first' },
    { _id: 's2', owner: 'alice', partner: 'bob', title: 'Two', story: 'second' }
  ];

  StoryUI.setReadingList(list);
  StoryUI.openViewer(list[0]);

  assert.equal(find(doc, 'viewer-prev').disabled, true, 'nothing before the first story');
  find(doc, 'viewer-next').click();

  assert.match(doc.getElementById('storyViewerPopup').textContent, /Two/);
});

test('the reader can change the text size, and it is remembered', () => {
  const { win, doc, StoryUI } = loadPage();
  StoryUI.openViewer({ title: 'T', story: 'text' });

  win.localStorage.setItem('mcf.story.fontScale', '1');
  const scroll = find(doc, 'viewer-body').querySelector('.mcf-story-body-block');
  const before = scroll.style.fontSize;
  doc.querySelector('[title="Larger text"]').click();

  assert.notEqual(scroll.style.fontSize, before);
  assert.equal(Number(win.localStorage.getItem('mcf.story.fontScale')) > 1, true);
});

/* ============================================================
   APPROVAL
   ============================================================ */

test('approving attributes the answer to the signed-in member', async () => {
  const { win, StoryUI } = loadPage();
  win.responder = () => ({ ok: true, approved: true });

  const result = await StoryUI.approveStory('s1');
  assert.equal(result, true);
  assert.deepEqual(win.calls.at(-1).body, { storyId: 's1', username: 'alice' });
});

test('declining can carry a reason, and reports a retraction', async () => {
  const { win, StoryUI } = loadPage();
  win.responder = () => ({ ok: true, retracted: true });

  await StoryUI.declineStory('s1', 'bob', 'not accurate');
  assert.deepEqual(win.calls.at(-1).body, { storyId: 's1', username: 'bob', reason: 'not accurate' });
  assert.match(win.document.getElementById('mcfStoryToast').textContent, /private again/i);
});

test('a refusal from the approval popup tells the author why', async () => {
  const { win, doc, StoryUI } = loadPage();
  win.responder = url => (url === '/api/story/decline' ? { ok: true } : { ok: true });
  win.prompt = () => 'that never happened';

  const popup = StoryUI.showApprovalPopup({ storyId: 's1', from: 'alice', title: 'Rooftop', revised: true });
  assert.match(popup.textContent, /revised a story/);
  assert.match(popup.textContent, /Rooftop/);

  find(popup, 'popup-decline').click();
  await tick();

  assert.equal(win.calls.at(-1).body.reason, 'that never happened');
  assert.equal(popup.isConnected, false, 'the popup closes once answered');
});

test('the approval popup behaves the same for a brand new story', async () => {
  const { doc, StoryUI } = loadPage();
  const popup = StoryUI.showApprovalPopup({ storyId: 's1', from: 'alice', title: 'Rooftop' });
  assert.match(popup.textContent, /wrote a story/);
  assert.match(popup.textContent, /stays private until you approve/i);
});

/* ============================================================
   LISTS
============================================================ */

test('your own stories offer edit, delete and share; other people’s are read-only', () => {
  const { win, doc, StoryUI } = loadPage();
  const box = doc.createElement('div');
  doc.body.appendChild(box);

  StoryUI.renderStoryList(box, [
    { _id: 's1', owner: 'alice', partner: 'bob', title: 'Mine', story: 'x', approved: true },
    { _id: 's2', owner: 'bob', partner: 'carol', title: 'Theirs', story: 'y', approved: true }
  ], { username: 'alice' });

  const rows = box.querySelectorAll('[data-mcf="story-row"]');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes('Edit'));
  assert.ok(rows[0].textContent.includes('Delete'));
  assert.equal(rows[1].textContent.includes('Edit'), false, 'only the author may edit');
});

test('a refused story stays visible to its author with the reason and a way back', () => {
  const { doc, StoryUI } = loadPage();
  const box = doc.createElement('div');
  doc.body.appendChild(box);

  StoryUI.renderPendingList(box, {
    username: 'alice',
    stories: [],
    declined: [{
      _id: 's1', owner: 'alice', partner: 'bob', title: 'Rooftop', story: 'x',
      declined: true, declinedBy: 'bob', declineReason: 'that never happened'
    }]
  });

  assert.match(box.textContent, /declined by @bob/);
  assert.match(box.textContent, /“that never happened”/);
  assert.match(box.textContent, /Revise & resubmit/);
});

test('the partner sees approve and decline; the author sees resend and withdraw', () => {
  const { doc, StoryUI } = loadPage();
  const story = { _id: 's1', owner: 'alice', partner: 'bob', title: 'Rooftop', story: 'x', approved: false };

  const partnerBox = doc.createElement('div');
  doc.body.appendChild(partnerBox);
  StoryUI.renderPendingList(partnerBox, { username: 'bob', stories: [story], declined: [] });
  assert.ok(find(partnerBox, 'approve'));
  assert.ok(find(partnerBox, 'decline'));

  const authorBox = doc.createElement('div');
  doc.body.appendChild(authorBox);
  StoryUI.renderPendingList(authorBox, { username: 'alice', stories: [story], declined: [] });
  assert.match(authorBox.textContent, /waiting for @bob/);
  assert.match(authorBox.textContent, /Resend request/);
  assert.match(authorBox.textContent, /Withdraw/);
});

/* ============================================================
   ARCHIVES + PERMALINKS
============================================================ */

test('the archives search and page on the server, not the whole table at once', async () => {
  const { win, doc, StoryUI } = loadPage();
  win.responder = () => ({ ok: true, stories: [], total: 0, page: 1, perPage: 12, totalPages: 1 });

  doc.body.insertAdjacentHTML('beforeend', `
    <input id="archivesSearch"><div id="archivesList"></div>
    <span id="archivesPageNumber"></span>
    <button id="archivesPrev"></button><button id="archivesNext"></button>
  `);

  await StoryUI.openArchives({ username: 'alice' });

  const first = win.calls.at(-1);
  assert.match(first.url, /\/api\/story\/archives\?page=1&perPage=12&sort=recent$/);

  const search = doc.getElementById('archivesSearch');
  search.value = 'rooftop';
  search.dispatchEvent(new win.Event('input'));
  await tick(400);

  assert.match(win.calls.at(-1).url, /q=rooftop/);
});

test('a story link is recognised from its path or its hash', () => {
  const { win, StoryUI } = loadPage();
  const id = '5f1b3c4d5e6f7a8b9c0d1e2f';

  win.history.replaceState({}, '', `/story/${id}`);
  assert.equal(StoryUI.storyIdFromLocation(), id);

  win.history.replaceState({}, '', `/#story=${id}`);
  assert.equal(StoryUI.storyIdFromLocation(), id);

  win.history.replaceState({}, '', '/');
  assert.equal(StoryUI.storyIdFromLocation(), null);
});

test('a permalink opens the story, and a private one says so instead of failing', async () => {
  const { win, StoryUI } = loadPage();
  const id = '5f1b3c4d5e6f7a8b9c0d1e2f';
  win.history.replaceState({}, '', `/story/${id}`);
  win.responder = url => (url.startsWith(`/api/story/${id}`)
    ? { ok: true, story: { _id: id, owner: 'alice', partner: 'bob', title: 'Rooftop', story: 'x', approved: true } }
    : { ok: true, stories: [] });

  assert.equal(await StoryUI.openFromUrl(), true);
  assert.match(win.document.getElementById('storyViewerPopup').textContent, /Rooftop/);

  win.responder = url => (url.startsWith(`/api/story/${id}`) ? { ok: false, error: 'private' } : { ok: true, stories: [] });
  assert.equal(await StoryUI.openFromUrl(), false);
  assert.match(win.document.getElementById('mcfStoryToast').textContent, /not available/i);
});
