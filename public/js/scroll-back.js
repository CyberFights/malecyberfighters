/*
 * Scroll-back pagination — let a member walk backwards through history.
 *
 * Both the arena feed and a DM window open on the newest page of messages,
 * which is the right thing to show and the wrong thing to stop at: before this,
 * scrolling up simply ran out of messages, and everything older than the first
 * page was unreachable from the client.
 *
 * This is the shared half of that fix. It owns the parts both feeds need to get
 * right and are easy to get wrong — the cursor, the "am I already loading"
 * guard, the end-of-history state, and above all keeping the reader's place
 * stable. Prepending a page of older messages grows the content above the
 * viewport, which without compensation shoves the message you were reading off
 * the bottom of the screen; the height delta is added back to scrollTop so the
 * page appears to stay exactly where it was.
 *
 * The feeds own their markup. This module never builds a message row; it is
 * handed a `prepend` callback and a `load` callback and stays out of the DOM
 * apart from the small bar it is pointed at.
 */
(function () {
  'use strict';

  var DEFAULT_THRESHOLD = 48;

  function createScrollBack(options) {
    var opts = options || {};
    var scroller = opts.scroller;
    var load = opts.load;
    var prepend = opts.prepend;
    var threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
    var label = opts.label || 'Load earlier messages';

    var ui = opts.ui || {};
    var bar = ui.bar || null;
    var button = ui.button || null;
    var status = ui.status || null;

    var oldest = null;
    var hasMore = false;
    var loading = false;
    var destroyed = false;

    if (!scroller || typeof load !== 'function' || typeof prepend !== 'function') {
      // Nothing to page: hand back an inert controller so callers need no guards.
      return { reset: function () {}, loadOlder: function () {}, destroy: function () {} };
    }

    function setStatus(text) {
      if (status) status.textContent = text || '';
    }

    function renderUi() {
      if (bar) bar.hidden = !hasMore && !loading;
      if (button) {
        button.disabled = loading || !hasMore;
        button.textContent = loading ? 'Loading…' : label;
      }
      if (!loading && !hasMore) setStatus('');
    }

    async function loadOlder() {
      if (destroyed || loading || !hasMore) return false;

      loading = true;
      renderUi();
      setStatus('Loading earlier messages…');

      var page;
      try {
        page = await load(oldest);
      } catch (err) {
        loading = false;
        renderUi();
        setStatus('Could not load earlier messages. Try again.');
        return false;
      }

      if (destroyed) return false;

      var messages = (page && page.messages) || [];

      if (messages.length) {
        // Keep the reader's place: whatever was on screen stays on screen.
        var prevHeight = scroller.scrollHeight;
        var prevTop = scroller.scrollTop;
        var wasAtBottom = prevHeight - prevTop - scroller.clientHeight < threshold;

        try {
          prepend(messages);
        } catch (err) {
          // A render failure must not leave the controller stuck "loading".
          loading = false;
          renderUi();
          setStatus('Could not display earlier messages.');
          return false;
        }

        var delta = scroller.scrollHeight - prevHeight;
        // Only hold position for a reader who is scrolling up. Someone parked at
        // the bottom is watching live messages and should stay at the bottom.
        scroller.scrollTop = wasAtBottom ? scroller.scrollHeight : prevTop + delta;
      }

      oldest = (page && page.oldest) || null;
      // Trust the server's answer, but never claim more history than a page
      // that came back short could possibly have.
      hasMore = !!(page && page.hasMore) && messages.length > 0;
      loading = false;

      renderUi();
      setStatus(hasMore ? '' : "That's the beginning of the history on this device.");
      return messages.length > 0;
    }

    function onScroll() {
      if (destroyed || loading || !hasMore) return;
      if (scroller.scrollTop <= threshold) loadOlder();
    }

    function onClick(event) {
      if (event) event.preventDefault();
      loadOlder();
    }

    scroller.addEventListener('scroll', onScroll, { passive: true });
    if (button) button.addEventListener('click', onClick);

    return {
      /** Called after a fresh first page is rendered. */
      reset: function (state) {
        oldest = (state && state.oldest) || null;
        hasMore = !!(state && state.hasMore);
        loading = false;
        renderUi();
        setStatus('');
      },
      loadOlder: loadOlder,
      destroy: function () {
        destroyed = true;
        scroller.removeEventListener('scroll', onScroll);
        if (button) button.removeEventListener('click', onClick);
        if (bar) bar.hidden = true;
        setStatus('');
      }
    };
  }

  window.MCFScrollBack = { create: createScrollBack };
})();
