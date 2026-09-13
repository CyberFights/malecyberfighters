/**
 * The story endpoints, over real HTTP.
 *
 * index.js supplies Mongoose models and notification helpers; here they are
 * replaced with the in-memory stand-ins in tests/helpers/fakeModels.js, so the
 * routes, the authoring rules and the notification side effects are exercised
 * together without a database. This is the flow a member actually goes
 * through: write → partner approves → published → edit → re-approve → refuse →
 * revise → withdraw.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const mongoose = require('mongoose');

const { createStoryRouter } = require('../storyRoutes');
const { makeModels } = require('./helpers/fakeModels');

/** Boot the router with fake models and return a small request helper. */
async function startApi() {
  const models = makeModels();
  models.User._add({ username: 'alice', display: 'Alice' });
  models.User._add({ username: 'bob', display: 'Bob' });

  const notifications = [];
  const dms = [];

  const app = express();
  app.use(express.json());
  app.use('/api/story', createStoryRouter({
    ...models,
    mongoose,
    writeLimiter: (req, res, next) => next(),
    isLocalClipUrl: value => typeof value === 'string' && /^\/clips\/[a-f0-9]{32}\.(gif|mp4|webm)$/.test(value),
    emitToUser: (username, event, payload) => {
      notifications.push({ username, event, payload });
      return 1;
    },
    forwardDMToDiscord: async (from, user, text) => {
      dms.push({ from, to: user && user.username, text });
    }
  }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, options = {}) => {
    const res = await fetch(base + path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (err) { /* not json */ }
    return { status: res.status, json };
  };

  const save = async (over = {}) => call('/api/story/save', {
    method: 'POST',
    body: { owner: 'alice', partner: 'bob', title: 'Rooftop', story: 'We met on the roof.', ...over }
  });

  const notificationsFor = name => notifications.filter(n => n.username === name);

  return {
    call,
    save,
    models,
    notifications,
    notificationsFor,
    discordDms: dms,
    async close() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

/* ============================================================
   WRITING
============================================================ */

test('a story is saved against both members and the partner is asked to approve it', async () => {
  const api = await startApi();
  try {
    const res = await api.save();
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.storyId);

    const story = api.models.Story._all()[0];
    assert.equal(story.owner, 'alice');
    assert.equal(story.partner, 'bob');
    assert.equal(story.approved, false);
    assert.equal(story.approvalOwner, true, 'the author approves by writing');
    assert.equal(story.revision, 0);

    // The request leaves a DM, so it is still there tomorrow...
    const dm = api.models.DM._all().find(d => d.to === 'bob');
    assert.ok(dm, 'a system DM is left in the conversation');
    assert.equal(dm.type, 'storyApproval');
    assert.equal(String(dm.storyId), String(res.json.storyId));
    assert.match(dm.text, /alice created a story/);

    // ...and pops on every live session.
    const live = api.notificationsFor('bob');
    assert.equal(live.length, 1);
    assert.equal(live[0].event, 'storyApprovalRequest');
    assert.equal(live[0].payload.revised, false);
  } finally {
    await api.close();
  }
});

test('a story aimed at somebody who does not exist is refused', async () => {
  const api = await startApi();
  try {
    assert.equal((await api.save({ partner: 'nobody' })).json.error, 'partner_not_found');
    assert.equal((await api.save({ owner: 'ghost' })).json.error, 'owner_not_found');
    assert.equal(api.models.Story._all().length, 0);
  } finally {
    await api.close();
  }
});

test('only clips hosted on this site are attached to a story', async () => {
  const api = await startApi();
  try {
    const local = `/clips/${'a'.repeat(32)}.gif`;
    await api.save({ clipUrl: local, clipType: 'gif' });
    assert.equal(api.models.Story._all()[0].clipUrl, local);
    assert.equal(api.models.Story._all()[0].clipType, 'gif');

    await api.save({ clipUrl: 'https://evil.example/x.gif', clipType: 'gif' });
    assert.equal(api.models.Story._all()[1].clipUrl, null, 'a foreign URL is dropped');
  } finally {
    await api.close();
  }
});

test('a story over the length limit is refused before anything is stored', async () => {
  const api = await startApi();
  try {
    const res = await api.save({ story: 'x'.repeat(20001) });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'story_too_long');
    assert.equal(api.models.Story._all().length, 0);
  } finally {
    await api.close();
  }
});

/* ============================================================
   APPROVAL
============================================================ */

test('a stranger cannot approve a story into the public archives', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    const res = await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId, username: 'mallory' } });

    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'not_participant');
    assert.equal(api.models.Story._all()[0].approved, false);
  } finally {
    await api.close();
  }
});

