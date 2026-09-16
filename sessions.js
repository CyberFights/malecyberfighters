/**
 * Sessions — the site's only source of truth about "who is asking".
 *
 * Before this module existed the client asserted its own identity: login
 * handed the browser a user object, the browser kept it in localStorage and
 * then told the server who it was on every request (`{ username }` in a body,
 * `msg.from` on a socket event). Nothing checked any of it, so any visitor
 * could read two other members' DM history, rewrite a profile, or post as
 * somebody else.
 *
 * Now the server issues an opaque random token on login/registration, stores
 * only its SHA-256 hash, and every privileged call is resolved back to a
 * username here. Identity is derived, never claimed.
 *
 * The token reaches the server two ways, both accepted everywhere:
 *
 *   1. an httpOnly `mcf_session` cookie — the normal browser path. JavaScript
 *      cannot read it, so a stolen DOM cannot steal the session, and
 *      `fetch` sends it automatically (its default credentials mode is
 *      "same-origin", which is why no existing call site had to change).
 *   2. `Authorization: Bearer <token>` — for clients that are not same-origin
 *      with the API (the Electron / Capacitor wrappers point at the Railway
 *      host) and for the socket.io handshake, where the raw token is passed
 *      as `auth.token`. The browser keeps it in localStorage for those cases.
 *
 * Because a cookie is accepted, cross-site request forgery becomes possible,
 * so `verifyRequest` also refuses a state-changing request whose `Origin`
 * header names a different site. A bearer-token request needs no such check:
 * an attacker's page cannot read the token to attach it.
 *
 * Split out of index.js the same way dmDelivery.js and storyRoutes.js were,
 * so the rules can be exercised without a database — see tests/sessions.test.js.
 */
const crypto = require('crypto');

/** Raw tokens are prefixed so a leaked one is recognisable in a log. */
const TOKEN_PREFIX = 'mcf_';

/** Absolute lifetime of a session. Re-authenticate after this. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** A session that has not been used for this long is dropped. */
const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * `lastSeen` is only rewritten once this much of the TTL has been consumed,
 * so a busy member does not produce one database write per request.
 */
const TOUCH_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

const COOKIE_NAME = 'mcf_session';

/**
 * Cookie attributes. `secure` is decided per deployment (it must stay off for
 * a plain-http preview or the cookie is never stored); `sameSite: 'lax'` keeps
 * the cookie out of cross-site sub-requests while still allowing a top-level
 * link back to the site to arrive signed in.
 */
function cookieOptions({ secure }) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!secure,
    path: '/',
    maxAge: SESSION_TTL_MS
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * A new random token. 32 bytes of CSPRNG output is far beyond brute force,
 * and only its hash is ever written to the database.
 */
function issueToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** Constant-time compare, so a timing probe cannot walk a token byte by byte. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Pull the token out of a request: bearer header first (the explicit path),
 * then the cookie. Returns null when neither carries one.
 */
function tokenFromRequest(req) {
  const header = req.get ? req.get('authorization') : req.headers?.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }

  const cookieHeader = req.headers?.cookie;
  if (typeof cookieHeader === 'string') {
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE_NAME) {
        try {
          return decodeURIComponent(rest.join('='));
        } catch (_) {
          return rest.join('=');
        }
      }
    }
  }

  return null;
}

/**
 * A token that arrived in a cookie makes the request CSRF-capable, so a
 * state-changing call must come from this site. Browsers omit `Origin` on
 * same-origin GETs and on some non-browser clients, which is why an absent
 * header is allowed — the check only rejects a *named* foreign site.
 */
function sameSiteRequest(req, baseUrl) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  const origin = req.headers?.origin;
  if (!origin || origin === 'null') return true;

  if (baseUrl) {
    try {
      if (origin === new URL(baseUrl).origin) return true;
    } catch (_) { /* a malformed APP_BASE_URL simply does not match */ }
  }

  // Fall back to the host the request was actually addressed to, which covers a
  // deployment reached through several names (custom domain + Railway host).
  // Only the host is compared: whether the request arrived as http or https is
  // decided by the proxy in front of this process, and a scheme mismatch there
  // says nothing about whether the browser sent it from this site.
  const host = req.headers?.host;
  if (host) {
    try {
      if (new URL(origin).host === String(host).toLowerCase()) return true;
    } catch (_) { /* an unparseable Origin simply does not match */ }
  }

  return false;
}

/**
 * Build the session store.
 *
 * @param {object} deps
 * @param {object} deps.Session a mongoose model created from sessionSchema
 * @param {object} deps.User    the user model, used to resolve the account
 * @param {string} [deps.appBaseUrl] canonical origin, for the CSRF check
 */
