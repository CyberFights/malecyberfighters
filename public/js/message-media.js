/* ============================================================
   message-media.js — ✨ Visualize a chat message
   ------------------------------------------------------------
   One MutationObserver decorates .message-row / .message markup in
   the arena, custom rooms and DMs on desktop AND mobile. Clicking the
   action opens a modal that:

     1. asks the server to refine the STORED message into a proper
        image/video generator prompt (the browser never supplies the
        message text as authority);
     2. lets the member edit that prompt, choose output type, style
        and aspect ratio, or copy it for an external generator;
     3. generates the media and posts it back into the same chat —
        the server broadcasts it over the existing socket events, so
        every open client in that conversation sees it live.

   The server re-checks membership, moderation, prompt safety and
   returned bytes. This file is presentation only.
=========================================================== */
(function () {
  'use strict';

  if (!window.MCF) return;

  var API = '/api/message-media';
  var DEFAULT_STYLES = [
    { id: 'cinematic', label: 'Cinematic' },
    { id: 'photoreal', label: 'Photorealistic' },
    { id: 'comic', label: 'Comic book' },
    { id: 'anime', label: 'Anime' },
    { id: '3d', label: '3D render' },
    { id: 'cyberpunk', label: 'Neon cyberpunk' },
    { id: 'painting', label: 'Digital painting' }
  ];
  var DEFAULT_RATIOS = [
    { id: '1:1', label: 'Square (1:1)' },
    { id: '16:9', label: 'Landscape (16:9)' },
    { id: '9:16', label: 'Portrait (9:16)' },
    { id: '4:3', label: 'Classic (4:3)' }
  ];
  var ERRORS = {
    auth_required: 'Sign in to generate AI media.',
    invalid_scope: 'That chat is not supported.',
    invalid_media_type: 'Choose an image or a video.',
    invalid_target: 'That message could not be found. Try a newer message.',
    invalid_room: 'Open the room before generating from its messages.',
    not_found: 'That message no longer exists.',
    not_your_room: 'You do not have access to that room.',
    recipient_blocked: 'You cannot post generated media in that conversation.',
    not_visualizable: 'Pick a normal text message, not a system or AI-generated one.',
    empty_source: 'That message has no text to visualize.',
    empty_prompt: 'Write a generator prompt first.',
    unsafe_prompt: 'That prompt asks for content the generator cannot produce. Remove it and try again.',
    timed_out: 'A staff timeout is active on your account.',
    muted: 'You are muted in that room.',
    slow_mode: 'That room has slow mode on — wait a moment and try again.',
    generation_in_progress: 'Your previous generation is still running.',
    provider_rate_limited: 'The image generator is busy. Wait a minute and try again.',
    provider_timeout: 'The generator is taking longer than usual — the media will still appear in chat if it finishes.',
    provider_error: 'The image generator failed. Please try again.',
    provider_config: 'The image generator is not configured correctly.',
    invalid_media: 'The generator returned an unusable file. Please try again.',
    composition_failed: 'The generated image could not be prepared with both profile pictures. Please try again.',
    media_too_large: 'The generator returned a file that is too large.',
    upload_failed: 'The generated media could not be saved.',
    storage_full: 'Media storage is full. Please try again later.',
    video_unavailable: 'Video generation is not enabled on this server. Copy the prompt into an external video generator instead.',
    request_timeout: 'The request is still running — the media will appear in chat if it finishes.',
    network_error: 'Could not reach the server. Check your connection.',
    server_error: 'Something went wrong. Please try again.',
    bad_response: 'The server returned an unexpected response.'
  };

  var config = null;
  var modal = null;
  var currentTarget = null;
  var els = {};
  var busy = false;
  var promptRequestId = 0;
  var observer = null;

  function esc(value) { return MCF.escapeHtml(value); }
  function toast(message, kind) { MCF.toast(message, kind); }
  function errorText(code) { return ERRORS[code] || ('Could not generate media (' + (code || 'unknown_error') + ').'); }

  function avatarSrc(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    if (typeof window.imgSrc === 'function') return esc(window.imgSrc(raw));
    if (raw.indexOf('data:image/') === 0 || raw.indexOf('/') === 0 || /^https:\/\//i.test(raw)) {
      return esc(raw);
    }
    return '';
  }

  function participantHtml(participant, label) {
    if (!participant) return '';
    var name = String(participant.username || '').trim();
    var display = String(participant.display || name || 'Member').trim();
    var src = avatarSrc(participant.imageUrl);
    var initial = esc(display.charAt(0).toUpperCase() || '?');
    var picture = src
      ? '<img class="mcf-media-avatar" src="' + src + '" alt="' + esc(display) + '">'
      : '<span class="mcf-media-avatar mcf-media-avatar-fallback">' + initial + '</span>';
    return '<div class="mcf-media-participant">' + picture +
      '<div class="mcf-media-participant-label"><strong>' + esc(label) + '</strong>' +
      '<span>@' + esc(name || 'member') + '</span></div></div>';
  }

  function renderParticipants(participants) {
    if (!els.participants) return;
    if (!participants) {
      els.participants.innerHTML = '';
      return;
    }
    els.participants.innerHTML =
      participantHtml(participants.self, 'You') +
      '<div class="mcf-media-participant-join" aria-hidden="true">✕</div>' +
      participantHtml(participants.other, 'With');
  }

  function fetcher() {
    return typeof MCF.authFetch === 'function' ? MCF.authFetch : window.fetch;
  }

  /** JSON request with a real timeout; never throws for an expected failure. */
  async function api(url, body, timeoutMs) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 30000) : null;
    try {
      var options = { method: body === undefined ? 'GET' : 'POST' };
      if (body !== undefined) options.body = JSON.stringify(body);
      if (controller) options.signal = controller.signal;
      var res = await fetcher()(url, options);
      var data = res && typeof res.json === 'function' ? await res.json().catch(function () { return null; }) : null;
      if (!res || !res.ok) {
        if (data && data.error) return data;
        return { ok: false, error: 'http_' + ((res && res.status) || 500) };
      }
      return data || { ok: false, error: 'bad_response' };
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.type === 'aborted')) {
        return { ok: false, error: 'request_timeout' };
      }
      return { ok: false, error: 'network_error' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function getConfig() {
    var data = await api(API + '/config', undefined, 15000);
    if (!data || !data.ok) {
      return {
        ok: true,
        videoEnabled: false,
        styles: DEFAULT_STYLES,
        aspectRatios: DEFAULT_RATIOS,
        mediaTypes: ['image']
      };
    }
    return {
      ok: true,
      videoEnabled: !!data.videoEnabled,
      styles: Array.isArray(data.styles) && data.styles.length ? data.styles : DEFAULT_STYLES,
      aspectRatios: Array.isArray(data.aspectRatios) && data.aspectRatios.length ? data.aspectRatios : DEFAULT_RATIOS,
      mediaTypes: Array.isArray(data.mediaTypes) ? data.mediaTypes : ['image', 'video']
    };
  }

  /* ============================================================
     ROW DECORATION
  ============================================================ */

  function rowText(row) {
    if (!row) return '';
    if (row.classList && (row.classList.contains('room-system') || row.classList.contains('system'))) return '';
    if (row.querySelector && row.querySelector('.system-msg')) return '';

    var textEl = row.querySelector && row.querySelector('.message-text');
    if (textEl) return String(textEl.textContent || '').trim();

    // Desktop PM rows and mobile DM rows put the text in a bare, classless div.
    var host = row.classList && row.classList.contains('message') ? row : (row.querySelector('.message') || row);
    var divs = host.querySelectorAll ? host.querySelectorAll('div') : [];
    for (var i = divs.length - 1; i >= 0; i--) {
      var el = divs[i];
      if (el.children.length || el.className) continue;
      if (el.closest && el.closest('.message-actions, .mcf-dm-actions, .mcf-reactions, .reply-preview, .system-msg')) continue;
      var text = String(el.textContent || '').trim();
      if (text && !/^@[A-Za-z0-9._-]+\s*(?:•|$)/.test(text)) return text;
    }
    return '';
  }

  /** Work out which conversation a rendered row belongs to. */
  function findRowTarget(row) {
    if (!row || !row.dataset || !row.closest) return null;
    if (row.dataset.generatedMedia === '1') return null;

    var messageId = String(row.dataset.dmId || row.dataset.id || '').trim();
    if (!messageId) return null;

    var dmContainer = row.closest('#dmMessages, [id^="pmBody_"]');
    var publicFeed = row.closest('#publicFeed');
    var roomFeed = row.closest('#roomFeed');
    var sourceText = rowText(row);
    if (!sourceText) return null;

    if (dmContainer) return { scope: 'dm', room: '', messageId: messageId, sourceText: sourceText };
    if (publicFeed) return { scope: 'public', room: '', messageId: messageId, sourceText: sourceText };
    if (roomFeed) {
      var popup = document.getElementById('roomChatPopup');
      var room = popup && popup.dataset.room ? String(popup.dataset.room).trim() : '';
      if (!room) {
        var holder = row.closest('[data-room]');
        room = holder && holder.dataset.room ? String(holder.dataset.room).trim() : '';
      }
      if (!room) return null;
      return { scope: 'room', room: room, messageId: messageId, sourceText: sourceText };
    }
    return null;
  }

  function decorateRow(row) {
    if (!row || row.nodeType !== 1 || !row.classList) return;
    if (!(row.classList.contains('message-row') || row.classList.contains('message'))) return;
    // The child .message of a .message-row is the same message; decorate once.
    if (row.classList.contains('message') && row.parentElement &&
        row.parentElement.classList.contains('message-row')) return;

    var target = findRowTarget(row);
    if (!target) return;

    var existing = row.querySelector && row.querySelector('.mcf-media-btn');
    if (existing) {
      existing._mcfMediaTarget = target;
      return;
    }

    var host = row.classList.contains('message') ? row : (row.querySelector('.message') || row);
    var bar = host.querySelector('.message-actions');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'message-actions mcf-media-actions-added';
      host.appendChild(bar);
    }

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'msg-action mcf-media-btn';
    button.textContent = '✨ Visualize';
    button.title = 'Generate an AI image or video from this message';
    button.setAttribute('aria-label', button.title);
    button._mcfMediaTarget = target;
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openModal(button._mcfMediaTarget || findRowTarget(row));
    });
    bar.appendChild(button);
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll('.message-row, .message');
    for (var i = 0; i < nodes.length; i++) decorateRow(nodes[i]);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        for (var j = 0; j < mutation.addedNodes.length; j++) {
          var node = mutation.addedNodes[j];
          if (node.nodeType !== 1) continue;
          if (node.classList && (node.classList.contains('message-row') || node.classList.contains('message'))) {
            decorateRow(node);
          } else if (node.querySelectorAll) {
            scan(node);
          }
        }
        if (mutation.type === 'attributes' && mutation.target.nodeType === 1) {
          decorateRow(mutation.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributeFilter: ['data-id', 'data-dm-id', 'data-room', 'data-generated-media']
    });
    scan(document);
  }

  /* ============================================================
     MODAL
  ============================================================ */

  function optionsHtml(items) {
    return items.map(function (item) {
      return '<option value="' + esc(item.id) + '">' + esc(item.label) + '</option>';
    }).join('');
  }

  function buildModal(target) {
    currentTarget = target;
    var mediaOptions = !config.videoEnabled
      ? '<option value="image">Image</option><option value="video" disabled>Video (not enabled)</option>'
      : '<option value="image">Image</option><option value="video">Video</option>';

    modal = MCF.popup({
      title: '✨ Visualize a message',
      label: 'Generate AI media from a chat message',
      wide: true,
      onClose: function () {
        modal = null;
        currentTarget = null;
        els = {};
        promptRequestId += 1; // ignore a refinement that finishes after close
      }
    });

    modal.body.innerHTML =
      '<div class="mcf-media-form">' +
        '<div class="mcf-media-source-wrap">' +
          '<div class="mcf-media-label">Selected message · ' + esc(scopeLabel(target.scope)) + '</div>' +
          '<blockquote class="mcf-media-source" id="mcfMediaSource"></blockquote>' +
        '</div>' +
        '<div class="mcf-media-participants" id="mcfMediaParticipants"></div>' +
        '<div class="mcf-media-controls">' +
          '<label class="mcf-media-control">Output' +
            '<select id="mcfMediaType" aria-label="Output type">' + mediaOptions + '</select>' +
          '</label>' +
          '<label class="mcf-media-control">Style' +
            '<select id="mcfMediaStyle" aria-label="Visual style">' + optionsHtml(config.styles) + '</select>' +
          '</label>' +
          '<label class="mcf-media-control">Aspect ratio' +
            '<select id="mcfMediaRatio" aria-label="Aspect ratio">' + optionsHtml(config.aspectRatios) + '</select>' +
          '</label>' +
        '</div>' +
        '<label class="mcf-media-control">Generator prompt' +
          '<textarea id="mcfMediaPrompt" class="mcf-media-prompt" rows="6" spellcheck="true" ' +
            'aria-label="Editable image or video generator prompt" placeholder="Refining the message…"></textarea>' +
        '</label>' +
        '<div class="mcf-media-note" id="mcfMediaNote"></div>' +
        '<div class="mcf-media-status" id="mcfMediaStatus" aria-live="polite"></div>' +
        '<div class="mcf-media-actions">' +
          '<button type="button" class="small-btn ghost" id="mcfMediaRefine">Re-refine prompt</button>' +
          '<button type="button" class="small-btn ghost" id="mcfMediaCopy">Copy prompt</button>' +
          '<button type="button" class="small-btn mcf-media-generate" id="mcfMediaGenerate">Generate &amp; post</button>' +
        '</div>' +
      '</div>';

    els = {
      source: modal.body.querySelector('#mcfMediaSource'),
      participants: modal.body.querySelector('#mcfMediaParticipants'),
      mediaType: modal.body.querySelector('#mcfMediaType'),
      style: modal.body.querySelector('#mcfMediaStyle'),
      ratio: modal.body.querySelector('#mcfMediaRatio'),
      prompt: modal.body.querySelector('#mcfMediaPrompt'),
      note: modal.body.querySelector('#mcfMediaNote'),
      status: modal.body.querySelector('#mcfMediaStatus'),
      refine: modal.body.querySelector('#mcfMediaRefine'),
      copy: modal.body.querySelector('#mcfMediaCopy'),
      generate: modal.body.querySelector('#mcfMediaGenerate')
    };

    els.source.textContent = target.sourceText || '';
    els.note.textContent = config.videoEnabled
      ? 'Both members’ profile pictures are included in the image. Prompts are checked for unsafe content and the result is posted in this chat under your name.'
      : 'Both members’ profile pictures are included in the image. Video generation needs a media API key on the server; you can still copy the refined prompt into any external image/video generator.';
    els.refine.addEventListener('click', function () {
      els.prompt.dataset.dirty = '';
      loadPrompt();
    });
    els.copy.addEventListener('click', copyPrompt);
    els.generate.addEventListener('click', generate);
    els.prompt.addEventListener('input', function () { els.prompt.dataset.dirty = '1'; });
    [els.mediaType, els.style, els.ratio].forEach(function (select) {
      select.addEventListener('change', function () {
        if (!els.prompt.dataset.dirty) loadPrompt();
        else setStatus('Options changed — press “Re-refine prompt” to rebuild it.', 'info');
      });
    });
  }

  function scopeLabel(scope) {
    if (scope === 'room') return 'custom room';
    if (scope === 'dm') return 'direct message';
    return 'arena';
  }

  function currentOptions() {
    var mediaType = els.mediaType.value === 'video' && config.videoEnabled ? 'video' : 'image';
    return {
      mediaType: mediaType,
      style: els.style.value,
      aspectRatio: els.ratio.value
    };
  }

  function setStatus(message, kind) {
    if (!els.status) return;
    els.status.textContent = message;
    els.status.className = 'mcf-media-status' + (kind ? ' mcf-media-' + kind : '');
  }

  function showError(message) {
    setStatus(message, 'error');
    toast(message, 'error');
  }

  function setBusy(value) {
    busy = value;
    if (!els.generate) return;
    els.generate.disabled = value;
    els.generate.textContent = value ? 'Generating…' : 'Generate & post';
    els.refine.disabled = value;
  }

  async function loadPrompt() {
    if (!currentTarget || !els.prompt) return;
    var id = ++promptRequestId;
    var options = currentOptions();
    setStatus('Refining the message into a generator prompt…', 'info');
    els.generate.disabled = true;

    var data = await api(API + '/prompt', {
      scope: currentTarget.scope,
      room: currentTarget.room,
      messageId: currentTarget.messageId,
      mediaType: options.mediaType,
      style: options.style,
      aspectRatio: options.aspectRatio
    }, 30000);

    if (id !== promptRequestId || !els.prompt) return;
    if (!data.ok) {
      showError(errorText(data.error));
      return;
    }

    els.source.textContent = data.sourceText || currentTarget.sourceText || '';
    renderParticipants(data.participants);
    els.prompt.value = data.prompt || '';
    els.prompt.dataset.dirty = '';
    setStatus(data.refinedBy === 'llm'
      ? 'Prompt ready — refined with AI. Edit it if you like.'
      : 'Prompt ready — refined by the built-in prompt writer. Edit it if you like.', 'info');
    els.generate.disabled = false;
  }

  async function copyPrompt() {
    var text = els.prompt ? els.prompt.value : '';
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        var temp = document.createElement('textarea');
        temp.value = text;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.select();
        var copied = document.execCommand && document.execCommand('copy');
        temp.remove();
        if (!copied) throw new Error('copy_failed');
      }
      toast('Generator prompt copied', 'success');
    } catch (_) {
      toast('Could not copy the prompt — select the text instead', 'error');
    }
  }

  async function generate() {
    if (busy || !currentTarget || !els.prompt) return;
    var prompt = els.prompt.value.trim();
    if (!prompt) {
      showError(errorText('empty_prompt'));
      return;
    }
    var options = currentOptions();
    setBusy(true);
    setStatus(options.mediaType === 'video'
      ? 'Generating a short video and posting it in this chat… this can take a couple of minutes.'
      : 'Generating the image and posting it in this chat…', 'info');

    var data = await api(API + '/generate', {
      scope: currentTarget.scope,
      room: currentTarget.room,
      messageId: currentTarget.messageId,
      mediaType: options.mediaType,
      style: options.style,
      aspectRatio: options.aspectRatio,
      prompt: prompt
    }, options.mediaType === 'video' ? 200000 : 120000);

    setBusy(false);
    if (!data.ok) {
      showError(errorText(data.error));
      return;
    }

    toast('AI ' + options.mediaType + ' posted to this ' + scopeLabel(currentTarget.scope), 'success');
    if (modal) modal.close();
  }

  async function openModal(target) {
    if (!target) return;
    if (!MCF.session()) {
      toast(errorText('auth_required'), 'error');
      return;
    }
    if (modal) {
      try { modal.close(); } catch (_) { /* already closing */ }
    }
    config = await getConfig();
    buildModal(target);
    loadPrompt();
  }

  function bind() {
    startObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFMessageMedia = {
    open: openModal,
    decorate: decorateRow,
    targetFor: findRowTarget,
    scan: scan
  };
})();