test('approving needs a signed-in member, not just a story id', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    const res = await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId } });
    assert.equal(res.status, 403);
  } finally {
    await api.close();
  }
});

test('the partner approving publishes the story and tells the author', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    const res = await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });

    assert.equal(res.json.approved, true);

    const story = api.models.Story._all()[0];
    assert.equal(story.approved, true);
    assert.equal(story.approvalPartner, true);
    assert.ok(story.approvedAt instanceof Date);

    const told = api.notificationsFor('alice').find(n => n.payload.action === 'published');
    assert.ok(told, 'the author is told it is live');

    const archives = await api.call('/api/story/archives');
    assert.equal(archives.json.stories.length, 1);
  } finally {
    await api.close();
  }
});

test('a story waiting for approval is private, and becomes public once approved', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();

    const stranger = await api.call(`/api/story/${json.storyId}?username=mallory`);
    assert.equal(stranger.status, 403, 'a shared link cannot leak a draft');

    const partner = await api.call(`/api/story/${json.storyId}?username=bob`);
    assert.equal(partner.status, 200);

    await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });

    const anyone = await api.call(`/api/story/${json.storyId}`);
    assert.equal(anyone.status, 200);
    assert.equal(anyone.json.story.title, 'Rooftop');
  } finally {
    await api.close();
  }
});

/* ============================================================
   EDITING (re-approval)
============================================================ */

test('editing a published story takes it back out of the archives until it is re-approved', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });
    assert.equal((await api.call('/api/story/archives')).json.stories.length, 1);

    const edited = await api.call('/api/story/update', {
      method: 'POST',
      body: { storyId: json.storyId, username: 'alice', title: 'Rooftop (revised)', story: 'A different ending.' }
    });

    assert.deepEqual(edited.json, { ok: true, revision: 1, wasPublished: true, approved: false });

    const story = api.models.Story._all()[0];
    assert.equal(story.title, 'Rooftop (revised)');
    assert.equal(story.approved, false);
    assert.equal(story.approvalPartner, false, 'the partner has to approve the new text');
    assert.equal((await api.call('/api/story/archives')).json.stories.length, 0);

    const asked = api.notificationsFor('bob').filter(n => n.event === 'storyApprovalRequest');
    assert.equal(asked.at(-1).payload.revised, true, 'the partner is told it is a revision');
    assert.match(asked.at(-1).payload.title, /revised/);
  } finally {
    await api.close();
  }
});

test('a story can be edited before it is approved, and the revision counter keeps counting', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    await api.call('/api/story/update', { method: 'POST', body: { storyId: json.storyId, username: 'alice', story: 'Take two.' } });
    const second = await api.call('/api/story/update', { method: 'POST', body: { storyId: json.storyId, username: 'alice', story: 'Take three.' } });

    assert.equal(second.json.wasPublished, false);
    assert.equal(second.json.revision, 2);
    assert.equal(api.models.Story._all()[0].story, 'Take three.');
  } finally {
    await api.close();
  }
});

test('nobody but the author can rewrite a story', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    const res = await api.call('/api/story/update', {
      method: 'POST',
      body: { storyId: json.storyId, username: 'bob', title: 'hijacked', story: 'nope' }
    });

    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'not_owner');
    assert.equal(api.models.Story._all()[0].title, 'Rooftop');
  } finally {
    await api.close();
  }
});

