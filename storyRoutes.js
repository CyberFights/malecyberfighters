/**
 * Story routes.
 *
 * Split out of index.js the same way dmDelivery.js was, so the endpoints can
 * be exercised over real HTTP with the database models stubbed — see
 * tests/story-routes.test.js. index.js supplies the models and the two
 * notification helpers; everything else lives here.
 *
 * The authoring rules themselves (what a story may contain, who may approve
 * it, what an edit does) are in storyService.js. These routes only load,
 * apply and notify:
 *
 *   POST /save      write a story           POST /update   rewrite your own
 *   POST /approve   clear your own flag     POST /decline  refuse, or retract
 *   POST /delete    withdraw your own       POST /resend   nudge the other side
 *   GET  /pending   waiting + refused       GET  /list     published, per member
 *   GET  /archives  public, searchable      GET  /:id      one story (permalinks)
 *   POST /load      the conversation a story is built from
 */
const express = require('express');
const rateLimit = require('express-rate-limit');

const {
  STORY_LIMITS,
  isParticipant,
  validateNewStory,
  validateEdit,
  editFields,
  approveFields,
  declineFields,
  canEdit,
  canView,
  archivesQuery,
  approvalDmText,
  statusDmText
} = require('./storyService');

function createStoryRouter({
  Story, User, DM, mongoose, emitToUser, forwardDMToDiscord, isLocalClipUrl,
  // Tests hand in a pass-through so a suite is not throttled; production gets
  // the real limiter below.
  writeLimiter
} = {}) {
  const router = express.Router();

  // Story writes are chatty enough to deserve their own budget, but far
  // cheaper than the DM path, so the limit is generous.
  const storyWriteLimiter = writeLimiter || rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false
  });

  /** Everyone in the story, minus one username. */
  const counterparties = (story, username) =>
    [story.owner, story.partner].filter(name => name && name !== username);

  /**
   * Drop a system DM into the conversation and pop it on any live session.
   * `payload.storyId` lets the DM render its own Approve / Revise buttons.
   */
  async function notifyStoryUser(username, event, payload, dmText, { type = "storyStatus" } = {}) {
    if (!username) return;

    if (dmText) {
      try {
        await DM.create({
          from: "SYSTEM",
          to: username,
          text: dmText,
          type,
          storyId: payload && payload.storyId ? String(payload.storyId) : undefined,
          time: new Date()
        });
        const user = await User.findOne({ username }).lean();
        await forwardDMToDiscord("SYSTEM", user, dmText);
      } catch (err) {
        // A failed notification must never fail the action the member asked for.
        console.error("story notification error:", err.message || err);
      }
    }

    try {
      emitToUser(username, event, payload);
    } catch (err) {
      console.error("story notify emit error:", err.message || err);
    }
  }

  // ---------------------------------------------------------------- save

  router.post("/save", storyWriteLimiter, async (req, res) => {
    try {
      const checked = validateNewStory(req.body || {});
      if (!checked.ok) return res.status(400).json({ ok: false, error: checked.error });

      const { owner, partner, title, story } = checked.value;

      // Both members have to exist: a story belongs to two profiles, and this
      // also stops a mistyped name from creating an orphan nobody can approve.
      const [ownerUser, partnerUser] = await Promise.all([
        User.findOne({ username: owner }).select("username discordId").lean(),
        User.findOne({ username: partner }).select("username discordId").lean()
      ]);
      if (!ownerUser) return res.status(404).json({ ok: false, error: "owner_not_found" });
      if (!partnerUser) return res.status(404).json({ ok: false, error: "partner_not_found" });

      // Optional clip attached to the story — must point at our own /clips route.
      const clipUrl = isLocalClipUrl(req.body.clipUrl) ? req.body.clipUrl : null;

      const saved = await Story.create({
        owner,
        partner,
        title,
        story,
        clipUrl,
        clipType: clipUrl ? (req.body.clipType === "gif" ? "gif" : "video") : null,
        approvalOwner: true,
        approvalPartner: false,
        approved: false,
        declined: false,
        revision: 0
      });

      await notifyStoryUser(
        partner,
        "storyApprovalRequest",
        { storyId: String(saved._id), from: owner, title: saved.title, revised: false },
        approvalDmText(saved),
        { type: "storyApproval" }
      );

      res.json({ ok: true, storyId: saved._id });
    } catch (err) {
      console.error("Story save error:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // -------------------------------------------------------------- update

  /**
   * Rewrite a story. Only the author, and the result goes back to their partner
   * for approval — an approved story is public, so changing the text has to be
   * re-signed rather than slipped in behind the partner's back.
   */
  router.post("/update", storyWriteLimiter, async (req, res) => {
    try {
      const { storyId, username } = req.body || {};
      if (!mongoose.isValidObjectId(storyId)) return res.status(400).json({ ok: false, error: "bad_id" });

      const story = await Story.findById(storyId);
      if (!story) return res.status(404).json({ ok: false, error: "not_found" });
      if (!canEdit(story, username)) return res.status(403).json({ ok: false, error: "not_owner" });

      const checked = validateEdit(req.body || {});
      if (!checked.ok) return res.status(400).json({ ok: false, error: checked.error });

      const wasPublished = story.approved === true && story.declined !== true;

      // "clipUrl": null in the body means "remove the clip"; a new /clips URL
      // replaces it; anything else (missing or foreign) leaves it alone.
      let clipUrl = story.clipUrl;
      if (req.body.clipUrl === null || req.body.clipUrl === "") clipUrl = null;
      else if (isLocalClipUrl(req.body.clipUrl)) clipUrl = req.body.clipUrl;

      Object.assign(story, editFields(story, { ...checked.value, clipUrl, clipType: req.body.clipType }));
      await story.save();

      await notifyStoryUser(
        story.partner,
        "storyApprovalRequest",
        { storyId: String(story._id), from: story.owner, title: story.title, revised: true },
        approvalDmText(story, { revised: true }),
        { type: "storyApproval" }
      );

      res.json({ ok: true, revision: story.revision, wasPublished, approved: false });
    } catch (err) {
      console.error("Story update error:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // -------------------------------------------------------------- delete

  /** Withdraw a story. Unpublishes it (and its spot in the archives) for good. */
  router.post("/delete", storyWriteLimiter, async (req, res) => {
    try {
      const { storyId, username } = req.body || {};
      if (!mongoose.isValidObjectId(storyId)) return res.status(400).json({ ok: false, error: "bad_id" });

      const story = await Story.findById(storyId).lean();
      if (!story) return res.status(404).json({ ok: false, error: "not_found" });
      if (!canEdit(story, username)) return res.status(403).json({ ok: false, error: "not_owner" });

      await Story.deleteOne({ _id: story._id });

      for (const other of counterparties(story, username)) {
        await notifyStoryUser(other, "storyStatusChanged", {
          storyId: String(story._id),
          action: "deleted",
          title: story.title
        }, statusDmText(story, "deleted"));
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("Story delete error:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ------------------------------------------------------------- approve

  router.post("/approve", storyWriteLimiter, async (req, res) => {
    try {
      const { storyId, username } = req.body || {};
      if (!mongoose.isValidObjectId(storyId)) return res.status(400).json({ ok: false, error: "bad_id" });

      const story = await Story.findById(storyId);
      if (!story) return res.status(404).json({ ok: false, error: "not_found" });

      // Only somebody actually named in the story can approve it.
      const result = approveFields(story, username);
      if (!result.ok) {
        const status = result.error === "not_participant" ? 403 : 400;
        return res.status(status).json({ ok: false, error: result.error });
      }

      if (Object.keys(result.fields).length) {
        Object.assign(story, result.fields);
        await story.save();
      }

      // Tell the author the moment it goes public. (`already` means this was a
      // second approval on a story that was published some time ago, which is
      // not news.)
      if (result.approved && !result.already) {
        await notifyStoryUser(story.owner, "storyStatusChanged", {
          storyId: String(story._id),
          action: "published",
          title: story.title
        }, statusDmText(story, "published"));
      }

      res.json({ ok: true, approved: story.approved === true, title: story.title });
    } catch (err) {
      console.error("Story approve error:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ------------------------------------------------------------- decline

  /**
   * Refuse a story, with an optional reason the author can read. Also used to
   * retract approval of a published story: an approval given earlier can be
   * taken back, and the story stops being public immediately.
   */
  router.post("/decline", storyWriteLimiter, async (req, res) => {
    try {
      const { storyId, username, reason } = req.body || {};
      if (!mongoose.isValidObjectId(storyId)) return res.status(400).json({ ok: false, error: "bad_id" });

      const story = await Story.findById(storyId);
      if (!story) return res.status(404).json({ ok: false, error: "not_found" });

      const result = declineFields(story, username, reason);
      if (!result.ok) {
        const status = result.error === "not_participant" ? 403 : 400;
        return res.status(status).json({ ok: false, error: result.error });
      }

      Object.assign(story, result.fields);
      await story.save();

      for (const other of counterparties(story, username)) {
        await notifyStoryUser(other, "storyStatusChanged", {
          storyId: String(story._id),
          action: "declined",
          title: story.title,
          reason: story.declineReason
        }, statusDmText(story, "declined"));
      }

      res.json({ ok: true, retracted: result.wasPublished });
    } catch (err) {
      console.error("Story decline error:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ------------------------------------------------------------- pending

  router.get("/pending", async (req, res) => {
    try {
      const { username } = req.query;

      // "stories" are waiting on somebody's approval, so they still show their
      // Approve / Decline / Resend buttons. "declined" are finished no's: the
      // author sees what was refused and why, and can revise from there.
      const all = await Story.find({
        $or: [{ owner: username }, { partner: username }],
        approved: false
      }).sort({ updatedAt: -1, createdAt: -1 }).lean();

      res.json({
        ok: true,
        stories: all.filter(s => s.declined !== true),
        declined: all.filter(s => s.declined === true)
      });
    } catch (err) {
      // Without this the rejected query escapes the handler and takes the whole
      // process down, so a single Mongo hiccup would drop every live socket.
      console.error("Story pending error:", err.message || err);
      res.status(500).json({ ok: false, error: "server_error", stories: [], declined: [] });
    }
  });

  // -------------------------------------------------------------- resend

  router.post("/resend", storyWriteLimiter, async (req, res) => {
    try {
      const { storyId, username } = req.body || {};
      if (!mongoose.isValidObjectId(storyId)) return res.status(400).json({ ok: false, error: "bad_id" });

      const story = await Story.findById(storyId).lean();
      if (!story) return res.status(404).json({ ok: false, error: "not_found" });
      if (!isParticipant(story, username)) return res.status(403).json({ ok: false, error: "not_participant" });
      if (story.declined) return res.status(400).json({ ok: false, error: "declined" });
      if (story.approved) return res.status(400).json({ ok: false, error: "already_approved" });

      // The author nudges; the target is whoever has not approved yet.
      const target = story.approvalOwner === false ? story.owner : story.partner;
      const revised = (Number(story.revision) || 0) > 0;

      await notifyStoryUser(target, "storyApprovalRequest", {
        storyId: String(story._id),
        from: story.owner,
        title: story.title,
        revised
      }, approvalDmText(story, { revised }), { type: "storyApproval" });

      res.json({ ok: true, target });
    } catch (err) {
      console.error("Story resend error:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ---------------------------------------------------------------- load

  /**
   * Load the conversation a story will be written from.
   *
   * This returns real private messages, so it only answers somebody who is one
   * of the two people in the conversation — it used to hand any caller the full
   * DM history between any two usernames. The window is bounded at both ends
   * and capped, because the editor only ever shows a pickable list.
   */
  router.post("/load", async (req, res) => {
    try {
      const { a, b, fromDate, toDate, requester, limit } = req.body || {};

      if (!a || !b) return res.status(400).json({ ok: false, error: "missing_participant" });
      if (!requester || (requester !== a && requester !== b)) {
        return res.status(403).json({ ok: false, error: "not_participant" });
      }

      const query = {
        $or: [
          { from: a, to: b },
          { from: b, to: a }
        ]
      };

      const from = fromDate ? new Date(fromDate) : null;
      const to = toDate ? new Date(toDate) : null;
      if (from && !Number.isNaN(from.getTime())) query.time = { $gte: from };
      if (to && !Number.isNaN(to.getTime())) {
        // A bare date means "including that whole day".
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(toDate))) to.setHours(23, 59, 59, 999);
        query.time = { ...(query.time || {}), $lte: to };
      }

      const cap = Math.min(Math.max(Number(limit) || STORY_LIMITS.transcript, 1), STORY_LIMITS.transcript);

      const messages = await DM.find(query)
        .sort({ time: -1 })
        .limit(cap)
        .lean();

      // Newest-first keeps the cap on the most recent history; the transcript
      // reads oldest-first.
      res.json({ ok: true, messages: messages.reverse(), truncated: messages.length >= cap });
    } catch (err) {
      console.error("Story load error:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ---------------------------------------------------------------- list

  router.get("/list", async (req, res) => {
    try {
      const { username } = req.query;

      // Approved stories are saved to both profiles: the owner (approvalOwner)
      // and the partner (approvalPartner) each see the story on their profile.
      // Declined stories are deliberately excluded — they are nobody's trophy.
      const stories = await Story.find({
        $or: [{ owner: username }, { partner: username }],
        approved: true,
        declined: { $ne: true }
      }).sort({ approvedAt: -1, createdAt: -1 }).lean();

      res.json({ ok: true, stories });
    } catch (err) {
      console.error("Story list error:", err.message || err);
      res.status(500).json({ ok: false, error: "server_error", stories: [] });
    }
  });

  // ------------------------------------------------------------ archives

  /**
   * Public archives: every approved story from every member.
   *
   * ?q= searches titles, story text and both usernames (it used to match the
   * two usernames only, so a story could not be found by anything it was
   * about). ?page / ?perPage paginate server-side; without them the whole list
   * is returned, which is what the older clients expect.
   */
  router.get("/archives", async (req, res) => {
    try {
      const { q, participant, page, perPage, sort } = req.query;

      const sorts = {
        recent: { approvedAt: -1, createdAt: -1 },
        oldest: { approvedAt: 1, createdAt: 1 },
        title: { title: 1 },
        author: { owner: 1 }
      };
      const order = sorts[sort] || sorts.recent;

      const query = archivesQuery({ q, participant, escapeRegex: escapeRegexLocal });

      if (page || perPage) {
        const size = Math.min(Math.max(Number(perPage) || 12, 1), 50);
        const current = Math.max(Number(page) || 1, 1);
        const [stories, total] = await Promise.all([
          Story.find(query).sort(order).skip((current - 1) * size).limit(size).lean(),
          Story.countDocuments(query)
        ]);

        return res.json({
          ok: true,
          stories,
          page: current,
          perPage: size,
          total,
          totalPages: Math.max(1, Math.ceil(total / size))
        });
      }

      const stories = await Story.find(query).sort(order).lean();
      res.json({ ok: true, stories, total: stories.length });
    } catch (err) {
      console.error("Story archives error:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // ------------------------------------------------------- one story by id

  // For permalinks ("/story/<id>"). Published stories are readable by anyone;
  // a story still awaiting approval is only visible to the two people in it, so
  // a shared link cannot leak a draft.
  router.get("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { username } = req.query;

      if (!mongoose.isValidObjectId(id)) return res.status(400).json({ ok: false, error: "bad_id" });

      const story = await Story.findById(id).lean();
      if (!story) return res.status(404).json({ ok: false, error: "not_found" });
      if (!canView(story, username)) return res.status(403).json({ ok: false, error: "private" });

      res.json({ ok: true, story });
    } catch (err) {
      console.error("Story fetch error:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  return router;
}

// index.js has the same helper for chat/DM text; kept local so this module can
// be loaded on its own (tests, tools) without pulling in the whole server.
function escapeRegexLocal(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { createStoryRouter };
