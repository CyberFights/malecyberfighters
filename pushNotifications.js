/**
 * Web push — reaching a member who is not sitting on the site.
 *
 * The arena is realtime, so everything a member misses is missed silently: a DM
 * bridged in from Discord while their laptop was asleep, a story waiting for
 * their approval, a message that arrived after they closed the tab. The unread
 * badge only counts what a live socket handed it, and the catch-up on reconnect
 * only fires when they come back on their own. Push is what brings them back.
 *
 * Two rules shaped this:
 *
 * 1. **The message text never goes into the payload.** A notification body can
 *    appear on a lock screen and is relayed through a third-party push service,
 *    so on an 18+ site the content of a DM is exactly the wrong thing to put
 *    there. The push says who wrote and that something arrived; the member opens
 *    the app to read it.
 *
 * 2. **A dead subscription is deleted, not retried.** Push endpoints go stale
 *    constantly (browser reset, uninstalled PWA, expired subscription) and the
 *    service answers 404/410. Those are removed on the spot so the next DM does
 *    not pay for them again.
 *
 * Split out of index.js like the other modules so the delivery rules can be
 * exercised without a push service — see tests/push.test.js.
 */
'use strict';

/** Statuses that mean "this endpoint will never work again". */
const GONE_STATUSES = new Set([404, 410]);

/**
 * @param {object} deps
 * @param {object} deps.PushSubscription the mongoose model
 * @param {object} [deps.webpush]        the web-push library (injectable)
 * @param {string} [deps.publicKey]      VAPID public key
 * @param {string} [deps.privateKey]     VAPID private key
 * @param {string} [deps.subject]        mailto: or https: contact for VAPID
 * @param {Function} [deps.getUser]      async username → the member's document
 *                                       (for per-kind prefs + quiet hours)
 * @param {Function} [deps.gate]         shouldPush({ kind, user, now }) — the
 *                                       preference/quiet-hours gate from
 *                                       notificationPrefs.js
 * @param {function} [deps.log]
 */