test('an edit can remove an attached clip', async () => {
  const api = await startApi();
  try {
    const clip = `/clips/${'b'.repeat(32)}.mp4`;
    const { json } = await api.save({ clipUrl: clip, clipType: 'video' });

    await api.call('/api/story/update', {
      method: 'POST',
      body: { storyId: json.storyId, username: 'alice', story: 'No clip now.', clipUrl: null }
    });

    assert.equal(api.models.Story._all()[0].clipUrl, null);
  } finally {
    await api.close();
  }
});

/* ============================================================
   DECLINING
============================================================ */

test('declining keeps the story private, records the reason and tells the author', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    const res = await api.call('/api/story/decline', {
      method: 'POST',
      body: { storyId: json.storyId, username: 'bob', reason: 'that is not what happened' }
    });

    assert.equal(res.json.ok, true);
    assert.equal(res.json.retracted, false);

    const story = api.models.Story._all()[0];
    assert.equal(story.declined, true);
    assert.equal(story.declinedBy, 'bob');
    assert.equal(story.declineReason, 'that is not what happened');

    const told = api.notificationsFor('alice').find(n => n.payload.action === 'declined');
    assert.ok(told, 'the author is told');
    assert.equal(told.payload.reason, 'that is not what happened');
    assert.equal((await api.call('/api/story/archives')).json.stories.length, 0);
  } finally {
    await api.close();
  }
});

test('approval can be retracted after a story is published', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });

    const res = await api.call('/api/story/decline', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });
    assert.equal(res.json.retracted, true);

    assert.equal((await api.call('/api/story/archives')).json.stories.length, 0);
    assert.equal((await api.call(`/api/story/${json.storyId}`)).status, 403);
  } finally {
    await api.close();
  }
});

test('a refused story cannot be approved until it has been revised', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    await api.call('/api/story/decline', { method: 'POST', body: { storyId: json.storyId, username: 'bob', reason: 'no' } });

    const res = await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'declined');

    // The author revises; the refusal clears and the partner is asked again.
    await api.call('/api/story/update', { method: 'POST', body: { storyId: json.storyId, username: 'alice', story: 'Take two.' } });

    const story = api.models.Story._all()[0];
    assert.equal(story.declined, false);
    assert.equal(story.declineReason, '');

    const approved = await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });
    assert.equal(approved.json.approved, true);
  } finally {
    await api.close();
  }
});

/* ============================================================
   PENDING, LISTS AND ARCHIVES
============================================================ */

test('pending separates what is waiting from what was refused', async () => {
  const api = await startApi();
  try {
    const waiting = await api.save({ title: 'Waiting' });
    const refused = await api.save({ title: 'Refused' });
    await api.call('/api/story/decline', { method: 'POST', body: { storyId: refused.json.storyId, username: 'bob', reason: 'no' } });

    const author = await api.call('/api/story/pending?username=alice');
    assert.deepEqual(author.json.stories.map(s => s.title), ['Waiting']);
    assert.deepEqual(author.json.declined.map(s => s.title), ['Refused']);

    const partner = await api.call('/api/story/pending?username=bob');
    assert.deepEqual(partner.json.stories.map(s => s.title), ['Waiting']);
    assert.equal(partner.json.declined.length, 1, 'the partner can see what they refused');

    const outsider = await api.call('/api/story/pending?username=mallory');
    assert.equal(outsider.json.stories.length, 0);
    assert.equal(waiting.json.ok, true);
  } finally {
    await api.close();
  }
});

test('a profile lists published stories and never the refused ones', async () => {
  const api = await startApi();
  try {
    const live = await api.save({ title: 'Live' });
    const refused = await api.save({ title: 'Refused' });
    await api.call('/api/story/approve', { method: 'POST', body: { storyId: live.json.storyId, username: 'bob' } });
    await api.call('/api/story/decline', { method: 'POST', body: { storyId: refused.json.storyId, username: 'bob' } });

    const alice = await api.call('/api/story/list?username=alice');
    assert.deepEqual(alice.json.stories.map(s => s.title), ['Live']);

    const bob = await api.call('/api/story/list?username=bob');
    assert.deepEqual(bob.json.stories.map(s => s.title), ['Live']);

    assert.equal((await api.call('/api/story/list?username=mallory')).json.stories.length, 0);
  } finally {
    await api.close();
  }
});

