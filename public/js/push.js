/*
 * Web push — let a member hear about a DM they are not looking at.
 *
 * Everything else on the site is realtime, so a message that arrives with the
 * tab closed, the laptop asleep or the phone in a pocket simply does not exist
 * until the member comes back on their own. This is the opt-in that closes that
 * gap: the server pushes only when a DM reaches no live session (see
 * deliverToUser in index.js), and only ever says who wrote — never what.
 *
 * The button hides itself unless the whole chain is available: a secure
 * context, a service worker, PushManager, the Notification API, a signed-in
 * member, and a server with VAPID keys configured. A visitor on a browser
 * without any of that never sees a control that cannot work.
 */
(function () {
  'use strict';

  var BUTTON_IDS = ['btnNotifications', 'btnNotificationsDesktop'];
  var HINT_IDS = ['notificationsHint', 'notificationsHintDesktop'];
  // The whole card hides when the chain is unavailable, so a visitor is never
  // left looking at a heading for a control that cannot work.
  var CARD_IDS = ['notificationsCard', 'notificationsCardDesktop'];

  var subscription = null;
  var serverEnabled = false;
  var busy = false;

  function buttons() {
    return BUTTON_IDS.map(function (id) { return document.getElementById(id); }).filter(Boolean);
  }

  function hints() {
    return HINT_IDS.map(function (id) { return document.getElementById(id); }).filter(Boolean);
  }

  function setHint(message) {
    hints().forEach(function (el) { el.textContent = message || ''; });
  }

  function cards() {
    return CARD_IDS.map(function (id) { return document.getElementById(id); }).filter(Boolean);
  }

  function setVisible(visible) {
    buttons().forEach(function (btn) {
      btn.hidden = !visible;
      btn.setAttribute('aria-hidden', String(!visible));
    });
    cards().forEach(function (card) { card.hidden = !visible; });
    if (!visible) setHint('');
  }

  function setLabel(label, pressed) {
    buttons().forEach(function (btn) {
      btn.textContent = label;
      if (typeof pressed === 'boolean') btn.setAttribute('aria-pressed', String(pressed));
    });
  }

  function supported() {
    return 'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window &&
      window.isSecureContext;
  }

  function signedIn() {
    if (typeof getSession === 'function') return !!getSession();
    try { return !!JSON.parse(localStorage.getItem('cw_session_v1') || 'null'); } catch (e) { return false; }
  }

  /* VAPID keys are served as URL-safe base64; the browser wants bytes. */
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function registration() {
    return navigator.serviceWorker.ready;
  }

  async function loadServerConfig() {
    try {
      var res = await fetch('/api/push/config');
      var data = await res.json();
      serverEnabled = !!(data && data.ok && data.enabled && data.publicKey);
      return data && data.publicKey ? data.publicKey : null;
    } catch (e) {
      serverEnabled = false;
      return null;
    }
  }

  /** Tell the server about this browser's subscription. */
  async function registerSubscription(sub) {
    var res = await authFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON())
    });
    return res.ok;
  }

  async function dropSubscription(sub) {
    try {
      await authFetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
    } catch (e) { /* the local unsubscribe below is what matters */ }
    try { await sub.unsubscribe(); } catch (e) { /* already gone */ }
  }

  async function enable() {
    var publicKey = await loadServerConfig();
    if (!publicKey) {
      setHint('Notifications are not available on this site yet.');
      return false;
    }

    var permission = Notification.permission;
    if (permission === 'denied') {
      setLabel('Notifications blocked');
      setHint('Your browser is blocking notifications for this site. Allow them in the address-bar site settings to turn this on.');
      return false;
    }
    if (permission !== 'granted') {
      try {
        permission = await Notification.requestPermission();
      } catch (err) {
        // The browser refused to even ask — an embedded frame, a site setting,
        // or a prompt already dismissed for good.
        permission = 'denied';
      }
    }
    if (permission !== 'granted') {
      setLabel('Enable notifications');
      setHint('Notifications were not allowed, so a DM can only reach you while the site is open.');
      return false;
    }

    try {
      var reg = await registration();
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    } catch (err) {
      setHint('Your browser would not create a notification subscription.');
      return false;
    }

    var stored = await registerSubscription(subscription);
    setLabel(stored ? 'Notifications on' : 'Enable notifications', stored);
    setHint(stored
      ? 'A direct message will notify you here even when the arena is closed.'
      : 'The subscription could not be saved. Try again in a moment.');
    return stored;
  }

  async function disable() {
    if (!subscription) return true;
    await dropSubscription(subscription);
    subscription = null;
    setLabel('Enable notifications', false);
    setHint('Notifications are off. Messages will badge the tab, but nothing will alert you while the site is closed.');
    return true;
  }

  async function onClick() {
    if (busy) return;

    if (!signedIn()) {
      setHint('Sign in first — notifications belong to your account.');
      // utils.js opens modals with show(); a page that does not load it still
      // gets the modal, because that is all show() does.
      var modal = document.getElementById('modalLogin');
      if (modal) {
        if (typeof show === 'function') show(modal);
        else modal.style.display = 'flex';
      }
      return;
    }

    busy = true;
    setLabel('Working…');
    try {
      if (subscription) await disable();
      else await enable();
    } finally {
      busy = false;
      // The toggle above already told the server what happened; this is only
      // here to settle the button's label and hint.
      await refreshState({ resync: false });
    }
  }

  /**
   * Reflect what is really true: the browser's permission, and whether this
   * browser already has a subscription. Also re-sends an existing subscription
   * to the server, because endpoints rotate (browser update, restored profile)
   * and a stale record would mean notifications silently stop arriving.
   */
  async function refreshState(options) {
    var resync = !(options && options.resync === false);

    if (!supported() || !serverEnabled) {
      setVisible(false);
      return;
    }

    setVisible(true);

    if (Notification.permission === 'denied') {
      subscription = null;
      setLabel('Notifications blocked');
      setHint('Your browser is blocking notifications for this site.');
      return;
    }

    try {
      var reg = await registration();
      subscription = await reg.pushManager.getSubscription();
    } catch (err) {
      subscription = null;
    }

    if (subscription) {
      if (resync && signedIn()) {
        // Cheap and idempotent: the endpoint is the key, so this either refreshes
        // the record or re-creates it. Endpoints rotate — a browser update, a
        // restored profile — and a stale record means notifications quietly stop.
        registerSubscription(subscription).catch(function () {});
      }
      setLabel('Notifications on', true);
      setHint('A direct message will notify you here even when the arena is closed.');
    } else {
      setLabel('Enable notifications', false);
      setHint('Get alerted about a direct message even when the arena is closed.');
    }
  }

  if (!supported()) {
    setVisible(false);
    return;
  }

  buttons().forEach(function (btn) {
    btn.addEventListener('click', onClick);
  });

  setVisible(false); // hidden until the server says push is armed

  window.addEventListener('load', function () {
    loadServerConfig().then(refreshState);
  });

  // Signing in or out changes whether the button may be used at all.
  window.addEventListener('mcf:session', refreshState);

  window.mcfRefreshPushState = refreshState;
})();
