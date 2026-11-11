/**
 * Federations — member-run groups with their own name, rules and roles.
 *
 * A federation is the wrestling-promotion idea made real: one member owns it,
 * writes the bylaws, invents the roles (Commissioner, Champion, Enforcer…)
 * and recruits members into it. The "Federations" section of the action row is
 * the door: Create opens the registration form, Join lists the federations
 * already out there, Manage shows yours, Chatroom is the members-only room.
 *
 * Storage is two places on purpose:
 *
 *   • Federation — the federation itself: name, description, rules, image,
 *     roles, members and the chatroom backlog (newest 200 messages).
 *   • user.federation — a small sub-document on the owner/member's own record
 *     ({ id, name, role, joinedAt }) so "which federation am I in?" is one
 *     field read, not a scan of every federation's member list.
 *
 * One federation per owner and one membership per member are enforced here, so
 * the client can never leave a member pointed at two promotions at once.
 *
 * Split out of index.js like the other route modules so the rules can be
 * exercised without a database — see tests/federations.test.js.
 */
'use strict';

const LIMITS = Object.freeze({
  name: 40,
  nameMin: 3,
  description: 600,
  descriptionMin: 10,
  rules: 1500,
  imageUrl: 500,
  roles: 6,
  roleName: 24,
  roleNameMin: 2,
  roleDescription: 120,
  message: 500,
  messagesKept: 200,
  messagesListed: 100
});

/** The two roles every federation is born with. */
const BUILT_IN_ROLES = Object.freeze([
  Object.freeze({ id: 'owner', name: 'Owner', description: 'Runs the federation' }),
  Object.freeze({ id: 'member', name: 'Member', description: 'Wrestles for the federation' })
]);

const RESERVED_ROLE_IDS = new Set(BUILT_IN_ROLES.map(role => role.id));

/* ---------------------------------------------------------------
   Cleaning / validation
--------------------------------------------------------------- */

/** One-line text: control characters and runs of spaces removed. */
function cleanInline(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** Multi-line text: newlines kept (the rules are written in paragraphs). */
function cleanBlock(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    // Tabs and the control characters that are not newlines become spaces.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** The case-insensitive key that makes "Iron Ring" and "iron ring" one name. */
function federationNameKey(name) {
  return cleanInline(name, LIMITS.name).toLowerCase();
}

/** "Head Booker" → "head-booker", a stable id for a member-written role. */
function roleIdFromName(name) {
  return cleanInline(name, LIMITS.roleName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.roleName) || 'role';
}

/** Federation images are uploaded through /api/upload-image, so only https. */
function isHttpsUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > LIMITS.imageUrl) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

/**
 * The roles the registration form sent: a list of names (optionally with a
 * one-line description). Empty rows are the form's leftovers and are skipped;
 * an id that collides with owner/member, or with another custom role, is
 * refused rather than silently renamed — the owner should pick the name.
 *
 * @returns {{ ok: boolean, roles?: object[], error?: string }}
 */
function normalizeRoles(input) {
  const entries = input == null ? [] : input;
  if (!Array.isArray(entries)) return { ok: false, error: 'roles_invalid' };
  if (entries.length > LIMITS.roles) return { ok: false, error: 'roles_too_many' };

  const roles = [];
  const seen = new Set(RESERVED_ROLE_IDS);

  for (const entry of entries) {
    const raw = typeof entry === 'string' ? { name: entry } : entry;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'roles_invalid' };
    }

    const name = cleanInline(raw.name, Infinity);
    if (!name) continue; // blank row
    if (name.length < LIMITS.roleNameMin) return { ok: false, error: 'role_name_short' };
    if (name.length > LIMITS.roleName) return { ok: false, error: 'role_name_long' };

    const id = roleIdFromName(name);
    if (seen.has(id)) return { ok: false, error: 'role_duplicate' };
    seen.add(id);

    roles.push({
      id,
      name,
      description: cleanInline(raw.description, LIMITS.roleDescription)
    });
  }

  return { ok: true, roles };
}

/**
 * Validate the federation registration form.
 *
 * @returns {{ ok: boolean, federation?: object, error?: string }}
 */
