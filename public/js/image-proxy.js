/* image-proxy.js -------------------------------------------------------------
 * Rewrites remote image URLs (ImgBB / Discord CDN) to our same-origin `/img`
 * proxy.
 *
 * Why: those hosts sit behind Cloudflare and occasionally answer a hotlinked
 * <img> request with an HTML challenge or error page. Firefox then reports
 *   "A resource is blocked by OpaqueResponseBlocking"
 * and drops the response, and the third-party "__cf_bm" cookie is rejected for
 * an invalid domain. Loading the bytes through our own origin removes the
 * cross-origin no-cors request entirely, so ORB never applies.
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

  /**
   * @param {string} value raw image URL from the API/socket payload
   * @returns {string} a URL that is safe to put in an <img src>
   */
  function safeImageUrl(value) {
    var raw = value == null ? '' : String(value).trim();
    if (!raw) return '';

    // Already local, inline, or blob data — nothing to do.
    if (raw.indexOf('data:') === 0 || raw.indexOf('blob:') === 0) return raw;
    if (raw.indexOf('/img?u=') === 0) return raw;

    var url;
    try {
      url = new URL(raw, window.location.origin);
    } catch (_) {
      return raw;
    }

    if (url.origin === window.location.origin) return url.href;
    if (url.protocol !== 'https:') return raw;
    if (!shouldProxy(url.hostname)) return raw;

    return '/img?u=' + encodeURIComponent(url.href);
  }

  window.safeImageUrl = safeImageUrl;
  // Short alias used by the render helpers in chat/profile/pm scripts.
  window.imgSrc = safeImageUrl;

  /*
   * Safety net: if any render path we missed (or cached HTML from the service
   * worker) still points an <img> straight at a remote host, retry it once
   * through the proxy instead of leaving the user with a broken image.
   */
  document.addEventListener(
    'error',
    function (event) {
      var el = event.target;
      if (!el || el.tagName !== 'IMG') return;
      if (el.dataset && el.dataset.proxyRetried === '1') return;

      var proxied = safeImageUrl(el.getAttribute('src'));
      if (!proxied || proxied === el.getAttribute('src')) return;

      if (el.dataset) el.dataset.proxyRetried = '1';
      el.referrerPolicy = 'no-referrer';
      el.src = proxied;
    },
    true
  );
})();