test('the archives can be searched by title, body or either member', async () => {
  const api = await startApi();
  try {
    const first = await api.save({ title: 'Rooftop', story: 'A quiet fight above the city.' });
    await api.call('/api/story/approve', { method: 'POST', body: { storyId: first.json.storyId, username: 'bob' } });

    api.models.User._add({ username: 'carol', display: 'Carol' });
    api.models.User._add({ username: 'dave', display: 'Dave' });
    const second = await api.save({ owner: 'carol', partner: 'dave', title: 'Basement', story: 'Damp and loud.' });
    await api.call('/api/story/approve', { method: 'POST', body: { storyId: second.json.storyId, username: 'dave' } });

    assert.equal((await api.call('/api/story/archives?q=rooftop')).json.stories.length, 1, 'by title');
    assert.equal((await api.call('/api/story/archives?q=above the city')).json.stories.length, 1, 'by body text');
    assert.equal((await api.call('/api/story/archives?q=carol')).json.stories.length, 1, 'by member');
    assert.equal((await api.call('/api/story/archives?q=nothing')).json.stories.length, 0);
    assert.equal((await api.call('/api/story/archives?participant=alice')).json.stories.length, 1, 'one member\'s stories');

    // A regex character in a search term is a literal, not a query.
    assert.equal((await api.call('/api/story/archives?q=.*')).json.stories.length, 0);
  } finally {
    await api.close();
  }
});

test('the archives page on the server and report their totals', async () => {
  const api = await startApi();
  try {
    for (let i = 0; i < 5; i++) {
      const saved = await api.save({ title: `Story ${i}` });
      await api.call('/api/story/approve', { method: 'POST', body: { storyId: saved.json.storyId, username: 'bob' } });
    }

    const page = await api.call('/api/story/archives?page=2&perPage=2');
    assert.equal(page.json.total, 5);
    assert.equal(page.json.totalPages, 3);
    assert.equal(page.json.page, 2);
    assert.equal(page.json.stories.length, 2);

    const whole = await api.call('/api/story/archives');
    assert.equal(whole.json.stories.length, 5, 'without paging the whole list is returned (older clients)');

    const sorted = await api.call('/api/story/archives?sort=title');
    assert.equal(sorted.json.stories[0].title, 'Story 0');
  } finally {
    await api.close();
  }
});

test('one story can be fetched for a permalink, and a bad id is rejected', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });

    const one = await api.call(`/api/story/${json.storyId}`);
    assert.equal(one.json.story.story, 'We met on the roof.');

    assert.equal((await api.call('/api/story/not-an-object-id')).status, 400);
    assert.equal((await api.call(`/api/story/${'0'.repeat(24)}`)).status, 404);
  } finally {
    await api.close();
  }
});

/* ============================================================
   NUDGING AND WITHDRAWING
============================================================ */

test('an author can nudge the partner again, and a refusal cannot be nudged', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();

    const nudged = await api.call('/api/story/resend', { method: 'POST', body: { storyId: json.storyId, username: 'alice' } });
    assert.equal(nudged.json.target, 'bob');
    assert.equal(api.notificationsFor('bob').filter(n => n.event === 'storyApprovalRequest').length, 2);

    await api.call('/api/story/decline', { method: 'POST', body: { storyId: json.storyId, username: 'bob', reason: 'no' } });
    const refusedNudge = await api.call('/api/story/resend', { method: 'POST', body: { storyId: json.storyId, username: 'alice' } });
    assert.equal(refusedNudge.status, 400);
    assert.equal(refusedNudge.json.error, 'declined');

    const outsider = await api.call('/api/story/resend', { method: 'POST', body: { storyId: json.storyId, username: 'mallory' } });
    assert.equal(outsider.status, 403);
  } finally {
    await api.close();
  }
});