function normalizeFederation(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};

  const name = cleanInline(body.name, Infinity);
  if (!name) return { ok: false, error: 'name_required' };
  if (name.length < LIMITS.nameMin) return { ok: false, error: 'name_short' };
  if (name.length > LIMITS.name) return { ok: false, error: 'name_long' };

  const description = cleanBlock(body.description, Infinity);
  if (!description) return { ok: false, error: 'description_required' };
  if (description.length < LIMITS.descriptionMin) {
    return { ok: false, error: 'description_short' };
  }
  if (description.length > LIMITS.description) {
    return { ok: false, error: 'description_long' };
  }

  const rules = cleanBlock(body.rules, Infinity);
  if (rules.length > LIMITS.rules) return { ok: false, error: 'rules_long' };

  let imageUrl = '';
  if (body.imageUrl != null && String(body.imageUrl).trim() !== '') {
    if (!isHttpsUrl(body.imageUrl)) return { ok: false, error: 'image_invalid' };
    imageUrl = String(body.imageUrl).trim();
  }

  const roles = normalizeRoles(body.roles);
  if (!roles.ok) return { ok: false, error: roles.error };

  return {
    ok: true,
    federation: {
      name,
      nameKey: federationNameKey(name),
      description,
      rules,
      imageUrl,
      roles: roles.roles
    }
  };
}

/** A chatroom message the server is willing to store. */
function normalizeMessage(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const text = cleanBlock(body.text, LIMITS.message);
  if (!text) return { ok: false, error: 'message_required' };

  return { ok: true, text };
}

/* ---------------------------------------------------------------
   Serialising
--------------------------------------------------------------- */

function roleList(doc) {
  const custom = Array.isArray(doc.roles) ? doc.roles : [];
  // Built-ins first, then whatever the owner invented, without duplicates.
  const seen = new Set();
  const roles = [];
  BUILT_IN_ROLES.concat(custom).forEach(role => {
    const id = String(role && role.id ? role.id : '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    roles.push({
      id,
      name: cleanInline(role.name, LIMITS.roleName) || id,
      description: cleanInline(role.description, LIMITS.roleDescription),
      builtIn: RESERVED_ROLE_IDS.has(id)
    });
  });
  return roles;
}

function memberList(doc) {
  return (Array.isArray(doc.members) ? doc.members : []).map(member => ({
    username: String(member.username || ''),
    display: String(member.display || member.username || ''),
    roleId: String(member.roleId || 'member'),
    joinedAt: member.joinedAt || null
  }));
}

/**
 * The { id, name, role, joinedAt } membership stored on the member's own
 * record, or null. Shared with the routes so "am I in a federation?" reads the
 * same way everywhere.
 */
function membershipOf(user) {
  const fed = user && user.federation;
  if (!fed || !fed.id) return null;
  return {
    id: String(fed.id),
    name: fed.name || '',
    role: fed.role || 'member',
    joinedAt: fed.joinedAt || null
  };
}

/** What the Join list shows — nothing that needs membership to see. */
function federationSummary(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id || doc.id),
    name: doc.name || '',
    description: doc.description || '',
    imageUrl: doc.imageUrl || '',
    owner: doc.owner || '',
    memberCount: Array.isArray(doc.members) ? doc.members.length : 0,
    createdAt: doc.createdAt || null
  };
}

/**
 * The view of a federation. The member list is only handed to someone who is
 * in it; everyone else gets the recruiting-card fields.
 */
function serializeFederation(doc, viewer) {
  if (!doc) return null;
  const members = memberList(doc);
  const isMember = !!viewer && members.some(member => member.username === viewer);

  return {
    id: String(doc._id || doc.id),
    name: doc.name || '',
    description: doc.description || '',
    rules: doc.rules || '',
    imageUrl: doc.imageUrl || '',
    owner: doc.owner || '',
    roles: roleList(doc),
    memberCount: members.length,
    members: isMember ? members : [],
    isMember,
    isOwner: !!viewer && doc.owner === viewer,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null
  };
}

/** The chatroom backlog, oldest first, for the open room window. */
function serializeMessages(doc) {
  const messages = Array.isArray(doc && doc.messages) ? doc.messages : [];
  return messages.slice(-LIMITS.messagesListed).map(message => ({
    from: String(message.from || ''),
    display: String(message.display || message.from || ''),
    text: String(message.text || ''),
    at: message.at || null
  }));
}

