/**
 * Story authoring rules.
 *
 * Split out of index.js (the same way dmDelivery.js was) so the rules that
 * decide what a story may contain, who may change it and when it becomes
 * public can be exercised on their own — see tests/story-service.test.js.
 *
 * The story flow used to be write-once:
 *
 *   - a story was created, approved by the partner and published, with no way
 *     to correct a typo, withdraw it, or say no. A "Deny" button in the
 *     approval popup only closed the window.
 *   - /api/story/approve took a storyId and nothing else, and approvalOwner
 *     was already true at creation, so anybody who knew (or guessed) an id
 *     could publish a story into the public archives. Nothing recorded who
 *     approved what.
 *
 * Every transition below is therefore expressed as a function of (story,
 * username) returning the fields to persist, so a route can never invent a
 * state the rules do not allow.
 */

const STORY_LIMITS = {
  title: 120,
  // Long enough for a full scene with a pasted transcript, short enough that a
  // single story cannot fill the database from the 10 MB JSON body limit.
  body: 20000,
  declineReason: 500,
  // How many loaded DM lines the editor may turn into a transcript in one go.
  transcript: 3000
};

const normalize = value => String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();

const isOwner = (story, username) => !!story && !!username && story.owner === username;
const isPartner = (story, username) => !!story && !!username && story.partner === username;
const isParticipant = (story, username) => isOwner(story, username) || isPartner(story, username);

/** A story is public only once both sides have approved it and nobody declined. */
const isPublished = story => !!story && story.approved === true && story.declined !== true;

/**
 * Validate a brand new story. The owner is the author, so there is nothing to
 * approve on their side; only the partner can hold it back.
 */
function validateNewStory({ owner, partner, title, story }) {
  const me = normalize(owner);
  const them = normalize(partner);

  if (!me || !them) return { ok: false, error: "missing_participant" };
  if (me === them) return { ok: false, error: "same_participant" };

  const body = normalize(story);
  if (!body) return { ok: false, error: "empty_story" };
  if (body.length > STORY_LIMITS.body) return { ok: false, error: "story_too_long" };

  const heading = normalize(title);
  if (heading.length > STORY_LIMITS.title) return { ok: false, error: "title_too_long" };

  return { ok: true, value: { owner: me, partner: them, title: heading, story: body } };
}

/** Validate an edit. Same limits as creation, minus the participants. */
function validateEdit({ title, story }) {
  const body = normalize(story);
  if (!body) return { ok: false, error: "empty_story" };
  if (body.length > STORY_LIMITS.body) return { ok: false, error: "story_too_long" };

  const heading = normalize(title);
  if (heading.length > STORY_LIMITS.title) return { ok: false, error: "title_too_long" };

  return { ok: true, value: { title: heading, story: body } };
}

/**
 * Fields for an edit by the owner.
 *
 * An edit always re-opens approval: approved stories are public, so silently
 * rewriting one would let the author change what the partner already signed
 * off on. The revision counter lets the UI say "revised" and lets the partner
 * see that something changed since they last looked.
 */
function editFields(story, { title, story: body, clipUrl, clipType }) {
  const revision = (Number(story && story.revision) || 0) + 1;

  return {
    title,
    story: body,
    clipUrl: clipUrl || null,
    clipType: clipUrl ? (clipType === "gif" ? "gif" : "video") : null,
    // The author approves their own revision; the partner has to approve again.
    approvalOwner: true,
    approvalPartner: false,
    approved: false,
    declined: false,
    declinedBy: "",
    declineReason: "",
    revision,
    updatedAt: new Date()
  };
}

/**
 * Record one side's approval.
 *
 * Only the partner clears the partner flag and only the owner clears the owner
 * flag, so a request can no longer publish a story on behalf of someone else.
 */
