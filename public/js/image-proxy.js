/* image-proxy.js -------------------------------------------------------------
 * Loads ImgBB / Discord images directly first, then retries a failed image once
 * through our same-origin `/img` proxy.
 *
 * The direct-first path is intentional. Some hosting networks (including the
 * app host) cannot reliably open ImgBB's image CDN from a server process, even
 * though the visitor's browser can. Sending every image through `/img` made a
 * slow CDN connection turn into a burst of 15-second AbortErrors and blank
 * avatars. A browser that hits Firefox's OpaqueResponseBlocking (or another
 * direct-load error) still gets the same-origin proxy fallback.
 *
 * This file must be loaded before any script that renders images.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var PROXY_HOSTS = [
    'ibb.co',
    'i.ibb.co',
    'image.ibb.co',
    'cdn.discordapp.com',
    'media.discordapp.net'
  ];

  function shouldProxy(hostname) {
    var host = String(hostname || '').toLowerCase();
    if (PROXY_HOSTS.indexOf(host) !== -1) return true;
    return host.length > 7 && host.slice(-7) === '.ibb.co';
  }

  function rawImageValue(value) {
    return value == null ? '' : String(value).trim();
  }

  /**
   * Return the initial URL for an image. Remote HTTPS images stay direct so a
   * server-side CDN outage cannot prevent browsers from loading them.
   *
   * @param {string} value raw image URL from the API/socket payload
   * @returns {string} a URL that is safe to put in an <img src>
   */
  function safeImageUrl(value) {
    var raw = rawImageValue(value);
    if (!raw) return '';

    // Existing user records can contain inline images. Reject non-image data
    // URLs rather than passing arbitrary data payloads into the DOM.
    if (raw.indexOf('data:image/') === 0 || raw.indexOf('blob:') === 0) return raw;

    var url;
    try {
      url = new URL(raw, window.location.origin);
    } catch (_) {
      return '';
    }

    if (url.origin === window.location.origin) return url.href;
    if (url.protocol !== 'https:') return '';
    return url.href;
  }

  /**
   * Build the same-origin fallback for a supported remote image URL.
   * Unsupported/local URLs return an empty string and are never proxied.
   */
  function proxyImageUrl(value) {
    var raw = rawImageValue(value);
    if (!raw || raw.indexOf('data:') === 0 || raw.indexOf('blob:') === 0) return '';

    var url;
    try {
      url = new URL(raw, window.location.origin);
    } catch (_) {
      return '';
    }

    if (url.origin === window.location.origin) return '';
    if (url.protocol !== 'https:' || !shouldProxy(url.hostname)) return '';
    return '/img?u=' + encodeURIComponent(url.href);
  }

  window.safeImageUrl = safeImageUrl;
  window.proxyImageUrl = proxyImageUrl;
  // Short alias used by the render helpers in chat/profile/pm scripts.
  window.imgSrc = safeImageUrl;

  /*
   * If a direct ImgBB/Discord request is blocked, retry it once through the
   * application proxy. The marker prevents a failed proxy response from
   * creating an error loop.
   */
  document.addEventListener(
    'error',
    function (event) {
      var el = event.target;
      if (!el || el.tagName !== 'IMG') return;
      if (el.dataset && el.dataset.proxyRetried === '1') return;

      var proxied = proxyImageUrl(el.getAttribute('src'));
      if (!proxied) return;

      if (el.dataset) el.dataset.proxyRetried = '1';
      el.referrerPolicy = 'no-referrer';
      el.src = proxied;
    },
    true
  );
})();
