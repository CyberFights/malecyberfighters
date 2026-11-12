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
 *
 * Roles carry an `admin` flag. The owner is always an admin; the built-in
 * Co-owner role is one too, and the owner can mark any custom role as able to
 * manage the federation. Only managers may open Manage, edit the details,
 * hand out roles or remove members, and only the owner may touch another
 * manager — an admin cannot promote themselves or unmask a peer.
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

/** The roles every federation is born with. `admin` roles can manage it. */
const BUILT_IN_ROLES = Object.freeze([
  Object.freeze({ id: 'owner', name: 'Owner', description: 'Runs the federation', admin: true }),
  Object.freeze({ id: 'co-owner', name: 'Co-owner', description: 'Shares management of the federation', admin: true }),
  Object.freeze({ id: 'member', name: 'Member', description: 'Wrestles for the federation', admin: false })
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
      description: cleanInline(raw.description, LIMITS.roleDescription),
      // A custom role can be trusted with Manage; only the owner decides that.
      admin: raw.admin === true || raw.admin === 'true'
    });
  }

  return { ok: true, roles };
}

/**
 * Validate a Manage → Roles draft.
 *
 * `editingId` keeps an existing role's id when its name changes, so renaming
 * "Commissioner" does not orphan every member already holding it. A built-in
 * role (Owner / Co-owner / Member) is never editable.
 *
 * @returns {{ ok: boolean, role?: object, error?: string }}
 */
function normalizeRoleDefinition(payload, doc, editingId) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const roles = roleList(doc || {});

  const current = editingId ? roles.find(role => role.id === editingId) : null;
  if (editingId && !current) return { ok: false, error: 'role_not_found' };
  if (current && current.builtIn) return { ok: false, error: 'built_in_role' };

  const name = cleanInline(body.name, Infinity);
  if (!name) return { ok: false, error: 'role_name_required' };
  if (name.length < LIMITS.roleNameMin) return { ok: false, error: 'role_name_short' };
  if (name.length > LIMITS.roleName) return { ok: false, error: 'role_name_long' };

  const nameTaken = roles.some(role =>
    role.id !== editingId &&
    cleanInline(role.name, LIMITS.roleName).toLowerCase() === name.toLowerCase());
  if (nameTaken) return { ok: false, error: 'role_duplicate' };

  const id = editingId || roleIdFromName(name);
  if (!editingId) {
    if (RESERVED_ROLE_IDS.has(id)) return { ok: false, error: 'role_duplicate' };
    if (roles.some(role => role.id === id)) return { ok: false, error: 'role_duplicate' };
    if ((Array.isArray(doc && doc.roles) ? doc.roles : []).length >= LIMITS.roles) {
      return { ok: false, error: 'roles_too_many' };
    }
  }

  return {
    ok: true,
    role: {
      id,
      name,
      description: cleanInline(body.description, LIMITS.roleDescription),
      admin: body.admin === true || body.admin === 'true'
    }
  };
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

/**
 * Validate the Manage → Details form. It edits the same fields as the
 * registration form except the roles, which are managed one member at a time.
 *
 * @returns {{ ok: boolean, details?: object, error?: string }}
 */
function normalizeFederationDetails(payload) {
  const validated = normalizeFederation({ ...(payload || {}), roles: [] });
  if (!validated.ok) return { ok: false, error: validated.error };

  const { name, nameKey, description, rules, imageUrl } = validated.federation;
  return { ok: true, details: { name, nameKey, description, rules, imageUrl } };
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
      admin: !!role.admin,
      builtIn: RESERVED_ROLE_IDS.has(id)
    });
  });
  return roles;
}

/**
 * Every role the federation offers, built-ins first, keyed by id. Used by both
 * the serialiser and the permission checks so they cannot disagree.
 */
function roleIndex(doc) {
  return roleList(doc).reduce((index, role) => {
    index[role.id] = role;
    return index;
  }, {});
}

/** Does this role (built-in or owner-written) grant management? */
function isAdminRole(doc, roleId) {
  const role = roleIndex(doc)[String(roleId || '')];
  return !!(role && role.admin);
}