function createPushNotifier({
  PushSubscription,
  webpush = null,
  publicKey = '',
  privateKey = '',
  subject = '',
  getUser = null,
  gate = null,
  log = console.log
}) {
  /** Push only works with a VAPID key pair and the library present. */
  const configured = !!(webpush && publicKey && privateKey);

  if (webpush && publicKey && privateKey) {
    try {
      webpush.setVapidDetails(subject || 'https://male-cyber-fighters.com', publicKey, privateKey);
    } catch (err) {
      console.error('push: invalid VAPID configuration:', err.message || err);
    }
  }

  /** What the browser needs in order to subscribe. Safe to serve publicly. */
  function clientConfig() {
    return { enabled: configured, publicKey: configured ? publicKey : null };
  }

  /**
   * Register (or refresh) one browser's subscription for a member. A member can
   * have several: a phone, a laptop, the installed PWA. The endpoint is the
   * natural key — the same browser re-subscribing updates its record rather than
   * adding a duplicate that would be notified twice.
   */
  async function subscribe(username, subscription) {
    if (!username) return { ok: false, error: 'auth_required' };

    const endpoint = subscription && subscription.endpoint;
    const keys = (subscription && subscription.keys) || {};
    if (!endpoint || !keys.p256dh || !keys.auth) {
      return { ok: false, error: 'invalid_subscription' };
    }

    try {
      await PushSubscription.updateOne(
        { endpoint },
        {
          $set: {
            username,
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            lastSeenAt: new Date()
          },
          $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
      );
      return { ok: true };
    } catch (err) {
      console.error('push: subscribe failed:', err.message || err);
      return { ok: false, error: 'server_error' };
    }
  }

  /** Forget one browser. Signing out of a device should stop notifying it. */
  async function unsubscribe(username, endpoint) {
    if (!username || !endpoint) return { ok: false, error: 'missing_endpoint' };
    try {
      const res = await PushSubscription.deleteOne({ username, endpoint });
      return { ok: true, removed: res?.deletedCount || 0 };
    } catch (err) {
      console.error('push: unsubscribe failed:', err.message || err);
      return { ok: false, error: 'server_error' };
    }
  }

  /** Forget every device, e.g. when an account is deleted. */
  async function unsubscribeAll(username) {
    if (!username) return 0;
    try {
      const res = await PushSubscription.deleteMany({ username });
      return res?.deletedCount || 0;
    } catch (err) {
      console.error('push: unsubscribeAll failed:', err.message || err);
      return 0;
    }
  }

/**
 * Build the payload. Deliberately content-free: see the note at the top.
 *
 * @param {object} args
 * @param {string} args.from  who wrote (a display name is nicer than a handle)
 * @param {string} [args.kind] 'dm' (default) | 'system' | 'mention' |
 *                            'story' | 'forum' | 'match' | 'challenge'
 */
  function buildPayload({ from, kind = 'dm', url = '/' } = {}) {
    const isSystem = kind === 'system' || !from || String(from).toUpperCase() === 'SYSTEM';
    const title = 'Male Cyber Fighters';

    // One body per kind, and never the message text itself — a lock screen is
    // a public surface and the push service is a third party.
    const bodyByKind = {
      system: 'You have a new notification.',
      mention: `You were mentioned by ${from}.`,
      story: 'A story is waiting for your approval.',
      forum: 'New reply in a forum you follow.',
      match: 'A match needs your attention.',
      challenge: `A match challenge from ${from} is waiting.`
    };

    const body = isSystem
      ? bodyByKind.system
      : (bodyByKind[kind] || `New direct message from ${from}.`);

    const tagByKind = {
      system: 'mcf-system',
      mention: 'mcf-mention',
      story: 'mcf-story',
      forum: 'mcf-forum',
      match: 'mcf-match',
      challenge: 'mcf-challenge',
      dm: `mcf-dm-${from}`
    };

    return JSON.stringify({
      title,
      body,
      // Everything the click handler needs, and nothing it does not.
      data: { url, kind: isSystem ? 'system' : kind },
      tag: tagByKind[kind] || tagByKind.dm,
      // Replace an unread notification of the same kind rather than stacking
      // one per event.
      renotify: false
    });
  }

  /**
   * Notify every device a member has registered. Returns how many pushes were
   * accepted, so the caller can tell "delivered" from "no live session and no
   * push either".
   */
  async function notify({ to, from, kind = 'dm', url = '/' }) {
    if (!configured || !to) return 0;

    // Per-kind preferences + quiet hours. A member who switched match pings
    // off (or is inside their 22:00–08:00 window) hears nothing, exactly as
    // if they had no subscription.
    if (getUser && gate) {
      try {
        const user = await getUser(to);
        if (user && !gate({ kind, user, now: new Date() })) return 0;
      } catch (err) {
        console.error('push: preference lookup failed:', err?.message || err);
        // A preference lookup failure must not silently eat the notification.
      }
    }

    let subs;
    try {
      subs = await PushSubscription.find({ username: to }).lean();
    } catch (err) {
      console.error('push: subscription lookup failed:', err.message || err);
      return 0;
    }
    if (!subs || !subs.length) return 0;

    const payload = buildPayload({ from, kind, url });
    let sent = 0;

    await Promise.all(subs.map(async sub => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        sent += 1;
      } catch (err) {
        if (GONE_STATUSES.has(err?.statusCode)) {
          // The endpoint is gone for good — stop paying for it on every DM.
          try {
            await PushSubscription.deleteOne({ endpoint: sub.endpoint });
          } catch (cleanupErr) {
            console.error('push: stale subscription cleanup failed:', cleanupErr.message || cleanupErr);
          }
          return;
        }
        // 429 / 5xx / a network blip: the subscription is probably fine, so it
        // stays and the next message tries again.
        console.error(`push: send failed (${err?.statusCode || err?.message || 'unknown'})`);
      }
    }));

    if (sent) log(`push: ${sent} notification(s) to ${to}`);
    return sent;
  }

  return {
    configured,
    clientConfig,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    notify,
    buildPayload: opts => JSON.parse(buildPayload(opts))
  };
}

module.exports = { createPushNotifier, GONE_STATUSES };
