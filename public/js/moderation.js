/* ============================================================
   moderation.js — the staff tools for moderator/admin roles
   ------------------------------------------------------------
   Members holding the `moderator` or `admin` role (and the
   Administrator account) get extra controls wherever messages
   are rendered:

     • Delete — remove a message from the arena, a room, a DM
                conversation or the forums (server re-checks the
                role on every action; these buttons are
                convenience, not authority)
     • Warn   — record a warning on the member's account and
                notify them on every live session
     • Timeout — block the member from sending ANY message
                (arena, rooms, DMs) for a chosen duration,
                with presets plus a custom length in minutes

   One MutationObserver decorates whatever rows appear — the
   same pattern message-extras.js uses — so no renderer had to
   change. The enforcement itself lives server-side (index.js +
   moderation.js), where every send is checked against the
   member's live timeout.
============================================================ */
(function () {
  'use strict';

  if (!window.MCF) return;

  /* Mirrors moderation.js on the server — same ids, same seconds. */
  var TIMEOUT_PRESETS = [
    { id: '5m', label: '5 min', seconds: 300 },
    { id: '30m', label: '30 min', seconds: 1800 },
    { id: '1h', label: '1 hour', seconds: 3600 },
    { id: '24h', label: '24 hours', seconds: 86400 },
    { id: '7d', label: '7 days', seconds: 604800 }
  ];

  var timeoutTarget = '';   // whose timeout the modal is editing
  var observer = null;

  function socket() { return window.socket || null; }
  function session() { return MCF.session(); }
  function me() {
    var s = session();
    return s ? String(s.username || '') : '';
  }

  function isStaff() {
    var s = session();
    if (!s) return false;
    if (typeof window.isStaffUser === 'function') return window.isStaffUser(s);
    var role = String(s.role || '').toLowerCase();
    return role === 'admin' || role === 'moderator' ||
      String(s.username || '').trim() === 'Administrator';
  }

  function timeLabel(value) {
    try { return new Date(value).toLocaleString(); } catch (e) { return ''; }
  }

  function durationLabel(ms) {
    var minutes = Math.max(1, Math.ceil(ms / 60000));
    if (minutes < 60) return minutes + ' minute' + (minutes === 1 ? '' : 's');
    var hours = Math.ceil(minutes / 60);
    if (hours < 48) return hours + ' hour' + (hours === 1 ? '' : 's');
    var days = Math.ceil(hours / 24);
    return days + ' day' + (days === 1 ? '' : 's');
  }

  /* ============================================================
     ROW DECORATION
  ============================================================ */

  function rowAuthor(row) {
    var meta = row.querySelector('.small, .message-meta');
    if (meta) {
      var match = /@([A-Za-z0-9._-]+)/.exec(meta.textContent || '');
      if (match) return match[1];
    }
    return '';
  }

  function actionsBar(row) {
    var messageEl = row.querySelector('.message');
    if (!messageEl) return null;
    var bar = messageEl.querySelector('.message-actions');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'message-actions mcf-actions-added';
      messageEl.appendChild(bar);
    }
    return bar;
  }

  function modButton(label, title, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-action mcf-mod-action';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /* Arena + room rows: `.message-row[data-id]` inside the two feeds. */
  function decorateChatRow(row) {
    var feed = row.closest('.public-feed');
    if (!feed) return;
    var isRoom = feed.id === 'roomFeed';
    if (!isRoom && feed.id !== 'publicFeed') return;
    if (!row.dataset.id || row.dataset.mcfMod) return;

    var scope = isRoom ? 'room' : 'public';
    var author = rowAuthor(row);
    row.dataset.mcfMod = '1';

    var bar = actionsBar(row);
    if (!bar) return;

    bar.appendChild(modButton(
      '🗑 Delete',
      'Staff: delete this message for everyone',
      function () { deleteMessage(scope, row.dataset.id, row); }
    ));

    if (author && author.toLowerCase() !== me().toLowerCase()) {
      bar.appendChild(modButton('⚠ Warn', 'Staff: warn @' + author, function () {
        warnMember(author);
      }));
      bar.appendChild(modButton('⏱ Timeout', 'Staff: timeout @' + author, function () {
        openTimeoutModal(author);
      }));
    }
  }

  /* DM rows: `.message[data-dm-id]` inside a pmBody_* window. */
  function decorateDmRow(row) {
    if (!row.dataset.dmId || row.dataset.mcfMod) return;
    if (row.classList.contains('system')) return;
    var parent = row.parentNode;
    var inDmFeed = !!(parent && parent.id && parent.id.indexOf('pmBody_') === 0);
    if (!inDmFeed) return;

    row.dataset.mcfMod = '1';

    var actions = document.createElement('div');
    actions.className = 'mcf-dm-actions';
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'mcf-dm-action mcf-mod-action';
    del.textContent = 'Staff delete';
    del.title = 'Staff: delete this DM for both sides';
    del.addEventListener('click', function () { deleteMessage('dm', row.dataset.dmId, row); });
    actions.appendChild(del);
    row.appendChild(actions);
  }

  /* Forum posts: `.forum-post[data-post-id]` (thread card or reply). */
  function decorateForumPost(article) {
    if (!article.dataset.postId || article.dataset.mcfMod) return;
    article.dataset.mcfMod = '1';

    var isThread = article.classList.contains('forum-original-card');
    var meta = article.querySelector('.forum-post-meta');
    var host = meta || article;

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'small-btn ghost mcf-mod-action mcf-forum-delete';
    del.textContent = isThread ? 'Staff: delete thread' : 'Staff: delete';
    del.title = isThread
      ? 'Staff: delete this thread and all its responses'
      : 'Staff: delete this response';
    del.addEventListener('click', function () {
      if (isThread) deleteForumThread(article.dataset.postId);
      else deleteForumReply(article.dataset.forumId, article.dataset.postId);
    });
    host.appendChild(del);
  }

  function decorateRow(node) {
    if (!isStaff()) return;
    if (node.nodeType !== 1) return;

    if (node.classList) {
      if (node.classList.contains('message-row')) decorateChatRow(node);
      if (node.classList.contains('message') && node.dataset.dmId) decorateDmRow(node);
      if (node.classList.contains('forum-post')) decorateForumPost(node);
    }

    // Nodes inserted wholesale (a rebuilt feed, a rendered thread) carry rows
    // inside them — decorate those too.
    if (node.querySelectorAll) {
      node.querySelectorAll('.message-row').forEach(decorateChatRow);
      node.querySelectorAll('.message[data-dm-id]').forEach(decorateDmRow);
      node.querySelectorAll('.forum-post').forEach(decorateForumPost);
    }
  }

  function scanAll() {
    if (!isStaff()) return;
    document.querySelectorAll('.message-row').forEach(decorateChatRow);
    document.querySelectorAll('.message[data-dm-id]').forEach(decorateDmRow);
    document.querySelectorAll('.forum-post').forEach(decorateForumPost);
  }

  function startObserver() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(function (mutations) {
      if (!isStaff()) return;
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        if (mutation.type === 'childList') {
          for (var j = 0; j < mutation.addedNodes.length; j++) {
            decorateRow(mutation.addedNodes[j]);
          }
        } else if (mutation.type === 'attributes' && mutation.target.dataset) {
          // A row that gained its server id after the local echo deserves
          // its buttons too.
          decorateRow(mutation.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributeFilter: ['data-id', 'data-dm-id', 'data-post-id']
    });
    scanAll();
  }

  /* ============================================================
     ACTIONS
  ============================================================ */

  function deleteMessage(scope, id, row) {
    var s = socket();
    if (!s || !id) return;
    var where = scope === 'public' ? 'the arena'
      : scope === 'room' ? 'this room'
      : 'both sides of this conversation';
    if (!window.confirm('Delete this message for everyone in ' + where + '?')) return;
    s.emit('modDeleteMessage', { scope: scope, id: id });
  }

  function warnMember(username) {
    var s = socket();
    if (!s || !username) return;
    var reason = window.prompt('Warning for @' + username + '\n\nReason (optional, shown to the member):', '');
    if (reason === null) return; // cancelled
    s.emit('modWarnUser', { target: username, reason: reason });
  }

  function deleteForumThread(forumId) {
    if (!forumId) return;
    if (!window.confirm('Delete this whole thread and all its responses?')) return;
    MCF.authFetch('/api/forums/' + encodeURIComponent(forumId), { method: 'DELETE' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok) MCF.toast('Thread deleted', 'success');
        else MCF.toast('Could not delete that thread' + (data && data.error ? ' (' + data.error + ')' : ''), 'error');
      })
      .catch(function () { MCF.toast('Could not delete that thread', 'error'); });
  }

  function deleteForumReply(forumId, replyId) {
    if (!forumId || !replyId) return;
    if (!window.confirm('Delete this response?')) return;
    MCF.authFetch('/api/forums/' + encodeURIComponent(forumId) + '/replies/' + encodeURIComponent(replyId), { method: 'DELETE' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok) MCF.toast('Response deleted', 'success');
        else MCF.toast('Could not delete that response' + (data && data.error ? ' (' + data.error + ')' : ''), 'error');
      })
      .catch(function () { MCF.toast('Could not delete that response', 'error'); });
  }

  /* ============================================================
     TIMEOUT MODAL
  ============================================================ */

  function $(id) { return document.getElementById(id); }

  function openTimeoutModal(username) {
    if (!username) return;
    timeoutTarget = username;

    var targetEl = $('modTimeoutTarget');
    if (targetEl) targetEl.textContent = '@' + username + ' will be unable to send any message (arena, rooms, DMs) until the timeout ends.';

    var errorEl = $('modTimeoutError');
    if (errorEl) errorEl.style.display = 'none';
    var customEl = $('modTimeoutCustom');
    if (customEl) customEl.value = '';

    var presetsEl = $('modTimeoutPresets');
    if (presetsEl) {
      presetsEl.innerHTML = '';
      TIMEOUT_PRESETS.forEach(function (preset) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'small-btn';
        btn.textContent = preset.label;
        btn.addEventListener('click', function () { applyTimeout(preset.seconds); });
        presetsEl.appendChild(btn);
      });
    }

    // Ask the server for the member's record: an active timeout is shown
    // with a Lift button.
    var currentEl = $('modTimeoutCurrent');
    if (currentEl) currentEl.style.display = 'none';
    var liftEl = $('modTimeoutLift');
    if (liftEl) liftEl.style.display = 'none';
    var s = socket();
    if (s) s.emit('modGetRecord', { target: username });

    var modal = $('modalModTimeout');
    if (modal) modal.style.display = 'flex';
  }

  function closeTimeoutModal() {
    timeoutTarget = '';
    var modal = $('modalModTimeout');
    if (modal) modal.style.display = 'none';
  }

  function applyTimeout(seconds) {
    var s = socket();
    if (!s || !timeoutTarget || !seconds) return;
    var errorEl = $('modTimeoutError');
    s.emit('modTimeoutUser', { target: timeoutTarget, seconds: seconds });
    if (errorEl) errorEl.style.display = 'none';
  }

  function onModRecord(payload) {
    if (!payload || !payload.ok) return;
    if (String(payload.target || '') !== timeoutTarget) return;

    var currentEl = $('modTimeoutCurrent');
    var liftEl = $('modTimeoutLift');
    var warnings = Array.isArray(payload.warnings) ? payload.warnings : [];

    var parts = [];
    if (payload.mutedUntil) {
      parts.push('Currently timed out until ' + timeLabel(payload.mutedUntil) + '.');
      if (liftEl) liftEl.style.display = '';
    } else if (liftEl) {
      liftEl.style.display = 'none';
    }
    parts.push(warnings.length
      ? warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') + ' on record.'
      : 'No warnings on record.');

    if (currentEl) {
      currentEl.textContent = parts.join(' ');
      currentEl.style.display = '';
    }
  }

  /* ============================================================
     INCOMING EVENTS
  ============================================================ */

  function removeRowById(feedId, id) {
    var feed = document.getElementById(feedId);
    if (!feed || !id) return;
    var rows = feed.querySelectorAll('.message-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.id === String(id)) {
        rows[i].remove();
        return;
      }
    }
  }

  function updateSessionMutedUntil(until) {
    try {
      if (typeof getSession !== 'function' || typeof setSession !== 'function') return;
      var s = getSession();
      if (!s) return;
      s.mutedUntil = until || null;
      setSession(s);
    } catch (e) { /* a session-less page simply skips the bookkeeping */ }
  }

  function bind() {
    var s = socket();
    if (s) {
      s.on('publicMessageDeleted', function (payload) {
        if (payload && payload._id) removeRowById('publicFeed', payload._id);
      });

      s.on('roomMessageDeleted', function (payload) {
        if (payload && payload._id) removeRowById('roomFeed', payload._id);
      });

      // A moderator/admin acted on THIS member.
      s.on('moderated', function (payload) {
        if (!payload) return;
        var by = payload.by ? ' by @' + payload.by : '';
        if (payload.type === 'warning') {
          var reason = payload.reason ? '\n\nReason: ' + payload.reason : '';
          window.alert('You have received a warning from the moderation team' + by + '.' + reason);
        } else if (payload.type === 'timeout') {
          updateSessionMutedUntil(payload.until);
          var untilText = payload.until ? ' until ' + timeLabel(payload.until) : '';
          window.alert('You have been timed out' + by + untilText + '.\n\nYou cannot send messages (arena, rooms or DMs) while the timeout is active.');
        } else if (payload.type === 'timeout_lifted') {
          updateSessionMutedUntil(null);
          MCF.toast('Your timeout has been lifted — you can send messages again.', 'success');
        }
      });

      // This member tried to send while timed out.
      s.on('messageBlocked', function (payload) {
        if (!payload || payload.reason !== 'timed_out') return;

        // The arena renders the sender's message optimistically before the
        // server answers; pull that echo back so a blocked send does not
        // linger in the feed. Rooms and DMs wait for the server broadcast,
        // so they have nothing to remove.
        if (payload.scope === 'public') {
          var feed = document.getElementById('publicFeed');
          if (feed) {
            var rows = feed.querySelectorAll('.message-row.me');
            for (var i = rows.length - 1; i >= 0; i--) {
              if (!rows[i].dataset.id) { rows[i].remove(); break; }
            }
          }
        }

        var left = payload.remainingMs ? durationLabel(payload.remainingMs) : '';
        MCF.toast('You are timed out and cannot send messages' + (left ? ' for another ' + left : '') + '.', 'error');
      });

      // Confirmation of a staff action taken by this socket.
      s.on('modActionResult', function (payload) {
        if (!payload) return;
        if (payload.ok) {
          if (payload.action === 'delete') MCF.toast('Message deleted', 'success');
          if (payload.action === 'warn') MCF.toast('Warning recorded for @' + (payload.target || ''), 'success');
          if (payload.action === 'timeout') {
            closeTimeoutModal();
            MCF.toast(payload.until
              ? '@' + (payload.target || '') + ' timed out until ' + timeLabel(payload.until)
              : 'Timeout lifted for @' + (payload.target || ''), 'success');
          }
        } else {
          var reason = payload.error === 'not_allowed'
            ? 'you no longer have permission for that action'
            : payload.error === 'not_found'
              ? 'that member or message no longer exists'
              : 'the action was refused' + (payload.error ? ' (' + payload.error + ')' : '');
          MCF.toast('Moderation action failed: ' + reason, 'error');
        }
      });

      s.on('modRecord', onModRecord);
    }

    /* Timeout modal wiring */
    var cancel = $('modTimeoutCancel');
    if (cancel) cancel.addEventListener('click', closeTimeoutModal);

    var lift = $('modTimeoutLift');
    if (lift) lift.addEventListener('click', function () { applyTimeout(0); });

    var customApply = $('modTimeoutCustomApply');
    if (customApply) {
      customApply.addEventListener('click', function () {
        var input = $('modTimeoutCustom');
        var minutes = Number(input ? input.value : NaN);
        var errorEl = $('modTimeoutError');
        if (!isFinite(minutes) || minutes <= 0) {
          if (errorEl) {
            errorEl.textContent = 'Enter a length in minutes (1 or more).';
            errorEl.style.display = '';
          }
          return;
        }
        applyTimeout(Math.round(minutes * 60));
      });
    }
    var customInput = $('modTimeoutCustom');
    if (customInput) {
      customInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && customApply) customApply.click();
      });
    }

    /* A staff member signing in after the page rendered still gets buttons:
       rescan once the session is announced. */
    document.addEventListener('mcf:session', function () {
      scanAll();
    });

    startObserver();

    // Signed in already timed out? Say so once, so the blocked send is not
    // the first the member hears of it.
    var sess = session();
    if (sess && sess.mutedUntil && new Date(sess.mutedUntil) > new Date()) {
      MCF.toast('You are timed out until ' + timeLabel(sess.mutedUntil) + ' and cannot send messages.', 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