function approveFields(story, username) {
  if (!story) return { ok: false, error: "not_found" };
  if (!isParticipant(story, username)) return { ok: false, error: "not_participant" };
  if (story.declined) return { ok: false, error: "declined" };

  const fields = {};

  if (isOwner(story, username)) {
    if (story.approvalOwner === true) return { ok: true, already: true, fields, approved: isPublished(story) };
    fields.approvalOwner = true;
  } else {
    if (story.approvalPartner === true) return { ok: true, already: true, fields, approved: isPublished(story) };
    fields.approvalPartner = true;
  }

  const approvalOwner = fields.approvalOwner === true || story.approvalOwner === true;
  const approvalPartner = fields.approvalPartner === true || story.approvalPartner === true;
  const approved = approvalOwner && approvalPartner;

  // Stamp the moment it becomes public so both profiles and the archives can
  // show when it was published, not just when it was first written.
  if (approved && !story.approved) fields.approvedAt = new Date();

  fields.approved = approved;
  return { ok: true, fields, approved };
}

/**
 * Refuse a story, with an optional reason the author can read. Also used to
 * retract an already published story: an approval given earlier can be taken
 * back, and the story stops being public immediately.
 */
function declineFields(story, username, reason) {
  if (!story) return { ok: false, error: "not_found" };
  if (!isParticipant(story, username)) return { ok: false, error: "not_participant" };

  const why = normalize(reason);
  if (why.length > STORY_LIMITS.declineReason) return { ok: false, error: "reason_too_long" };

  const wasPublished = isPublished(story);

  return {
    ok: true,
    wasPublished,
    fields: {
      declined: true,
      declinedBy: username,
      declineReason: why,
      approved: false,
      approvalPartner: false,
      updatedAt: new Date()
    }
  };
}

/** Only the author may rewrite or delete their own story. */
function canEdit(story, username) {
  return isOwner(story, username);
}

/**
 * Who may read a story: everybody once it is published, otherwise only the two
 * people in it. Keeps unapproved and declined drafts out of permalinks.
 */
function canView(story, username) {
  if (!story) return false;
  if (isPublished(story)) return true;
  return isParticipant(story, username);
}

/**
 * Archives query builder. `q` searches the title, the story text and both
 * usernames — the archives search used to match usernames only, so a story
 * could not be found by anything it was actually about.
 */
function archivesQuery({ q, participant, escapeRegex } = {}) {
  const query = { approved: true, declined: { $ne: true } };

  const term = normalize(q);
  if (term) {
    const rx = new RegExp(escapeRegex ? escapeRegex(term) : term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ title: rx }, { story: rx }, { owner: rx }, { partner: rx }];
  }

  const who = normalize(participant);
  if (who) query.$and = [{ $or: [{ owner: who }, { partner: who }] }];

  return query;
}

/** Clamp a page request and slice the result, so one page can never be huge. */
function paginate(items, { page, perPage } = {}) {
  const list = Array.isArray(items) ? items : [];
  // A missing, zero, negative or non-numeric page size falls back to the
  // default rather than being clamped to something the caller never asked for.
  const requested = Number(perPage);
  const size = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 50) : 12;
  const totalPages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const start = (current - 1) * size;

  return {
    items: list.slice(start, start + size),
    page: current,
    perPage: size,
    total: list.length,
    totalPages
  };
}

/** The DM sent when a story needs approval, or when a revision needs it again. */
function approvalDmText(story, { revised = false } = {}) {
  const title = story.title || "Untitled story";
  const verb = revised ? "revised the story" : "created a story";
  const tail = revised ? "Please approve the revision." : "Please approve it.";
  return `${story.owner} ${verb} involving your messages: "${title}". ${tail}`;
}

/** Notification text pushed to the partner when a story changes state. */
function statusDmText(story, action) {
  const title = story.title || "Untitled story";

  if (action === "deleted") return `${story.owner} deleted the story "${title}".`;
  if (action === "declined") {
    const reason = story.declineReason ? ` Reason: ${story.declineReason}` : "";
    return `${story.declinedBy} declined the story "${title}".${reason}`;
  }
  if (action === "published") return `The story "${title}" is approved and published on both profiles.`;

  return `${story.owner} updated the story "${title}".`;
}

module.exports = {
  STORY_LIMITS,
  normalize,
  isOwner,
  isPartner,
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
};
