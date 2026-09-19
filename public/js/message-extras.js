/* ============================================================
   message-extras.js — the extras that ride on chat messages
   ------------------------------------------------------------
   One MutationObserver, zero edits to the renderers it decorates:

     • reactions   — an emoji bar on every arena / room message
                     (socket setReaction → reactionUpdate)
     • mentions    — @name in message text becomes a chip, and
                     your own name lights up; the server's
                     'mentioned' event toasts + pings
     • bookmarks   — save a message for later (its text is
                     copied server-side so it outlives the
                     retention sweep); one window lists them
     • reports     — report a message (or a member) to the
                     moderation queue from the message itself
     • unread      — a "new messages" divider + jump button in
                     the arena feed, tracked in localStorage
     • DM edit /
       delete      — hover actions on your own DMs (edit is
                     windowed server-side; delete leaves a
                     tombstone), live on both sides

   Works on the desktop page and the mobile page because both
   render the same .message-row markup — the observer decorates
   whatever appears.
=========================================================== */
(function () {
  'use strict';

  if (!window.MCF) return;

  var EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥', '💪', '😡'];
  var LAST_SEEN_KEY = 'mcf_public_last_seen';
  var OBSERVER_MAX_ROW_AGE_MS = 15 * 60 * 1000; // matches the server's edit window

  /* reactions state: scopeKey → messageId → { counts, byUser } */
  var reactionState = {};
  var pendingReactionFetch = null;

  function socket() { return window.socket || null; }
  function me() {
    var s = MCF.session();
    return s ? String(s.username).toLowerCase() : '';
  }

  function scopeKey(scope, room) {
    return scope + ':' + (room || '');
  }

  /* ============================================================
     ROW DECORATION (the observer)
  ============================================================ */

  function decorateRow(row) {
    highlightMentions(row);

    var feed = row.closest('.public-feed');
    var isRoomFeed = !!(feed && feed.id === 'roomFeed');
    var roomEl = document.getElementById('roomChatPopup');
    var roomId = isRoomFeed && roomEl ? roomEl.dataset.room : '';
    var scope = isRoomFeed ? 'room' : 'public';

    // Only the arena and room feeds carry reactions / bookmarks / reports —
    // DM rows get their own hover actions below. (The mobile DM feed shares
    // the .public-feed class but has a different id, so the id checks hold.)
    if (feed && (feed.id === 'publicFeed' || isRoomFeed)) {
      // Actions need the server id; a row that does not have one yet (the
      // sender's local echo) is re-decorated when the id lands, via the
      // attribute half of the observer below.
      if (row.dataset.id && !row.dataset.mcfExtras) {
        row.dataset.mcfExtras = '1';
        addRowActions(row, scope, roomId);
        addReactionBar(row, scope, roomId);
        scheduleReactionFetch(scope, roomId);
      }
      maybeMarkUnread(row);
    }

    decorateDmRow(row);
  }

  function addRowActions(row, scope, roomId) {
    if (!row.dataset.id) return;

    var messageEl = row.querySelector('.message');
    if (!messageEl) return;

    // Desktop rows already carry a .message-actions bar; mobile rows do not,
    // so one is added — same class, styled by features.css on both pages.
    var bar = messageEl.querySelector('.message-actions');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'message-actions mcf-actions-added';
      messageEl.appendChild(bar);
    }

    var react = document.createElement('button');
    react.type = 'button';
    react.className = 'msg-action mcf-action-react';
    react.textContent = '🙂 React';
    react.title = 'Add a reaction';
    bar.appendChild(react);

    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'msg-action mcf-action-bookmark';
    save.textContent = '🔖 Save';
    save.title = 'Bookmark this message';
    bar.appendChild(save);

    // Reporting your own message makes no sense.
    var author = rowAuthor(row);
    if (author && author.toLowerCase() !== me()) {
      var report = document.createElement('button');
      report.type = 'button';
      report.className = 'msg-action mcf-action-report';
      report.textContent = '⚠ Report';
      report.title = 'Report this message to the moderators';
      bar.appendChild(report);
      report.addEventListener('click', function () {
        openReportDialog({
          targetUser: author,
          scope: scope,
          room: roomId || null,
          messageId: row.dataset.id,
          snippet: rowText(row)
        });
      });
    }

    react.addEventListener('click', function () { toggleEmojiPicker(row); });
    save.addEventListener('click', async function () {
      save.disabled = true;
      var data = await MCF.postJSON('/api/bookmarks', {
        scope: scope,
        room: roomId || '',
        messageId: row.dataset.id
      });
      save.disabled = false;
      if (data && data.ok) MCF.toast('Message saved to your bookmarks', 'success');
      else MCF.toast('Could not save that message', 'error');
    });
  }

  function rowAuthor(row) {
    // Desktop rows render "@name • time" in a .small span; mobile rows the
    // same in .message-meta. The @-prefixed token is the username.
    var meta = row.querySelector('.small, .message-meta');
    if (!meta) return '';
    var match = /@([A-Za-z0-9._-]+)/.exec(meta.textContent || '');
    return match ? match[1] : '';
  }

  function rowText(row) {
    var textEl = row.querySelector('.message-text');
    if (!textEl) {
      // Mobile rows put the text in a bare div under .message-meta.
      var messageEl = row.querySelector('.message');
      if (!messageEl) return '';
      var candidate = messageEl.querySelectorAll('div');
      for (var i = 0; i < candidate.length; i++) {
        if (candidate[i].className === '' && candidate[i].textContent.trim()) return candidate[i].textContent.trim();
      }
      return '';
    }
    return textEl.textContent.trim();
  }

  /* ============================================================
     REACTIONS
  ============================================================ */

  function addReactionBar(row, scope, roomId) {
    if (!row.dataset.id) return;
    var messageEl = row.querySelector('.message');
    if (!messageEl || messageEl.querySelector('.mcf-reactions')) return;

    var bar = document.createElement('div');
    bar.className = 'mcf-reactions';
    bar.dataset.scope = scope;
    bar.dataset.room = roomId || '';
    bar.dataset.messageId = row.dataset.id;
    messageEl.appendChild(bar);
    renderReactionBar(bar);
  }

  function renderReactionBar(bar) {
    var key = scopeKey(bar.dataset.scope, bar.dataset.room);
    var entry = reactionState[key] && reactionState[key][bar.dataset.messageId];
    var counts = entry ? entry.counts : {};
    var mine = entry && entry.byUser ? entry.byUser[me()] : null;

    bar.innerHTML = '';
    Object.keys(counts).forEach(function (emoji) {
      if (!counts[emoji]) return;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mcf-reaction-chip' + (mine === emoji ? ' mcf-reaction-mine' : '');
      chip.textContent = emoji + ' ' + counts[emoji];
      chip.title = mine === emoji ? 'Click to remove your reaction' : 'Click to react';
      chip.addEventListener('click', function () {
        emitReaction(bar, emoji);
      });
      bar.appendChild(chip);
    });
    bar.style.display = counts && Object.keys(counts).length ? '' : 'none';
  }

  function toggleEmojiPicker(row) {
    var existing = row.querySelector('.mcf-emoji-picker');
    if (existing) {
      existing.remove();
      return;
    }

    var picker = document.createElement('div');
    picker.className = 'mcf-emoji-picker';
    EMOJI.forEach(function (emoji) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', function () {
        picker.remove();
        emitReaction(row, emoji);
      });
      picker.appendChild(btn);
    });

    var messageEl = row.querySelector('.message') || row;
    messageEl.appendChild(picker);
  }

  /**
   * Send a reaction toggle. Everything the server needs is derived from the
   * element: the row's data-id, and the feed it lives in (arena vs room).
   * The server toggles — sending your own current emoji removes it.
   */
  function emitReaction(element, emoji) {
    var row = element.closest ? element.closest('.message-row') : null;
    var bar = element.classList && element.classList.contains('mcf-reactions') ? element : null;

    var id = (bar && bar.dataset.messageId) || (row && row.dataset.id);
    if (!id) return;

    var scope, room = '';
    if (bar) {
      scope = bar.dataset.scope;
      room = bar.dataset.room || '';
    } else if (row) {
      var isRoom = !!(row.closest('#roomFeed'));
      scope = isRoom ? 'room' : 'public';
      if (isRoom) {
        var roomEl = document.getElementById('roomChatPopup');
        room = roomEl ? (roomEl.dataset.room || '') : '';
      }
    } else {
      return;
    }

    var s = socket();
    if (!s) return;
    s.emit('setReaction', { scope: scope, room: room, id: id, emoji: emoji || null });
  }

  function scheduleReactionFetch(scope, roomId) {
    if (pendingReactionFetch) clearTimeout(pendingReactionFetch);
    pendingReactionFetch = setTimeout(function () {
      pendingReactionFetch = null;
      fetchReactions(scope, roomId);
    }, 350);
  }

  async function fetchReactions(scope, roomId) {
    var feedId = scope === 'room' ? 'roomFeed' : 'publicFeed';
    var feed = document.getElementById(feedId);
    if (!feed) return;

    var ids = [];
    feed.querySelectorAll('.message-row[data-id]').forEach(function (row) {
      if (ids.indexOf(row.dataset.id) === -1) ids.push(row.dataset.id);
    });
    ids = ids.slice(-250); // the API caps a page at 250 ids
    if (!ids.length) return;

    var url = '/api/reactions?scope=' + encodeURIComponent(scope) +
      (scope === 'room' ? '&room=' + encodeURIComponent(roomId || '') : '') +
      '&ids=' + encodeURIComponent(ids.join(','));
    var data = await MCF.getJSON(url);
    if (!data || !data.ok) return;

    var key = scopeKey(scope, roomId);
    reactionState[key] = Object.assign({}, reactionState[key], data.reactions || {});
    document.querySelectorAll('.mcf-reactions').forEach(function (bar) {
      if (bar.dataset.scope === scope && (bar.dataset.room || '') === (roomId || '')) {
        renderReactionBar(bar);
      }
    });
  }

  function onReactionUpdate(payload) {
    if (!payload) return;
    var key = scopeKey(payload.scope, payload.room);
    if (!reactionState[key]) reactionState[key] = {};

    var previous = reactionState[key][payload.messageId] || { counts: {}, byUser: {} };
    var next = {
      counts: payload.counts || {},
      byUser: Object.assign({}, previous.byUser)
    };

    // The broadcast carries counts + who toggled, not the full byUser map. If
    // it was me, the emoji whose count grew is the one I just set; if every
    // count only shrank, I removed mine.
    if (payload.reactor === me()) {
      var grew = Object.keys(next.counts).find(function (emoji) {
        return (next.counts[emoji] || 0) > (previous.counts[emoji] || 0);
      });
      if (grew) next.byUser[me()] = grew;
      else delete next.byUser[me()];
    }

    reactionState[key][payload.messageId] = next;

    document.querySelectorAll('.mcf-reactions').forEach(function (bar) {
      if (bar.dataset.scope === payload.scope &&
          (bar.dataset.room || '') === (payload.room || '') &&
          bar.dataset.messageId === payload.messageId) {
        renderReactionBar(bar);
      }
    });
  }

  /* ============================================================
     MENTIONS
  ============================================================ */

  function highlightMentions(row) {
    if (row.dataset.mcfMentions) return;
    row.dataset.mcfMentions = '1';

    var containers = row.querySelectorAll('.message-text');
    if (!containers.length) {
      // Mobile rows: bare text div inside .message.
      var messageEl = row.querySelector('.message');
      if (messageEl) {
        messageEl.querySelectorAll('div').forEach(function (div) {
          if (!div.className && div.childElementCount === 0 && /@[A-Za-z0-9._-]/.test(div.textContent || '')) {
            containers = [div];
          }
        });
      }
    }

    var myName = me();
    containers.forEach(function (container) {
      var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);

      nodes.forEach(function (node) {
        var text = node.nodeValue;
        if (!text || text.indexOf('@') === -1) return;
        var regex = /@([A-Za-z0-9._-]{2,32})/g;
        var frag = document.createDocumentFragment();
        var last = 0;
        var match;
        while ((match = regex.exec(text)) !== null) {
          if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
          var chip = document.createElement('span');
          var isMe = match[1].toLowerCase() === myName;
          chip.className = 'mcf-mention' + (isMe ? ' mcf-mention-me' : '');
          chip.textContent = match[0];
          frag.appendChild(chip);
          last = match.index + match[0].length;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        if (frag.childNodes.length) node.parentNode.replaceChild(frag, node);
      });
    });
  }

  function onMentioned(payload) {
    if (!payload) return;
    var where = payload.where === 'arena' ? 'the arena' : (payload.where || 'a room');
    MCF.toast((payload.byDisplay || payload.by || 'Someone') + ' mentioned you in ' + where, 'info');
    try {
      if (typeof window.playPublicMessageSound === 'function') window.playPublicMessageSound();
    } catch (e) { /* sound is decoration */ }
  }

  /* ============================================================
     UNREAD MARKER (arena feed)
  ============================================================ */

  function lastSeen() {
    try { return Number(localStorage.getItem(LAST_SEEN_KEY)) || 0; } catch (e) { return 0; }
  }

  function setLastSeen(value) {
    try { localStorage.setItem(LAST_SEEN_KEY, String(value)); } catch (e) { /* ignore */ }
  }

  function maybeMarkUnread(row) {
    if (row.dataset.mcfUnreadChecked) return;
    row.dataset.mcfUnreadChecked = '1';

    var feed = document.getElementById('publicFeed');
    if (!feed || !feed.contains(row)) return;

    var time = Number(row.dataset.time) || 0;
    if (!time) return;
    var seen = lastSeen();

    // Everything newer than the last visit (and not our own) is unread. The
    // very first visit has no stamp, so nothing is marked — the feed is simply
    // "all new" and the divider would sit above the oldest message.
    if (!seen) {
      setLastSeen(time);
      return;
    }
    if (time <= seen) return;
    if (rowAuthor(row).toLowerCase() === me()) return;

    if (feed.querySelector('.mcf-unread-divider')) return; // one divider is enough

    var divider = document.createElement('div');
    divider.className = 'mcf-unread-divider';
    divider.textContent = '⟶ new messages';
    row.parentNode.insertBefore(divider, row);
    showJumpButton();
  }

  function showJumpButton() {
    var feed = document.getElementById('publicFeed');
    if (!feed || feed.querySelector('.mcf-jump-btn')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mcf-jump-btn';
    btn.textContent = '↓ Unread';
    btn.title = 'Jump to the first unread message';
    btn.addEventListener('click', function () {
      var divider = feed.querySelector('.mcf-unread-divider');
      if (divider) divider.scrollIntoView({ block: 'center' });
    });
    feed.parentNode.style.position = 'relative';
    feed.parentNode.appendChild(btn);
  }

  function clearUnreadMarker() {
    var feed = document.getElementById('publicFeed');
    if (!feed) return;
    var divider = feed.querySelector('.mcf-unread-divider');
    if (divider) divider.remove();
    var btn = feed.parentNode && feed.parentNode.querySelector('.mcf-jump-btn');
    if (btn) btn.remove();
  }

  function trackReading() {
    var feed = document.getElementById('publicFeed');
    if (!feed) return;
    feed.addEventListener('scroll', function () {
      var nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
      if (nearBottom && document.visibilityState === 'visible') {
        var newest = 0;
        feed.querySelectorAll('.message-row[data-time]').forEach(function (row) {
          newest = Math.max(newest, Number(row.dataset.time) || 0);
        });
        if (newest > lastSeen()) setLastSeen(newest);
        clearUnreadMarker();
      }
    }, { passive: true });
  }

  /* ============================================================
     DM EDIT / DELETE
  ============================================================ */

  function decorateDmRow(row) {
    var inDmFeed = !!(row.closest('#dmMessages') || (row.id && row.id.indexOf('pmBody_') === 0) ||
      (row.parentNode && row.parentNode.id && row.parentNode.id.indexOf('pmBody_') === 0));
    if (!inDmFeed) return;
    if (!row.classList.contains('me')) return;
    if (!row.dataset.dmId) return;
    if (row.querySelector('.mcf-dm-actions')) return;

    var actions = document.createElement('div');
    actions.className = 'mcf-dm-actions';

    // Edit only inside the server's window — after that the button would
    // always fail, which reads as broken.
    var time = Number(row.dataset.dmTime) || 0;
    if (time && Date.now() - time <= OBSERVER_MAX_ROW_AGE_MS && rowText(row)) {
      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mcf-dm-action mcf-dm-edit';
      edit.textContent = 'Edit';
      edit.title = 'Edit this message (15 minute window)';
      edit.addEventListener('click', function () { startDmEdit(row); });
      actions.appendChild(edit);
    }

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'mcf-dm-action mcf-dm-delete';
    del.textContent = 'Delete';
    del.title = 'Delete this message for both sides';
    del.addEventListener('click', async function () {
      if (!window.confirm('Delete this message for both sides?')) return;
      var s = socket();
      if (s) s.emit('deleteDM', { id: row.dataset.dmId });
    });
    actions.appendChild(del);

    row.appendChild(actions);
  }

  function startDmEdit(row) {
    if (row.querySelector('.mcf-dm-editor')) return;
    var textEl = row.querySelector('.message-text') || textContainer(row);
    if (!textEl) return;
    var current = textEl.textContent;

    var editor = document.createElement('div');
    editor.className = 'mcf-dm-editor';
    editor.innerHTML =
      '<input type="text" class="mcf-input" value="' + MCF.escapeHtml(current) + '">' +
      '<div class="mcf-row-actions">' +
        '<button type="button" class="small-btn mcf-dm-save">Save</button>' +
        '<button type="button" class="small-btn ghost mcf-dm-cancel">Cancel</button>' +
      '</div>';
    textEl.style.display = 'none';
    textEl.parentNode.insertBefore(editor, textEl);

    var input = editor.querySelector('input');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    function done() {
      editor.remove();
      textEl.style.display = '';
    }
    function save() {
      var text = input.value.trim();
      if (!text || text === current) { done(); return; }
      var s = socket();
      if (s) s.emit('editDM', { id: row.dataset.dmId, text: text });
      done();
    }

    editor.querySelector('.mcf-dm-save').addEventListener('click', save);
    editor.querySelector('.mcf-dm-cancel').addEventListener('click', done);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') done();
    });
  }

  function textContainer(row) {
    var messageEl = row.querySelector('.message') || row;
    var divs = messageEl.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
      if (!divs[i].className && divs[i].childElementCount === 0 && divs[i].textContent.trim()) return divs[i];
    }
    return null;
  }

  function onDmEdited(payload) {
    if (!payload || !payload.id) return;
    document.querySelectorAll('[data-dm-id="' + payload.id + '"]').forEach(function (row) {
      var textEl = row.querySelector('.message-text') || textContainer(row);
      if (textEl && payload.text) textEl.textContent = payload.text;
      if (!row.querySelector('.mcf-edited-marker')) {
        var marker = document.createElement('span');
        marker.className = 'mcf-edited-marker';
        marker.textContent = ' (edited)';
        row.appendChild(marker);
      }
    });
  }

  function onDmDeleted(payload) {
    if (!payload || !payload.id) return;
    document.querySelectorAll('[data-dm-id="' + payload.id + '"]').forEach(function (row) {
      row.classList.add('mcf-dm-tombstone');
      var textEl = row.querySelector('.message-text') || textContainer(row);
      if (textEl) textEl.textContent = 'message deleted';
      var img = row.querySelector('.chat-image');
      if (img) img.remove();
      var actions = row.querySelector('.mcf-dm-actions');
      if (actions) actions.remove();
    });
  }

  /* ============================================================
     REPORTS
  ============================================================ */

  var REASONS = [
    { id: 'harassment', label: 'Harassment / bullying' },
    { id: 'hate', label: 'Hate speech or slurs' },
    { id: 'spam', label: 'Spam or flooding' },
    { id: 'explicit', label: 'Explicit content in the wrong place' },
    { id: 'impersonation', label: 'Impersonating staff or a member' },
    { id: 'minor', label: 'Suspected minor (18+ site)' },
    { id: 'other', label: 'Something else' }
  ];

  function openReportDialog(opts) {
    opts = opts || {};
    var box = MCF.popup({ title: 'Report', label: 'Report a message or member' });

    box.body.innerHTML =
      (opts.targetUser
        ? '<p class="small muted">Reporting <b>@' + MCF.escapeHtml(opts.targetUser) + '</b>' +
          (opts.snippet ? ' for:</p><blockquote class="mcf-snippet">' + MCF.escapeHtml(opts.snippet.slice(0, 300)) + '</blockquote>' : '</p>')
        : '<p class="small muted">Tell the moderators what is wrong.</p>') +
      '<div class="mcf-field"><label>Reason</label>' +
        '<select id="mcfRepReason" class="mcf-input">' +
          REASONS.map(function (reason) {
            return '<option value="' + reason.id + '">' + MCF.escapeHtml(reason.label) + '</option>';
          }).join('') +
        '</select></div>' +
      '<div class="mcf-field"><label>Details <span class="small muted">(what happened, roughly when)</span></label>' +
        '<textarea id="mcfRepDetails" class="mcf-input" rows="4" maxlength="2000"></textarea></div>' +
      '<div class="mcf-row-actions"><button type="button" class="small-btn" id="mcfRepSend">Send report</button>' +
      '<span id="mcfRepStatus" class="small muted"></span></div>';

    box.body.querySelector('#mcfRepSend').addEventListener('click', async function () {
      var status = box.body.querySelector('#mcfRepStatus');
      status.textContent = 'Sending…';

      var data = await MCF.postJSON('/api/report', {
        kind: opts.targetUser ? 'user' : 'issue',
        targetUser: opts.targetUser || '',
        reason: box.body.querySelector('#mcfRepReason').value,
        scope: opts.scope || 'other',
        room: opts.room || null,
        messageId: opts.messageId || null,
        snippet: opts.snippet || null,
        details: box.body.querySelector('#mcfRepDetails').value
      });

      if (!data || !data.ok) {
        status.textContent = '';
        MCF.toast('Could not send the report', 'error');
        return;
      }
      MCF.toast('Report sent — the moderators will review it', 'success');
      box.close();
    });
  }

  /* ============================================================
     BOOKMARKS WINDOW
  ============================================================ */

  async function openBookmarks() {
    var s = MCF.session();
    if (!s) {
      MCF.toast('Sign in to see your bookmarks', 'error');
      return;
    }

    var box = MCF.popup({ title: 'Saved messages', label: 'Bookmarked messages', wide: true });
    box.body.innerHTML = '<p class="small muted">Loading…</p>';

    var data = await MCF.getJSON('/api/bookmarks');
    if (!data || !data.ok) {
      box.body.innerHTML = '<p class="small muted">Could not load your bookmarks.</p>';
      return;
    }

    box.body.innerHTML = '';
    if (!(data.bookmarks || []).length) {
      box.body.innerHTML = '<p class="small muted">Nothing saved yet — the 🔖 button under a message keeps a copy here, even after the chat history is pruned.</p>';
      return;
    }

    data.bookmarks.forEach(function (bookmark) {
      var el = document.createElement('div');
      el.className = 'mcf-bookmark-row';
      el.innerHTML =
        '<div class="mcf-bookmark-main">' +
          '<div class="small muted">@' + MCF.escapeHtml(bookmark.from || '?') +
            ' · ' + (bookmark.scope === 'room' ? 'room' : 'arena') +
            ' · ' + MCF.dateLabel(bookmark.time || bookmark.createdAt) + '</div>' +
          '<div>' + MCF.escapeHtml((bookmark.text || '').slice(0, 300)) + '</div>' +
        '</div>' +
        '<div class="mcf-bookmark-actions">' +
          '<button type="button" class="small-btn ghost mcf-bookmark-remove" data-id="' + bookmark._id + '">Remove</button>' +
        '</div>';
      box.body.appendChild(el);
    });

    box.body.addEventListener('click', async function (e) {
      var btn = e.target.closest('.mcf-bookmark-remove');
      if (!btn) return;
      btn.disabled = true;
      await MCF.postJSON('/api/bookmarks/' + btn.dataset.id, {}, 'DELETE');
      var row = btn.closest('.mcf-bookmark-row');
      if (row) row.remove();
    });
  }

  /* ============================================================
     BOOT
  ============================================================ */

  var observer = null;

  function scan(root) {
    (root || document).querySelectorAll('.message-row, .message').forEach(decorateRow);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];

        // Rows appearing: decorate whatever showed up.
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var node = mutation.addedNodes[j];
          if (node.nodeType !== 1) continue;
          if (node.classList && (node.classList.contains('message-row') || node.classList.contains('message'))) {
            decorateRow(node);
          } else if (node.querySelectorAll) {
            scan(node);
          }
        }

        // Attributes: a row that gained its server id (the sender's local
        // echo) or its DM id/time becomes decorateable now.
        if (mutation.type === 'attributes' && mutation.target.nodeType === 1) {
          decorateRow(mutation.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributeFilter: ['data-id', 'data-dm-id', 'data-dm-time', 'data-time']
    });
    scan(document);
  }

  function bind() {
    var btn = document.getElementById('btnBookmarks');
    if (btn) btn.addEventListener('click', openBookmarks);

    // The full-profile modal's Report button (desktop page).
    var vpReport = document.getElementById('vpReportButton');
    if (vpReport) {
      vpReport.addEventListener('click', function () {
        var nameEl = document.getElementById('vpUsername');
        var username = nameEl ? String(nameEl.textContent || '').trim() : '';
        if (username) window.MCFMessageExtras.reportUser(username);
      });
    }

    var s = socket();
    if (s) {
      s.on('reactionUpdate', onReactionUpdate);
      s.on('mentioned', onMentioned);
      s.on('dmEdited', onDmEdited);
      s.on('dmDeleted', onDmDeleted);
      s.on('roomKicked', function (payload) {
        MCF.toast('You were removed from that room by the owner', 'info');
      });
      s.on('roomMessageRejected', function (payload) {
        if (!payload) return;
        if (payload.reason === 'muted') {
          MCF.toast('You are muted in that room' + (payload.until ? ' until ' + new Date(payload.until).toLocaleTimeString() : ''), 'error');
        } else if (payload.reason === 'slow_mode') {
          var seconds = Math.ceil((payload.retryAfterMs || 0) / 1000);
          MCF.toast('Slow mode is on — wait ' + seconds + 's between messages', 'error');
        }
      });
    }

    startObserver();
    trackReading();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFMessageExtras = {
    openBookmarks: openBookmarks,
    openReportDialog: openReportDialog,
    reportUser: function (username) {
      openReportDialog({ targetUser: username, scope: 'profile' });
    }
  };
})();