/* ---------------------------------------------------------------
   Routes
--------------------------------------------------------------- */

function createFederationRouter({ Federation, User, requireUser }) {
  const express = require('express');
  const router = express.Router();

  /** The signed-in member, or null. Banned accounts cannot play. */
  async function loadMember(username) {
    const user = await User.findOne({ username })
      .select('username display federation banned')
      .lean();
    if (!user || user.banned) return null;
    return user;
  }

  /** Point the member's own record at the federation they just joined. */
  function membershipPatch(federation, role) {
    return {
      id: federation._id,
      name: federation.name,
      role: role || 'member',
      joinedAt: new Date()
    };
  }

  // ---------- create ----------
  // POST /api/federations
  router.post('/', requireUser, async (req, res) => {
    const username = req.username;

    const validated = normalizeFederation(req.body);
    if (!validated.ok) {
      return res.status(400).json({ ok: false, error: validated.error });
    }

    try {
      const user = await loadMember(username);
      if (!user) return res.status(403).json({ ok: false, error: 'not_allowed' });

      // "If you don't run a federation already" — and a member cannot be in
      // two promotions at once, so any membership blocks the form too. A
      // pointer at a federation that has since been deleted is not a
      // membership: clear it and let the member register.
      let membership = membershipOf(user);
      if (membership) {
        const stillThere = await Federation.findById(membership.id).select('_id').lean().catch(() => null);
        if (stillThere) {
          return res.status(409).json({
            ok: false,
            error: 'already_in_federation',
            membership
          });
        }
        await User.updateOne({ username }, { $set: { federation: null } });
        membership = null;
      }

      const owned = await Federation.findOne({ owner: username }).select('name').lean();
      if (owned) {
        return res.status(409).json({ ok: false, error: 'already_run_federation' });
      }

      const nameTaken = await Federation.findOne({
        nameKey: validated.federation.nameKey
      }).select('name').lean();
      if (nameTaken) return res.status(409).json({ ok: false, error: 'name_taken' });

      const doc = await Federation.create({
        name: validated.federation.name,
        nameKey: validated.federation.nameKey,
        description: validated.federation.description,
        rules: validated.federation.rules,
        imageUrl: validated.federation.imageUrl,
        owner: username,
        roles: validated.federation.roles,
        members: [{
          username,
          display: user.display || username,
          roleId: 'owner',
          joinedAt: new Date()
        }]
      });

      try {
        await User.updateOne(
          { username },
          { $set: { federation: membershipPatch(doc, 'owner') } }
        );
      } catch (err) {
        // Never leave a federation nobody owns a pointer to.
        await Federation.deleteOne({ _id: doc._id }).catch(() => {});
        throw err;
      }

      return res.status(201).json({
        ok: true,
        federation: serializeFederation(doc, username)
      });
    } catch (err) {
      if (err && err.code === 11000) {
        // The unique indexes are the real guard against two taps of Create.
        return res.status(409).json({ ok: false, error: 'name_taken' });
      }
      console.error('federation create error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- the Join list ----------
  router.get('/', requireUser, async (req, res) => {
    try {
      const user = await loadMember(req.username);
      if (!user) return res.status(403).json({ ok: false, error: 'not_allowed' });

      const federations = await Federation.find({})
        .sort({ createdAt: 1 })
        .limit(200)
        .lean();

      return res.json({
        ok: true,
        membership: membershipOf(user),
        federations: federations.map(federationSummary)
      });
    } catch (err) {
      console.error('federation list error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- my federation (Manage / Chatroom) ----------
  router.get('/mine', requireUser, async (req, res) => {
    try {
      const user = await loadMember(req.username);
      if (!user) return res.status(403).json({ ok: false, error: 'not_allowed' });

      const membership = membershipOf(user);
      let doc = null;
      if (membership) doc = await Federation.findById(membership.id).lean();

      // A member whose federation was removed can still own one — recover.
      if (!doc) doc = await Federation.findOne({ owner: req.username }).lean();

      if (doc && !membership) {
        await User.updateOne(
          { username: req.username },
          { $set: { federation: membershipPatch(doc, doc.owner === req.username ? 'owner' : 'member') } }
        );
        return res.json({
          ok: true,
          membership: membershipOf({ federation: membershipPatch(doc, doc.owner === req.username ? 'owner' : 'member') }),
          federation: serializeFederation(doc, req.username)
        });
      }

      // A pointer at a federation that no longer exists is not a membership.
      if (!doc && membership) {
        await User.updateOne({ username: req.username }, { $set: { federation: null } });
        return res.json({ ok: true, membership: null, federation: null });
      }

      return res.json({
        ok: true,
        membership,
        federation: doc ? serializeFederation(doc, req.username) : null
      });
    } catch (err) {
      if (err && err.name === 'CastError') {
        return res.json({ ok: true, membership: null, federation: null });
      }
      console.error('federation mine error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- join ----------
  router.post('/:id/join', requireUser, async (req, res) => {
    const username = req.username;

    try {
      const user = await loadMember(username);
      if (!user) return res.status(403).json({ ok: false, error: 'not_allowed' });

      const membership = membershipOf(user);
      if (membership) {
        return res.status(409).json({
          ok: false,
          error: membership.id === String(req.params.id) ? 'already_member' : 'already_in_federation',
          membership
        });
      }

      const joined = await Federation.findOneAndUpdate(
        { _id: req.params.id, 'members.username': { $ne: username } },
        {
          $push: {
            members: {
              username,
              display: user.display || username,
              roleId: 'member',
              joinedAt: new Date()
            }
          }
        },
        { new: true }
      );

      if (!joined) {
        const exists = await Federation.findById(req.params.id).select('_id').lean().catch(() => null);
        return res.status(exists ? 409 : 404).json({
          ok: false,
          error: exists ? 'already_member' : 'not_found'
        });
      }

      try {
        await User.updateOne(
          { username },
          { $set: { federation: membershipPatch(joined, 'member') } }
        );
      } catch (err) {
        // Undo the membership rather than leaving a member off the roster.
        await Federation.updateOne(
          { _id: joined._id },
          { $pull: { members: { username } } }
        ).catch(() => {});
        throw err;
      }

      return res.json({ ok: true, federation: serializeFederation(joined, username) });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation join error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- chatroom ----------
  async function loadRoom(federationId, username) {
    const doc = await Federation.findById(federationId).lean().catch(() => null);
    if (!doc) return { status: 404, error: 'not_found' };
    const isMember = (doc.members || []).some(member => member.username === username);
    if (!isMember) return { status: 403, error: 'not_a_member' };
    return { doc };
  }

  router.get('/:id/messages', requireUser, async (req, res) => {
    try {
      const room = await loadRoom(req.params.id, req.username);
      if (room.error) return res.status(room.status).json({ ok: false, error: room.error });
      return res.json({ ok: true, messages: serializeMessages(room.doc) });
    } catch (err) {
      console.error('federation messages error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  router.post('/:id/messages', requireUser, async (req, res) => {
    const validated = normalizeMessage(req.body);
    if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

    try {
      const room = await loadRoom(req.params.id, req.username);
      if (room.error) return res.status(room.status).json({ ok: false, error: room.error });

      const user = await User.findOne({ username: req.username })
        .select('display')
        .lean();

      const message = {
        from: req.username,
        display: (user && user.display) || req.username,
        text: validated.text,
        at: new Date()
      };

      const updated = await Federation.findByIdAndUpdate(
        req.params.id,
        {
          $push: {
            messages: { $each: [message], $slice: -LIMITS.messagesKept }
          }
        },
        { new: true }
      ).lean();

      return res.status(201).json({
        ok: true,
        messages: serializeMessages(updated)
      });
    } catch (err) {
      console.error('federation message error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  return { router };
}

module.exports = {
  LIMITS,
  BUILT_IN_ROLES,
  normalizeFederation,
  normalizeRoles,
  normalizeMessage,
  federationNameKey,
  roleIdFromName,
  isHttpsUrl,
  federationSummary,
  serializeFederation,
  serializeMessages,
  membershipOf,
  createFederationRouter
};