function createSessionManager({ Session, User, appBaseUrl = null }) {
  /**
   * Open a session for a username and return the raw token (shown to the
   * client exactly once).
   */
  async function createSession(username, meta = {}) {
    const token = issueToken();
    const now = Date.now();

    await Session.create({
      tokenHash: sha256(token),
      username,
      createdAt: new Date(now),
      lastSeenAt: new Date(now),
      expiresAt: new Date(now + SESSION_TTL_MS),
      userAgent: typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 300) : '',
      ip: typeof meta.ip === 'string' ? meta.ip.slice(0, 64) : ''
    });

    return token;
  }

  /**
   * Resolve a raw token to a live session. Returns null when the token is
   * unknown, expired, idle-timed-out, or belongs to a banned/removed account.
   * Touches `lastSeenAt` at most once per TOUCH_AFTER_MS.
   */
  async function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;

    let session;
    try {
      session = await Session.findOne({ tokenHash: sha256(token) }).lean();
    } catch (err) {
      console.error('session lookup error:', err.message || err);
      return null;
    }
    if (!session) return null;

    const now = Date.now();
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= now) return null;
    if (session.lastSeenAt && now - new Date(session.lastSeenAt).getTime() > IDLE_TTL_MS) return null;

    let user = null;
    try {
      user = await User.findOne({ username: session.username })
        .select('-passwordHash')
        .lean();
    } catch (err) {
      console.error('session user lookup error:', err.message || err);
      return null;
    }
    // A deleted or banned account loses every session immediately.
    if (!user || user.banned) return null;

    if (!session.lastSeenAt || now - new Date(session.lastSeenAt).getTime() > TOUCH_AFTER_MS) {
      Session.updateOne(
        { _id: session._id },
        { $set: { lastSeenAt: new Date(now) } }
      ).catch(err => console.error('session touch error:', err.message || err));
    }

    return { username: user.username, user, sessionId: String(session._id) };
  }

  /**
   * Express middleware: attach `req.session` / `req.user` when a valid token
   * is present. Never rejects on its own — `requireUser` does that — so a
   * route can choose to behave differently for a signed-out visitor.
   */
  function authenticate(req, _res, next) {
    const token = tokenFromRequest(req);
    if (!token) {
      req.authViaBearer = false;
      return next();
    }

    req.authViaBearer = /^Bearer\s+/i.test(String(req.get ? req.get('authorization') : req.headers?.authorization || ''));

    verifyToken(token)
      .then(found => {
        if (found) {
          req.session = found;
          req.user = found.user;
          req.sessionToken = token;
        }
        next();
      })
      .catch(err => {
        console.error('authenticate error:', err.message || err);
        next();
      });
  }

  /**
   * Express middleware: the request must carry a valid session, and — when the
   * session arrived as a cookie on a state-changing call — must come from this
   * site. Sets `req.username` for handlers, so no handler ever reads an
   * identity out of the request body again.
   */
  function requireUser(req, res, next) {
    authenticate(req, res, () => {
      if (!req.session) {
        return res.status(401).json({ ok: false, error: 'auth_required' });
      }
      if (!req.authViaBearer && !sameSiteRequest(req, appBaseUrl)) {
        return res.status(403).json({ ok: false, error: 'cross_site_request' });
      }
      req.username = req.session.username;
      next();
    });
  }

  /** End the session a token belongs to (sign out). */
  async function destroyToken(token) {
    if (!token) return 0;
    try {
      const res = await Session.deleteOne({ tokenHash: sha256(token) });
      return res?.deletedCount || 0;
    } catch (err) {
      console.error('session destroy error:', err.message || err);
      return 0;
    }
  }

  /**
   * Drop every session for a user. Used on ban, on account deletion, on an
   * admin password reset, and on a password change (where the caller keeps
   * the current session alive by passing `exceptToken`).
   */
  async function destroyUserSessions(username, { exceptToken = null } = {}) {
    if (!username) return 0;
    const filter = { username };
    if (exceptToken) filter.tokenHash = { $ne: sha256(exceptToken) };
    try {
      const res = await Session.deleteMany(filter);
      return res?.deletedCount || 0;
    } catch (err) {
      console.error('session revoke error:', err.message || err);
      return 0;
    }
  }

  return {
    createSession,
    verifyToken,
    authenticate,
    requireUser,
    destroyToken,
    destroyUserSessions,
    tokenFromRequest,
    sameSiteRequest: req => sameSiteRequest(req, appBaseUrl)
  };
}

module.exports = {
  createSessionManager,
  tokenFromRequest,
  sameSiteRequest,
  issueToken,
  sha256,
  safeEqual,
  cookieOptions,
  COOKIE_NAME,
  TOKEN_PREFIX,
  SESSION_TTL_MS,
  IDLE_TTL_MS,
  TOUCH_AFTER_MS
};
