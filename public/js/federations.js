/* ============================================================
   federations.js — member-run federations (client)
   ------------------------------------------------------------
   The "Federations" section of the action row, and the four
   buttons inside it:

     Create    the registration form — name, description, rules,
               the roles the owner can hand out, and an image.
               POST /api/federations stores the federation and
               points the owner's own record at it.
     Manage    your federation as it stands: image, bylaws,
               roles, members.
     Join      every federation on the site, with a Join button.
     Chatroom  the members-only room for your federation.

   One federation per owner and one membership per member are
   enforced by the server (federations.js); this module mirrors
   the rule only so the form never opens for someone who already
   runs one.

   Depends on features-core.js (window.MCF).
============================================================ */
(function () {
  'use strict';

  if (!window.MCF) return;

  var ROLE_LIMIT = 6;
  var CHAT_POLL_MS = 5000;

  var ERROR_TEXT = {
    name_required: 'Give your federation a name.',
    name_short: 'The name needs at least 3 characters.',
    name_long: 'The name can be at most 40 characters.',
    name_taken: 'That federation name is already taken.',
    description_required: 'Write a short description — it is the recruiting pitch.',
    description_short: 'The description needs at least 10 characters.',
    description_long: 'The description can be at most 600 characters.',
    rules_long: 'The rules can be at most 1500 characters.',
    roles_invalid: 'Those roles could not be read — try again.',
    roles_too_many: 'A federation can have at most ' + ROLE_LIMIT + ' custom roles.',
    role_name_short: 'A role name needs at least 2 characters.',
    role_name_long: 'A role name can be at most 24 characters.',
    role_duplicate: 'Two roles cannot share a name (or use Owner / Member).',
    image_invalid: 'The image must be an uploaded https image.',
    already_in_federation: 'You are already in a federation — leave it before joining another.',
    already_run_federation: 'You already run a federation.',
    already_member: 'You are already a member of this federation.',
    not_found: 'That federation no longer exists.',
    not_a_member: 'Only members can open this federation’s chatroom.',
    not_allowed: 'That account cannot use federations.',
    server_error: 'Something went wrong — try again in a moment.'
  };

  function errorText(code) {
    return ERROR_TEXT[code] || 'Something went wrong — try again.';
  }

  /** Bind every copy of an id (the action row exists twice on the desktop page). */
  function bindAll(id, handler) {
    document.querySelectorAll('[id="' + id + '"]').forEach(function (el) {
      el.addEventListener('click', handler);
    });
  }

  function session() { return MCF.session(); }

  /**
   * Keep the cached session in step with the server's copy of user.federation,
   * so the next Create press already knows the member runs a federation.
   */
  function cacheMembership(federation) {
    if (!federation) return;
    var patch = {
      id: federation.id,
      name: federation.name,
      role: federation.isOwner ? 'owner' : 'member'
    };
    ['cw_session_v1', 'currentUser'].forEach(function (key) {
      try {
        var raw = localStorage.getItem(key);
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (!parsed || !parsed.username) return;
        parsed.federation = patch;
        localStorage.setItem(key, JSON.stringify(parsed));
      } catch (e) { /* the cache is never load-bearing */ }
    });
  }

  function joinPrompt(kind) {
    var box = MCF.popup({ title: 'No federation yet', label: 'No federation yet' });
    box.body.innerHTML =
      '<p class="small muted">You are not in a federation yet. Start one and write its rules, or join one that already exists.</p>' +
      '<div class="mcf-row-actions">' +
        '<button type="button" class="small-btn" id="mcfFedPromptCreate">Create a federation</button>' +
        '<button type="button" class="ghost small-btn" id="mcfFedPromptJoin">Browse federations</button>' +
      '</div>';
    box.body.querySelector('#mcfFedPromptCreate').addEventListener('click', function () {
      box.close();
      openCreate();
    });
    box.body.querySelector('#mcfFedPromptJoin').addEventListener('click', function () {
      box.close();
      openJoin();
    });
    if (kind === 'chatroom') {
      box.body.insertAdjacentHTML('afterbegin',
        '<p class="small muted">The chatroom opens for members, so join or create a federation first.</p>');
    }
  }

  /* ---------------------------------------------------------
     CREATE — the registration form
  --------------------------------------------------------- */

  var state = null;

  function openCreate() {
    if (!session()) {
      MCF.toast('Sign in to create a federation', 'error');
      return;
    }

    MCF.getJSON('/api/federations/mine').then(function (data) {
      if (data && data.ok && data.federation) {
        if (data.federation.isOwner) {
          MCF.toast('You already run ' + data.federation.name, 'error');
        } else {
          MCF.toast('You are already in ' + data.federation.name, 'error');
        }
        showFederation(data.federation);
        return;
      }
      showCreateForm();
    });
  }

  function emptyRole() { return { name: '', description: '' }; }

  function showCreateForm() {
    state = { imageUrl: '', roles: [emptyRole()], saving: false };

    var box = MCF.popup({
      title: 'Register a federation',
      label: 'Federation registration',
      wide: true
    });

    box.body.innerHTML =
      '<p class="small muted">A federation is your own promotion: a name, the rules it runs by, the roles you can hand to members, and a face for the Join list. You can only run one — make it count.</p>' +
      '<div class="mcf-field"><label for="mcfFedName">Federation name</label>' +
        '<input class="mcf-input" type="text" id="mcfFedName" maxlength="40" placeholder="e.g. Iron Ring Federation"></div>' +
      '<div class="mcf-field"><label for="mcfFedDescription">Description</label>' +
        '<textarea class="mcf-input" id="mcfFedDescription" rows="3" maxlength="600" placeholder="Who you are, what kind of matches you run, who should join."></textarea></div>' +
      '<div class="mcf-field"><label for="mcfFedRules">Rules</label>' +
        '<textarea class="mcf-input" id="mcfFedRules" rows="4" maxlength="1500" placeholder="Your bylaws: match styles, conduct, how titles are won and defended."></textarea></div>' +
      '<div class="mcf-field"><label>Roles to assign</label>' +
        '<div id="mcfFedRoles" class="mcf-fed-roles"></div>' +
        '<div class="mcf-row-actions">' +
          '<button type="button" class="ghost small-btn" id="mcfFedAddRole">Add a role</button>' +
          '<span class="small muted">Up to ' + ROLE_LIMIT + ' — e.g. Commissioner, Champion, Enforcer. Owner and Member exist already.</span>' +
        '</div>' +
      '</div>' +
      '<div class="mcf-field"><label for="mcfFedImage">Federation image</label>' +
        '<div class="mcf-fed-image-row">' +
          '<img id="mcfFedImagePreview" class="mcf-fed-image-preview" alt="" hidden>' +
          '<div>' +
            '<input type="file" id="mcfFedImage" accept="image/*">' +
            '<div class="small muted" id="mcfFedImageStatus">Optional. PNG, JPG or GIF — shown on your federation card.</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mcf-row-actions">' +
        '<button type="button" class="small-btn" id="mcfFedSubmit">Create federation</button>' +
        '<button type="button" class="ghost small-btn" id="mcfFedCancel">Cancel</button>' +
        '<span class="small muted" id="mcfFedStatus"></span>' +
      '</div>';

    renderRoles(box);

    box.body.querySelector('#mcfFedAddRole').addEventListener('click', function () {
      if (state.roles.length >= ROLE_LIMIT) {
        MCF.toast('A federation can have at most ' + ROLE_LIMIT + ' custom roles', 'error');
        return;
      }
      syncRoles(box);
      state.roles.push(emptyRole());
      renderRoles(box);
    });

    box.body.querySelector('#mcfFedImage').addEventListener('change', function (event) {
      uploadImage(event.target.files && event.target.files[0], box);
    });

    box.body.querySelector('#mcfFedCancel').addEventListener('click', function () {
      box.close();
    });

    box.body.querySelector('#mcfFedSubmit').addEventListener('click', function () {
      submit(box);
    });
  }

  function roleRowHtml(role, index) {
    return '<div class="mcf-fed-role-row" data-role="' + index + '">' +
      '<input class="mcf-input" type="text" data-role-name maxlength="24" aria-label="Role name" placeholder="Role name" value="' + MCF.escapeHtml(role.name) + '">' +
      '<input class="mcf-input" type="text" data-role-desc maxlength="120" aria-label="Role description" placeholder="What it is for (optional)" value="' + MCF.escapeHtml(role.description) + '">' +
      '<button type="button" class="mcf-fed-role-remove" data-role-remove aria-label="Remove role">✕</button>' +
    '</div>';
  }

  function renderRoles(box) {
    var host = box.body.querySelector('#mcfFedRoles');
    if (!host) return;
    host.innerHTML = state.roles.map(roleRowHtml).join('');
    host.querySelectorAll('[data-role-remove]').forEach(function (button) {
      button.addEventListener('click', function () {
        syncRoles(box);
        var row = button.closest('.mcf-fed-role-row');
        var index = Number(row && row.dataset.role);
        state.roles.splice(index, 1);
        if (!state.roles.length) state.roles.push(emptyRole());
        renderRoles(box);
      });
    });
  }

  /** Read the role inputs back into state before the rows are re-rendered. */
  function syncRoles(box) {
    var rows = box.body.querySelectorAll('.mcf-fed-role-row');
    state.roles = Array.prototype.map.call(rows, function (row) {
      return {
        name: row.querySelector('[data-role-name]').value,
        description: row.querySelector('[data-role-desc]').value
      };
    });
  }

  function uploadImage(file, box) {
    var status = box.body.querySelector('#mcfFedImageStatus');
    var preview = box.body.querySelector('#mcfFedImagePreview');
    if (!file) return;

    if (!/^image\//.test(file.type)) {
      if (status) status.textContent = 'That is not an image file.';
      return;
    }

    var form = new FormData();
    form.append('image', file);
    var headers = {};
    var token = MCF.sessionToken();
    if (token) headers.Authorization = 'Bearer ' + token;

    if (status) status.textContent = 'Uploading…';

    fetch('/api/upload-image', {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
      headers: headers
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok || !data.imageUrl) {
          if (status) status.textContent = 'Upload failed — try another image.';
          return;
        }
        state.imageUrl = data.imageUrl;
        if (status) status.textContent = 'Image uploaded.';
        if (preview) {
          preview.src = data.imageUrl;
          preview.hidden = false;
        }
      })
      .catch(function () {
        if (status) status.textContent = 'Upload error — try again.';
      });
  }

  function submit(box) {
    if (state.saving) return;

    var status = box.body.querySelector('#mcfFedStatus');
    var button = box.body.querySelector('#mcfFedSubmit');

    syncRoles(box);

    var payload = {
      name: box.body.querySelector('#mcfFedName').value,
      description: box.body.querySelector('#mcfFedDescription').value,
      rules: box.body.querySelector('#mcfFedRules').value,
      imageUrl: state.imageUrl,
      // Blank rows are ignored by the server; trim the obvious ones here too.
      roles: state.roles.filter(function (role) { return String(role.name || '').trim(); })
    };

    if (!payload.name.trim() || !payload.description.trim()) {
      if (status) status.textContent = 'A name and a description are required.';
      return;
    }

    state.saving = true;
    if (button) button.disabled = true;
    if (status) status.textContent = 'Creating…';

    MCF.postJSON('/api/federations', payload).then(function (data) {
      state.saving = false;
      if (button) button.disabled = false;

      if (!data || !data.ok) {
        var message = errorText(data && data.error);
        if (status) status.textContent = message;
        MCF.toast(message, 'error');
        return;
      }

      cacheMembership(data.federation);
      box.close();
      MCF.toast(data.federation.name + ' is registered', 'success');
      showFederation(data.federation);
    });
  }

  /* ---------------------------------------------------------
     MANAGE — your federation as it stands
  --------------------------------------------------------- */

  function openManage() {
    if (!session()) {
      MCF.toast('Sign in to manage your federation', 'error');
      return;
    }

    MCF.getJSON('/api/federations/mine').then(function (data) {
      if (!data || !data.ok) {
        MCF.toast('Could not load your federation', 'error');
        return;
      }
      if (!data.federation) {
        joinPrompt('manage');
        return;
      }
      showFederation(data.federation);
    });
  }

  function roleName(federation, roleId) {
    var match = (federation.roles || []).filter(function (role) { return role.id === roleId; })[0];
    return match ? match.name : (roleId || 'Member');
  }

  function showFederation(federation) {
    var box = MCF.popup({ title: federation.name, label: federation.name + ' federation', wide: true });

    var roles = (federation.roles || []).map(function (role) {
      return '<li><strong>' + MCF.escapeHtml(role.name) + '</strong>' +
        (role.description ? ' <span class="small muted">— ' + MCF.escapeHtml(role.description) + '</span>' : '') +
        (role.builtIn ? ' <span class="mcf-fed-tag">built in</span>' : '') +
        '</li>';
    }).join('');

    var members = (federation.members || []).map(function (member) {
      return '<li><strong>' + MCF.escapeHtml(member.display || member.username) + '</strong>' +
        ' <span class="small muted">@' + MCF.escapeHtml(member.username) + ' · ' +
        MCF.escapeHtml(roleName(federation, member.roleId)) + '</span></li>';
    }).join('');

    var image = federation.imageUrl
      ? '<img class="mcf-fed-hero-image" src="' + MCF.escapeHtml(federation.imageUrl) + '" alt="">'
      : '<span class="mcf-fed-hero-image mcf-fed-hero-empty" aria-hidden="true">' +
        MCF.escapeHtml(String(federation.name || '?').slice(0, 2).toUpperCase()) + '</span>';

    box.body.innerHTML =
      '<div class="mcf-fed-hero">' + image +
        '<div>' +
          '<h4 class="mcf-fed-name">' + MCF.escapeHtml(federation.name) + '</h4>' +
          '<p class="small muted">Run by @' + MCF.escapeHtml(federation.owner) + ' · ' +
            federation.memberCount + (federation.memberCount === 1 ? ' member' : ' members') + '</p>' +
          '<p class="small muted">' +
            (federation.isOwner ? 'You run this federation.' : 'You are a member of this federation.') +
          '</p>' +
        '</div>' +
      '</div>' +
      '<div class="mcf-fed-block"><h4>Description</h4>' +
        '<p class="mcf-fed-copy">' + MCF.escapeHtml(federation.description) + '</p></div>' +
      '<div class="mcf-fed-block"><h4>Rules</h4>' +
        (federation.rules
          ? '<p class="mcf-fed-copy">' + MCF.escapeHtml(federation.rules) + '</p>'
          : '<p class="small muted">No rules written yet.</p>') +
      '</div>' +
      '<div class="mcf-fed-block"><h4>Roles</h4>' +
        '<ul class="mcf-fed-list">' + roles + '</ul></div>' +
      '<div class="mcf-fed-block"><h4>Members' +
        (members ? ' (' + federation.memberCount + ')' : '') + '</h4>' +
        (members
          ? '<ul class="mcf-fed-list">' + members + '</ul>'
          : '<p class="small muted">Member list is visible to members.</p>') +
      '</div>' +
      '<p class="small muted">More federation tools — editing the bylaws, handing out roles, titles — are coming next.</p>' +
      '<div class="mcf-row-actions">' +
        '<button type="button" class="small-btn" id="mcfFedOpenChat">Open chatroom</button>' +
      '</div>';

    box.body.querySelector('#mcfFedOpenChat').addEventListener('click', function () {
      box.close();
      openChatroom();
    });
  }

  /* ---------------------------------------------------------
     JOIN — the federation list
  --------------------------------------------------------- */

  function openJoin() {
    if (!session()) {
      MCF.toast('Sign in to join a federation', 'error');
      return;
    }

    var box = MCF.popup({ title: 'Join a federation', label: 'Federations to join', wide: true });
    box.body.innerHTML = '<p class="small muted">Loading federations…</p>';

    MCF.getJSON('/api/federations').then(function (data) {
      if (!data || !data.ok) {
        box.body.innerHTML = '<p class="small muted">Could not load the federation list.</p>';
        return;
      }

      var membership = data.membership;
      var banner = membership
        ? '<p class="mcf-fed-notice">You are already in <strong>' + MCF.escapeHtml(membership.name) +
          '</strong>. Leave it before joining another federation.</p>'
        : '';

      var rows = (data.federations || []).map(function (federation) {
        var mine = membership && membership.id === federation.id;
        return '<div class="mcf-fed-join-row">' +
          (federation.imageUrl
            ? '<img class="mcf-fed-thumb" src="' + MCF.escapeHtml(federation.imageUrl) + '" alt="">'
            : '<span class="mcf-fed-thumb mcf-fed-hero-empty" aria-hidden="true">' +
              MCF.escapeHtml(String(federation.name || '?').slice(0, 2).toUpperCase()) + '</span>') +
          '<div class="mcf-fed-join-copy">' +
            '<strong>' + MCF.escapeHtml(federation.name) + '</strong>' +
            '<span class="small muted">@' + MCF.escapeHtml(federation.owner) + ' · ' +
              federation.memberCount + (federation.memberCount === 1 ? ' member' : ' members') + '</span>' +
            '<span class="small muted">' + MCF.escapeHtml(federation.description) + '</span>' +
          '</div>' +
          (mine
            ? '<span class="mcf-fed-tag">Yours</span>'
            : '<button type="button" class="small-btn" data-join="' + MCF.escapeHtml(federation.id) + '"' +
              (membership ? ' disabled' : '') + '>Join</button>') +
        '</div>';
      }).join('');

      box.body.innerHTML = banner +
        (rows
          ? '<div class="mcf-fed-join-list">' + rows + '</div>'
          : '<p class="small muted">No federations have been registered yet — create the first one.</p>') +
        '<div class="mcf-row-actions">' +
          '<button type="button" class="small-btn" id="mcfFedJoinCreate">Create a federation</button>' +
          '<span class="small muted" id="mcfFedJoinStatus"></span>' +
        '</div>';

      box.body.querySelector('#mcfFedJoinCreate').addEventListener('click', function () {
        box.close();
        openCreate();
      });

      box.body.querySelectorAll('[data-join]').forEach(function (button) {
        button.addEventListener('click', function () {
          join(button, box);
        });
      });
    });
  }

  function join(button, box) {
    var id = button.dataset.join;
    var status = box.body.querySelector('#mcfFedJoinStatus');
    button.disabled = true;
    if (status) status.textContent = 'Joining…';

    MCF.postJSON('/api/federations/' + encodeURIComponent(id) + '/join', {}).then(function (data) {
      if (!data || !data.ok) {
        var message = errorText(data && data.error);
        if (status) status.textContent = message;
        MCF.toast(message, 'error');
        button.disabled = false;
        return;
      }

      cacheMembership(data.federation);
      box.close();
      MCF.toast('You joined ' + data.federation.name, 'success');
      showFederation(data.federation);
    });
  }

  /* ---------------------------------------------------------
     CHATROOM — members only
  --------------------------------------------------------- */

  function openChatroom() {
    if (!session()) {
      MCF.toast('Sign in to open the chatroom', 'error');
      return;
    }

    MCF.getJSON('/api/federations/mine').then(function (data) {
      if (!data || !data.ok) {
        MCF.toast('Could not load your federation', 'error');
        return;
      }
      if (!data.federation) {
        joinPrompt('chatroom');
        return;
      }
      showChatroom(data.federation);
    });
  }

  function showChatroom(federation) {
    if (!federation.isMember) {
      MCF.toast('Only members can open this chatroom', 'error');
      return;
    }

    var timer = null;
    var box = MCF.popup({
      title: federation.name + ' — chatroom',
      label: federation.name + ' chatroom',
      wide: true,
      onClose: function () { if (timer) clearInterval(timer); }
    });

    box.body.innerHTML =
      '<p class="small muted">Members only. Everything here stays inside the federation.</p>' +
      '<div class="mcf-fed-chat-log" id="mcfFedChatLog" aria-live="polite"><p class="small muted">Loading…</p></div>' +
      '<div class="mcf-fed-chat-form">' +
        '<input class="mcf-input" type="text" id="mcfFedChatInput" maxlength="500" placeholder="Say something to your federation">' +
        '<button type="button" class="small-btn" id="mcfFedChatSend">Send</button>' +
      '</div>' +
      '<span class="small muted" id="mcfFedChatStatus"></span>';

    var log = box.body.querySelector('#mcfFedChatLog');
    var input = box.body.querySelector('#mcfFedChatInput');
    var status = box.body.querySelector('#mcfFedChatStatus');
    var url = '/api/federations/' + encodeURIComponent(federation.id) + '/messages';

    function render(messages) {
      if (!Array.isArray(messages)) return;
      if (!messages.length) {
        log.innerHTML = '<p class="small muted">No messages yet — the first word is yours.</p>';
        return;
      }
      var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.innerHTML = messages.map(function (message) {
        return '<div class="mcf-fed-chat-msg">' +
          '<div class="mcf-fed-chat-meta"><strong>' + MCF.escapeHtml(message.display || message.from) + '</strong>' +
            '<time>' + MCF.escapeHtml(MCF.timeLabel(message.at)) + '</time></div>' +
          '<div class="mcf-fed-chat-text">' + MCF.escapeHtml(message.text) + '</div>' +
        '</div>';
      }).join('');
      if (atBottom) log.scrollTop = log.scrollHeight;
    }

    function load() {
      return MCF.getJSON(url).then(function (data) {
        if (data && data.ok) {
          render(data.messages);
          if (status) status.textContent = '';
        } else if (data && !data.ok) {
          if (status) status.textContent = errorText(data.error);
        }
      });
    }

    function send() {
      var text = String(input.value || '').trim();
      if (!text) return;
      if (status) status.textContent = '';
      input.value = '';

      MCF.postJSON(url, { text: text }).then(function (data) {
        if (!data || !data.ok) {
          if (status) status.textContent = errorText(data && data.error);
          input.value = text;
          return;
        }
        render(data.messages);
        log.scrollTop = log.scrollHeight;
      });
    }

    box.body.querySelector('#mcfFedChatSend').addEventListener('click', send);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        send();
      }
    });

    load();
    timer = setInterval(load, CHAT_POLL_MS);
  }

  /* ---------------------------------------------------------
     Wiring
  --------------------------------------------------------- */

  function bind() {
    bindAll('btnFederationCreate', openCreate);
    bindAll('btnFederationManage', openManage);
    bindAll('btnFederationJoin', openJoin);
    bindAll('btnFederationChat', openChatroom);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFFederations = {
    openCreate: openCreate,
    openManage: openManage,
    openJoin: openJoin,
    openChatroom: openChatroom
  };
})();