test('withdrawing removes the story everywhere and tells the other member', async () => {
  const api = await startApi();
  try {
    const { json } = await api.save();
    await api.call('/api/story/approve', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });

    const stolen = await api.call('/api/story/delete', { method: 'POST', body: { storyId: json.storyId, username: 'bob' } });
    assert.equal(stolen.status, 403, 'only the author can withdraw it');

    const res = await api.call('/api/story/delete', { method: 'POST', body: { storyId: json.storyId, username: 'alice' } });
    assert.equal(res.json.ok, true);

    assert.equal(api.models.Story._all().length, 0);
    assert.equal((await api.call('/api/story/archives')).json.stories.length, 0);
    assert.equal((await api.call(`/api/story/${json.storyId}`)).status, 404);

    const told = api.notificationsFor('bob').find(n => n.payload.action === 'deleted');
    assert.ok(told, 'the partner is told it is gone');
  } finally {
    await api.close();
  }
});

/* ============================================================
   BUILDING FROM THE CONVERSATION
============================================================ */

test('the conversation can be loaded by the two people in it, within a date window', async () => {
  const api = await startApi();
  try {
    const dm = async (from, to, text, time) => api.models.DM.create({ from, to, text, time: new Date(time) });
    await dm('alice', 'bob', 'Ready?', '2026-01-02T20:00:00Z');
    await dm('bob', 'alice', 'Always.', '2026-01-02T20:01:00Z');
    await dm('alice', 'bob', 'Later that week.', '2026-01-09T20:00:00Z');

    const all = await api.call('/api/story/load', {
      method: 'POST',
      body: { a: 'alice', b: 'bob', requester: 'alice', fromDate: '2026-01-01' }
    });
    assert.equal(all.json.messages.length, 3);
    assert.equal(all.json.messages[0].text, 'Ready?', 'oldest first, ready to read');

    const window = await api.call('/api/story/load', {
      method: 'POST',
      body: { a: 'alice', b: 'bob', requester: 'bob', fromDate: '2026-01-02', toDate: '2026-01-02' }
    });
    assert.equal(window.json.messages.length, 2, 'a bare end date includes that whole day');

    const reverse = await api.call('/api/story/load', {
      method: 'POST',
      body: { a: 'bob', b: 'alice', requester: 'bob', fromDate: '2026-01-01' }
    });
    assert.equal(reverse.json.messages.length, 3, 'the conversation is the same read either way');
  } finally {
    await api.close();
  }
});

test('somebody outside the conversation cannot read it', async () => {
  const api = await startApi();
  try {
    await api.models.DM.create({ from: 'alice', to: 'bob', text: 'private', time: new Date() });

    const peeked = await api.call('/api/story/load', {
      method: 'POST',
      body: { a: 'alice', b: 'bob', requester: 'mallory', fromDate: '2026-01-01' }
    });
    assert.equal(peeked.status, 403);

    const unauthenticated = await api.call('/api/story/load', {
      method: 'POST',
      body: { a: 'alice', b: 'bob', fromDate: '2026-01-01' }
    });
    assert.equal(unauthenticated.status, 403);
  } finally {
    await api.close();
  }
});

test('the loaded window is capped, and says when it was cut short', async () => {
  const api = await startApi();
  try {
    for (let i = 0; i < 6; i++) {
      await api.models.DM.create({ from: 'alice', to: 'bob', text: `line ${i}`, time: new Date(Date.now() + i * 1000) });
    }

    const capped = await api.call('/api/story/load', {
      method: 'POST',
      body: { a: 'alice', b: 'bob', requester: 'alice', fromDate: '2026-01-01', limit: 3 }
    });

    assert.equal(capped.json.messages.length, 3);
    assert.equal(capped.json.truncated, true);
    assert.equal(capped.json.messages.at(-1).text, 'line 5', 'the most recent messages are kept');
  } finally {
    await api.close();
  }
});