/**
 * Can this member open Manage / edit / assign roles for this federation?
 * The owner always can; anyone else needs a role the federation marks admin
 * (Co-owner, or a custom role the owner ticked).
 */
function canManageFederation(doc, username) {
  if (!doc || !username) return false;
  if (doc.owner === username) return true;
  const member = (Array.isArray(doc.members) ? doc.members : [])
    .find(entry => entry.username === username);
  if (!member) return false;
  return isAdminRole(doc, member.roleId);
}

/**
 * The join requests on the federation. Membership is not granted the moment
 * someone presses Join: the owner (or an admin) approves or rejects it first.
 */
function joinRequests(doc) {
  return Array.isArray(doc && doc.requests) ? doc.requests : [];
}

/** Is this member waiting on a decision? */
function hasJoinRequest(doc, username) {
  return !!username && joinRequests(doc).some(request => request.username === username);
}

/**
 * The roster, with presence when the caller looked it up. `people` is the
 * matching slice of the User collection ({ username, online, lastSeenAt }).
 */
function memberList(doc, people) {
  const byUsername = {};
  (Array.isArray(people) ? people : []).forEach(person => {
    if (person && person.username) byUsername[person.username] = person;
  });

  return (Array.isArray(doc.members) ? doc.members : []).map(member => {
    const person = byUsername[member.username] || {};
    return {
      username: String(member.username || ''),
      display: String(person.display || member.display || member.username || ''),
      roleId: String(member.roleId || 'member'),
      joinedAt: member.joinedAt || null,
      // Presence: online is only true while a socket is attached; lastSeenAt
      // is what makes "active 2h ago" possible once they are gone.
      online: person.online === true,
      lastSeenAt: person.lastSeenAt || null
    };
  });
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
function serializeFederation(doc, viewer, people) {
  if (!doc) return null;
  const members = memberList(doc, people);
  const me = viewer ? members.find(member => member.username === viewer) : null;
  const isMember = !!me;
  const canManage = canManageFederation(doc, viewer);

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
    // What the Manage window keys off, and the role to cache on the member.
    canManage,
    viewerRole: me ? me.roleId : null,
    // Only a manager sees who is waiting; everyone else only ever learns that
    // their own request is pending.
    requests: canManage
      ? joinRequests(doc).map(request => ({
        username: String(request.username || ''),
        display: String(request.display || request.username || ''),
        requestedAt: request.requestedAt || null
      }))
      : [],
    requested: !isMember && hasJoinRequest(doc, viewer),
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

function createFederationRouter({
  Federation,
  User,
  requireUser,
  DM,
  deliverToUser,
  forwardDMToDiscord
}) {
  const express = require('express');
  const router = express.Router();

  /** The signed-in member, or null. Banned accounts cannot play. */
  async function loadMember(username) {
    const user = await User.findOne({ username })
      .select('username display federation banned online lastSeenAt')
      .lean();
    if (!user || user.banned) return null;
    return user;
  }

  /** The serialised federation with every member's presence attached. */
  async function view(doc, viewer) {
    const names = (Array.isArray(doc.members) ? doc.members : [])
      .map(member => member.username)
      .filter(Boolean);

    let people = [];
    if (names.length) {
      people = await User.find({ username: { $in: names } })
        .select('username display online lastSeenAt')
        .lean();
    }
    return serializeFederation(doc, viewer, people);
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

  /** Save a DM and hand it to the recipient's open window, if any. */
  async function deliverDM(fields) {
    if (!DM || typeof DM.create !== 'function') return null;
    const dm = await DM.create({ ...fields, time: new Date() });
    const payload = {
      ...(typeof dm.toObject === 'function' ? dm.toObject() : dm),
      id: String(dm._id)
    };
    if (deliverToUser) deliverToUser(fields.to, 'privateMessage', payload);
    return payload;
  }

  /**
   * The request lands in the owner's DMs as a real message from the applicant,
   * so it sits in their conversation rather than a system inbox nobody opens.
   * A DM failure must never undo the request itself.
   */
  async function notifyJoinRequest(doc, applicant) {
    const text = '@' + applicant.username + ' asked to join ' + doc.name + '.';
    try {
      await deliverDM({
        from: applicant.username,
        to: doc.owner,
        text,
        type: 'federationJoin',
        federationId: String(doc._id),
        federationName: doc.name,
        applicant: applicant.username
      });
      if (forwardDMToDiscord) {
        const owner = await User.findOne({ username: doc.owner }).lean();
        await forwardDMToDiscord(applicant.username, owner, text);
      }
    } catch (err) {
      console.error('federation join notify error:', err?.message || err);
    }
  }

  /** The decision, addressed to the applicant from the owner. */
  async function notifyDecision(doc, username, text) {
    try {
      await deliverDM({ from: doc.owner, to: username, text, type: 'system' });
    } catch (err) {
      console.error('federation decision notify error:', err?.message || err);
    }
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
        federation: await view(doc, username)
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
        federations: federations.map(doc => ({
          ...federationSummary(doc),
          requested: hasJoinRequest(doc, req.username)
        }))
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
        const role = doc.owner === req.username
          ? 'owner'
          : (Array.isArray(doc.members) ? doc.members : [])
            .find(member => member.username === req.username)?.roleId || 'member';
        await User.updateOne(
          { username: req.username },
          { $set: { federation: membershipPatch(doc, role) } }
        );
        return res.json({
          ok: true,
          membership: membershipOf({ federation: membershipPatch(doc, role) }),
          federation: await view(doc, req.username)
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
        federation: doc ? await view(doc, req.username) : null
      });
    } catch (err) {
      if (err && err.name === 'CastError') {
        return res.json({ ok: true, membership: null, federation: null });
      }
      console.error('federation mine error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- manage: edit the details ----------
  // PATCH /api/federations/:id — name, description, rules and image.
  router.patch('/:id', requireUser, async (req, res) => {
    const validated = normalizeFederationDetails(req.body);
    if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

    try {
      const doc = await Federation.findById(req.params.id).lean().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });
      if (!canManageFederation(doc, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      const details = validated.details;
      if (details.nameKey !== doc.nameKey) {
        const taken = await Federation.findOne({ nameKey: details.nameKey }).select('_id').lean();
        if (taken && String(taken._id) !== String(doc._id)) {
          return res.status(409).json({ ok: false, error: 'name_taken' });
        }
      }

      await Federation.updateOne({ _id: doc._id }, { $set: details });

      // A rename has to reach every member's own pointer, or their cached
      // "my federation" name would keep the old one forever.
      if (details.name !== doc.name) {
        await User.updateMany(
          { 'federation.id': doc._id },
          { $set: { 'federation.name': details.name } }
        );
      }

      const fresh = await Federation.findById(doc._id).lean();
      return res.json({ ok: true, federation: await view(fresh, req.username) });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation edit error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- manage: hand a member a role ----------
  // POST /api/federations/:id/members/:username/role  { roleId }
  router.post('/:id/members/:username/role', requireUser, async (req, res) => {
    try {
      const doc = await Federation.findById(req.params.id).lean().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });
      if (!canManageFederation(doc, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      const target = String(req.params.username || '');
      const member = (doc.members || []).find(entry => entry.username === target);
      if (!member) return res.status(404).json({ ok: false, error: 'member_not_found' });

      // Ownership is not a role you can hand around (yet), and nobody edits
      // their own row — a mis-tap should not demote the person clicking.
      if (target === doc.owner) {
        return res.status(409).json({ ok: false, error: 'cannot_change_owner' });
      }
      if (target === req.username) {
        return res.status(409).json({ ok: false, error: 'cannot_change_own_role' });
      }
      // Only the owner outranks another manager.
      if (req.username !== doc.owner && isAdminRole(doc, member.roleId)) {
        return res.status(403).json({ ok: false, error: 'insufficient_privileges' });
      }

      const roleId = String(req.body && req.body.roleId ? req.body.roleId : '').trim();
      const role = roleIndex(doc)[roleId];
      if (!role || roleId === 'owner') {
        return res.status(400).json({ ok: false, error: 'invalid_role' });
      }
      // An admin cannot mint another admin; only the owner can.
      if (role.admin && req.username !== doc.owner) {
        return res.status(403).json({ ok: false, error: 'insufficient_privileges' });
      }

      await Federation.updateOne(
        { _id: doc._id, 'members.username': target },
        { $set: { 'members.$.roleId': roleId } }
      );
      await User.updateOne(
        { username: target, 'federation.id': doc._id },
        { $set: { 'federation.role': roleId } }
      );

      const fresh = await Federation.findById(doc._id).lean();
      return res.json({ ok: true, federation: await view(fresh, req.username) });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation role error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- manage: remove a member ----------
  // DELETE /api/federations/:id/members/:username
  router.delete('/:id/members/:username', requireUser, async (req, res) => {
    try {
      const doc = await Federation.findById(req.params.id).lean().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });

      const target = String(req.params.username || '');
      const member = (doc.members || []).find(entry => entry.username === target);
      if (!member) return res.status(404).json({ ok: false, error: 'member_not_found' });

      // A member may always walk out on their own; managers can remove the
      // rest, except the owner and (unless the requester is the owner)
      // another manager.
      const leaving = target === req.username;
      if (!leaving && !canManageFederation(doc, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }
      if (target === doc.owner) {
        return res.status(409).json({ ok: false, error: 'cannot_remove_owner' });
      }
      if (!leaving && req.username !== doc.owner && isAdminRole(doc, member.roleId)) {
        return res.status(403).json({ ok: false, error: 'insufficient_privileges' });
      }

      await Federation.updateOne(
        { _id: doc._id },
        { $pull: { members: { username: target } } }
      );
      await User.updateOne(
        { username: target, 'federation.id': doc._id },
        { $set: { federation: null } }
      );

      const fresh = await Federation.findById(doc._id).lean();
      return res.json({
        ok: true,
        removed: target,
        selfRemoved: leaving,
        federation: await view(fresh, req.username)
      });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation remove error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- manage: create / edit / delete a role ----------
  // POST /api/federations/:id/roles  { name, description, admin }
  router.post('/:id/roles', requireUser, async (req, res) => {
    try {
      const doc = await Federation.findById(req.params.id).lean().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });
      if (!canManageFederation(doc, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      const validated = normalizeRoleDefinition(req.body, doc, null);
      if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

      // An admin may invent a plain role; only the owner mints an admin one.
      if (validated.role.admin && req.username !== doc.owner) {
        return res.status(403).json({ ok: false, error: 'insufficient_privileges' });
      }

      await Federation.updateOne(
        { _id: doc._id },
        { $push: { roles: validated.role } }
      );

      const fresh = await Federation.findById(doc._id).lean();
      return res.status(201).json({ ok: true, federation: await view(fresh, req.username) });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation role create error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // PATCH /api/federations/:id/roles/:roleId — the id never changes.
  router.patch('/:id/roles/:roleId', requireUser, async (req, res) => {
    try {
      const doc = await Federation.findById(req.params.id).lean().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });
      if (!canManageFederation(doc, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      const roleId = String(req.params.roleId || '');
      const current = roleIndex(doc)[roleId];
      if (!current) return res.status(404).json({ ok: false, error: 'role_not_found' });
      if (current.builtIn) return res.status(400).json({ ok: false, error: 'built_in_role' });

      const validated = normalizeRoleDefinition(req.body, doc, roleId);
      if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error });

      // Only the owner may edit an admin role or change who is an admin.
      if ((current.admin || validated.role.admin) && req.username !== doc.owner) {
        return res.status(403).json({ ok: false, error: 'insufficient_privileges' });
      }

      await Federation.updateOne(
        { _id: doc._id, 'roles.id': roleId },
        {
          $set: {
            'roles.$.name': validated.role.name,
            'roles.$.description': validated.role.description,
            'roles.$.admin': validated.role.admin
          }
        }
      );

      const fresh = await Federation.findById(doc._id).lean();
      return res.json({ ok: true, federation: await view(fresh, req.username) });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation role edit error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // DELETE /api/federations/:id/roles/:roleId — only when nobody holds it.
  router.delete('/:id/roles/:roleId', requireUser, async (req, res) => {
    try {
      const doc = await Federation.findById(req.params.id).lean().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });
      if (!canManageFederation(doc, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      const roleId = String(req.params.roleId || '');
      const current = roleIndex(doc)[roleId];
      if (!current) return res.status(404).json({ ok: false, error: 'role_not_found' });
      if (current.builtIn) return res.status(400).json({ ok: false, error: 'built_in_role' });
      if (current.admin && req.username !== doc.owner) {
        return res.status(403).json({ ok: false, error: 'insufficient_privileges' });
      }

      const holders = (doc.members || [])
        .filter(member => member.roleId === roleId)
        .map(member => member.username);
      if (holders.length) {
        return res.status(409).json({ ok: false, error: 'role_in_use', holders });
      }

      await Federation.updateOne(
        { _id: doc._id },
        { $pull: { roles: { id: roleId } } }
      );

      const fresh = await Federation.findById(doc._id).lean();
      return res.json({ ok: true, federation: await view(fresh, req.username) });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation role delete error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- asking to join ----------
  // POST /api/federations/:id/join
  // Pressing Join is a request, not a membership: the owner (or an admin)
  // approves or rejects it from the DM it sends or Manage → Members.
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

      const doc = await Federation.findById(req.params.id).lean().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });

      const onRoster = (doc.members || []).some(member => member.username === username);
      if (doc.owner === username || onRoster) {
        return res.status(409).json({ ok: false, error: 'already_member' });
      }
      if (hasJoinRequest(doc, username)) {
        return res.status(409).json({ ok: false, error: 'already_requested', owner: doc.owner });
      }

      await Federation.updateOne(
        { _id: doc._id },
        {
          $push: {
            requests: {
              username,
              display: user.display || username,
              requestedAt: new Date()
            }
          }
        }
      );

      await notifyJoinRequest(doc, user);

      return res.status(202).json({
        ok: true,
        requested: true,
        owner: doc.owner,
        name: doc.name
      });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation join error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  /** The federation after the pull of one request, as the acting manager sees it. */
  async function afterDecision(doc, viewer) {
    const fresh = await Federation.findById(doc._id).lean();
    return view(fresh, viewer);
  }

  // ---------- approve a join request ----------
  // POST /api/federations/:id/requests/:username/approve
  router.post('/:id/requests/:username/approve', requireUser, async (req, res) => {
    try {
      const doc = await Federation.findById(req.params.id).lean().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });
      if (!canManageFederation(doc, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      const applicantName = String(req.params.username || '');
      const waiting = hasJoinRequest(doc, applicantName);
      const onRoster = (doc.members || []).some(member => member.username === applicantName);

      // Approving twice is not an error: the first one already let them in.
      if (onRoster) {
        if (waiting) {
          await Federation.updateOne(
            { _id: doc._id },
            { $pull: { requests: { username: applicantName } } }
          );
        }
        return res.json({
          ok: true,
          approved: applicantName,
          federation: await afterDecision(doc, req.username)
        });
      }

      if (!waiting) return res.status(404).json({ ok: false, error: 'request_not_found' });

      const applicant = await User.findOne({ username: applicantName })
        .select('username display federation banned')
        .lean();
      if (!applicant || applicant.banned) {
        await Federation.updateOne(
          { _id: doc._id },
          { $pull: { requests: { username: applicantName } } }
        );
        return res.status(409).json({ ok: false, error: 'applicant_unavailable' });
      }

      const membership = membershipOf(applicant);
      if (membership) {
        // They went and joined somewhere else while the request sat waiting.
        await Federation.updateOne(
          { _id: doc._id },
          { $pull: { requests: { username: applicantName } } }
        );
        return res.status(409).json({
          ok: false,
          error: membership.id === String(doc._id) ? 'already_member' : 'already_in_federation',
          membership
        });
      }

      const joined = await Federation.findOneAndUpdate(
        { _id: doc._id, 'members.username': { $ne: applicantName } },
        {
          $push: {
            members: {
              username: applicantName,
              display: applicant.display || applicantName,
              roleId: 'member',
              joinedAt: new Date()
            }
          }
        },
        { new: true }
      );

      if (!joined) return res.status(409).json({ ok: false, error: 'already_member' });

      try {
        await User.updateOne(
          { username: applicantName },
          { $set: { federation: membershipPatch(joined, 'member') } }
        );
      } catch (err) {
        // Put the roster back rather than admitting someone we cannot point at.
        await Federation.updateOne(
          { _id: joined._id },
          { $pull: { members: { username: applicantName } } }
        ).catch(() => {});
        throw err;
      }

      await Federation.updateOne(
        { _id: joined._id },
        { $pull: { requests: { username: applicantName } } }
      );
      await notifyDecision(
        joined,
        applicantName,
        'Your request to join ' + joined.name + ' was approved. Welcome.'
      );

      return res.json({
        ok: true,
        approved: applicantName,
        federation: await afterDecision(joined, req.username)
      });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation request approve error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- reject a join request ----------
  // POST /api/federations/:id/requests/:username/reject
  router.post('/:id/requests/:username/reject', requireUser, async (req, res) => {
    try {
      const doc = await Federation.findById(req.params.id).lean().catch(() => null);
      if (!doc) return res.status(404).json({ ok: false, error: 'not_found' });
      if (!canManageFederation(doc, req.username)) {
        return res.status(403).json({ ok: false, error: 'not_a_manager' });
      }

      const applicantName = String(req.params.username || '');
      if (!hasJoinRequest(doc, applicantName)) {
        return res.status(404).json({ ok: false, error: 'request_not_found' });
      }

      await Federation.updateOne(
        { _id: doc._id },
        { $pull: { requests: { username: applicantName } } }
      );
      await notifyDecision(
        doc,
        applicantName,
        'Your request to join ' + doc.name + ' was declined.'
      );

      return res.json({
        ok: true,
        rejected: applicantName,
        federation: await afterDecision(doc, req.username)
      });
    } catch (err) {
      if (err && (err.name === 'CastError' || err.name === 'BSONError')) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      console.error('federation request reject error:', err?.message || err);
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

  /**
   * Who is in the chatroom right now: the federation's own members filtered to
   * the ones the arena sees as online. Outsiders never appear, even when they
   * are online — this list is the federation, not the site.
   */
  router.get('/:id/presence', requireUser, async (req, res) => {
    try {
      const room = await loadRoom(req.params.id, req.username);
      if (room.error) return res.status(room.status).json({ ok: false, error: room.error });

      const names = (room.doc.members || [])
        .map(member => member.username)
        .filter(Boolean);
      const people = names.length
        ? await User.find({ username: { $in: names } })
          .select('username display online lastSeenAt')
          .lean()
        : [];

      const byName = {};
      people.forEach(person => {
        if (person && person.username) byName[person.username] = person;
      });

      const online = names
        .filter(name => byName[name] && byName[name].online === true)
        .map(name => ({
          username: name,
          display: String(byName[name].display || name)
        }))
        .sort((a, b) => a.display.localeCompare(b.display));

      return res.json({ ok: true, online, total: names.length });
    } catch (err) {
      console.error('federation presence error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

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
  normalizeFederationDetails,
  normalizeRoles,
  normalizeRoleDefinition,
  normalizeMessage,
  federationNameKey,
  roleIdFromName,
  isHttpsUrl,
  federationSummary,
  roleList,
  roleIndex,
  isAdminRole,
  canManageFederation,
  joinRequests,
  hasJoinRequest,
  serializeFederation,
  serializeMessages,
  membershipOf,
  createFederationRouter
};
