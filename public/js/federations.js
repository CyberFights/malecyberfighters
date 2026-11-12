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
  // Stacking order for the floating chatroom, and the one window that is open.
  var chatZ = 12100;
  var openChat = null;

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
    not_a_manager: 'Only the owner and co-owners/admins can manage this federation.',
    member_not_found: 'That member is no longer in the federation.',
    cannot_change_owner: 'The owner’s role cannot be changed.',
    cannot_change_own_role: 'You cannot change your own role.',
    cannot_remove_owner: 'The owner cannot be removed from their own federation.',
    insufficient_privileges: 'Only the federation owner can do that.',
    invalid_role: 'Pick a role from the list.',
    role_name_required: 'Give the role a name.',
    role_not_found: 'That role no longer exists.',
    built_in_role: 'Owner, Co-owner and Member are built in and cannot be changed.',
    role_in_use: 'Someone still holds that role — change their role first.',
    already_requested: 'You have already asked to join — wait for the owner to answer.',
    request_not_found: 'That request is no longer waiting.',
    applicant_unavailable: 'That member can no longer be added.',
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
    var patch = null;
    if (federation) {
      patch = {
        id: federation.id,
        name: federation.name,
        // co-owner and owner-written admin roles are cached as they are, so
        // the action row can say who manages the federation.
        role: federation.viewerRole || (federation.isOwner ? 'owner' : 'member')
      };
    }
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

  function emptyRole() { return { name: '', description: '', admin: false }; }

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
          '<span class="small muted">Up to ' + ROLE_LIMIT + ' — e.g. Commissioner, Champion, Enforcer. Owner, Co-owner and Member exist already; tick “Can manage” to let a role manage the federation.</span>' +
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
      uploadFederationImage(
        event.target.files && event.target.files[0],
        box.body.querySelector('#mcfFedImageStatus'),
        box.body.querySelector('#mcfFedImagePreview'),
        function (url) { state.imageUrl = url; }
      );
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
      '<label class="mcf-fed-role-admin"><input type="checkbox" data-role-admin' + (role.admin ? ' checked' : '') + '> Can manage</label>' +
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
        description: row.querySelector('[data-role-desc]').value,
        admin: row.querySelector('[data-role-admin]').checked
      };
    });
  }

  /**
   * Upload a federation image through the shared endpoint. Shared by the
   * Create form and the Manage → Details tab; the caller decides where the
   * returned URL is stored.
   */
  function uploadFederationImage(file, status, preview, onUploaded) {
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
        if (status) status.textContent = 'Image uploaded.';
        if (preview) {
          preview.src = data.imageUrl;
          preview.hidden = false;
        }
        if (typeof onUploaded === 'function') onUploaded(data.imageUrl);
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
      roles: state.roles
        .filter(function (role) { return String(role.name || '').trim(); })
        .map(function (role) {
          return { name: role.name, description: role.description, admin: !!role.admin };
        })
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
     MANAGE — owners, co-owners and admins only
  --------------------------------------------------------- */

  function roleFor(federation, roleId) {
    return (federation.roles || []).filter(function (role) { return role.id === roleId; })[0] || null;
  }

  function roleName(federation, roleId) {
    var match = roleFor(federation, roleId);
    return match ? match.name : (roleId || 'Member');
  }

  function isAdminRole(federation, roleId) {
    var role = roleFor(federation, roleId);
    return !!(role && role.admin);
  }

  function presenceLabel(member) {
    if (member.online) return 'Online now';
    var ago = MCF.agoLabel(member.lastSeenAt);
    return ago ? 'Last online ' + ago : 'Offline';
  }

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
      // Manage belongs to the owner and the federation's admins. Everyone
      // else gets the read-only card, never the roster controls.
      if (!data.federation.canManage) {
        showManagerOnly(data.federation);
        return;
      }
      showManageWindow(data.federation);
    });
  }

  function showManagerOnly(federation) {
    var box = MCF.popup({ title: 'Manage ' + federation.name, label: 'Manage ' + federation.name });
    box.body.innerHTML =
      '<p class="mcf-fed-notice">Only the owner and the federation’s co-owners/admins can manage ' +
        MCF.escapeHtml(federation.name) + '.</p>' +
      '<p class="small muted">Your role is <strong>' +
        MCF.escapeHtml(roleName(federation, federation.viewerRole)) + '</strong>. ' +
        'Ask the owner if you need to hand out roles or edit the federation.</p>' +
      '<div class="mcf-row-actions">' +
        '<button type="button" class="small-btn" id="mcfFedViewFromManage">View federation</button>' +
        '<button type="button" class="ghost small-btn" id="mcfFedChatFromManage">Open chatroom</button>' +
      '</div>';

    box.body.querySelector('#mcfFedViewFromManage').addEventListener('click', function () {
      box.close();
      showFederation(federation);
    });
    box.body.querySelector('#mcfFedChatFromManage').addEventListener('click', function () {
      box.close();
      openChatroom();
    });
  }

  function tabButton(id, label, active) {
    return '<button type="button" role="tab" class="mcf-fed-tab' + (active ? ' mcf-fed-tab-on' : '') + '"' +
      ' aria-selected="' + (active ? 'true' : 'false') + '"' +
      ' data-fed-tab="' + id + '" aria-controls="mcfFedManagePanel">' +
      MCF.escapeHtml(label) + '</button>';
  }

  function showManageWindow(initial) {
    var state = {
      federation: initial,
      tab: 'members',
      busy: false,
      imageUrl: initial.imageUrl || '',
      editingRoleId: null
    };

    var box = MCF.popup({
      title: initial.name + ' — manage',
      label: 'Manage ' + initial.name,
      wide: true
    });

    function apply(federation) {
      if (!federation) return;
      state.federation = federation;
      if (state.tab === 'details') state.imageUrl = federation.imageUrl || '';
      render();
      cacheMembership(federation.canManage || federation.isMember ? federation : null);
    }

    function refresh() {
      return MCF.getJSON('/api/federations/mine').then(function (data) {
        if (!data || !data.ok || !data.federation) {
          MCF.toast('Could not refresh the federation', 'error');
          return null;
        }
        apply(data.federation);
        return data.federation;
      });
    }

    function render() {
      var fed = state.federation;
      box.setTitle(fed.name + ' — manage');
      box.body.innerHTML =
        '<div class="mcf-fed-tabs" role="tablist" aria-label="Manage federation">' +
          tabButton('members', 'Members', state.tab === 'members') +
          tabButton('roles', 'Roles', state.tab === 'roles') +
          tabButton('details', 'Federation details', state.tab === 'details') +
        '</div>' +
        '<div id="mcfFedManagePanel" role="tabpanel"></div>';

      box.body.querySelectorAll('[data-fed-tab]').forEach(function (button) {
        button.addEventListener('click', function () {
          state.tab = button.dataset.fedTab;
          render();
        });
      });

      var panel = box.body.querySelector('#mcfFedManagePanel');
      if (state.tab === 'members') renderMembers(panel);
      else if (state.tab === 'roles') renderRolesTab(panel);
      else renderDetails(panel);
    }

    /** A two-tap confirm: the first press arms the button for a few seconds. */
    function arm(button, label, confirmLabel, action) {
      button.addEventListener('click', function () {
        if (button.dataset.confirm !== '1') {
          button.dataset.confirm = '1';
          button.textContent = confirmLabel;
          setTimeout(function () {
            if (button.isConnected) {
              button.dataset.confirm = '';
              button.textContent = label;
            }
          }, 4000);
          return;
        }
        action();
      });
    }

    /* ---------- tab 1: the roster ---------- */

    function renderMembers(panel) {
      var fed = state.federation;
      var me = session();
      var viewerIsOwner = fed.isOwner;

      var rows = (fed.members || []).map(function (member) {
        var targetIsOwner = member.username === fed.owner;
        var targetIsAdmin = isAdminRole(fed, member.roleId);
        var isSelf = !!me && member.username === me.username;

        // The owner outranks everyone; an admin cannot edit a peer, and
        // nobody edits their own row.
        var canTouch = !targetIsOwner && !isSelf && (viewerIsOwner || !targetIsAdmin);

        var assignable = (fed.roles || []).filter(function (role) {
          if (role.id === 'owner') return false;
          if (role.admin && !viewerIsOwner) return false;
          return true;
        });

        var roleCell;
        if (targetIsOwner) {
          roleCell = '<span class="mcf-fed-tag">Owner</span>';
        } else if (canTouch) {
          roleCell = '<select class="mcf-fed-role-select" data-fed-role="' +
            MCF.escapeHtml(member.username) + '" aria-label="Role for ' +
            MCF.escapeHtml(member.display || member.username) + '">' +
            assignable.map(function (role) {
              return '<option value="' + MCF.escapeHtml(role.id) + '"' +
                (role.id === member.roleId ? ' selected' : '') + '>' +
                MCF.escapeHtml(role.name) + (role.admin ? ' (admin)' : '') +
                '</option>';
            }).join('') +
          '</select>';
        } else {
          roleCell = '<span class="small muted">' + MCF.escapeHtml(roleName(fed, member.roleId)) + '</span>';
        }

        var remove = canTouch
          ? '<button type="button" class="ghost small-btn mcf-fed-remove" data-fed-remove="' +
            MCF.escapeHtml(member.username) + '">Remove</button>'
          : '';

        // Your own row has no role menu (no self-demotion) but a member who is
        // not the owner can always walk out.
        if (isSelf && !targetIsOwner) {
          remove = '<button type="button" class="ghost small-btn mcf-fed-remove" data-fed-leave="' +
            MCF.escapeHtml(member.username) + '">Leave</button>';
        }

        return '<div class="mcf-fed-manage-row">' +
          '<div class="mcf-fed-manage-person">' +
            '<strong>' + MCF.escapeHtml(member.display || member.username) + '</strong>' +
            ' <span class="small muted">@' + MCF.escapeHtml(member.username) + '</span>' +
            ' <span class="mcf-fed-presence' + (member.online ? ' mcf-fed-presence-online' : '') + '">' +
              MCF.escapeHtml(presenceLabel(member)) + '</span>' +
          '</div>' +
          '<div class="mcf-fed-manage-actions">' + roleCell + remove + '</div>' +
        '</div>';
      }).join('');

      panel.innerHTML =
        '<p class="small muted">' + (viewerIsOwner
          ? 'You run this federation: hand out roles, or remove a member.'
          : 'You are an admin here. The owner manages other admins.') + '</p>' +
        requestBlock(fed) +
        '<div class="mcf-fed-manage-list">' + rows + '</div>' +
        '<div class="mcf-row-actions">' +
          '<button type="button" class="ghost small-btn" id="mcfFedRefreshMembers">Refresh</button>' +
          '<span class="small muted" id="mcfFedManageStatus"></span>' +
        '</div>';

      panel.querySelector('#mcfFedRefreshMembers').addEventListener('click', function () {
        refresh();
      });

      panel.querySelectorAll('[data-fed-role]').forEach(function (select) {
        select.addEventListener('change', function () {
          setRole(select, select.dataset.fedRole, select.value);
        });
      });

      panel.querySelectorAll('[data-fed-remove]').forEach(function (button) {
        var username = button.dataset.fedRemove;
        arm(button, 'Remove', 'Confirm remove', function () { removeMember(username); });
      });
      panel.querySelectorAll('[data-fed-leave]').forEach(function (button) {
        var username = button.dataset.fedLeave;
        arm(button, 'Leave', 'Confirm leave', function () { removeMember(username); });
      });

      panel.querySelectorAll('[data-fed-approve]').forEach(function (button) {
        button.addEventListener('click', function () {
          decideRequest(button.dataset.fedApprove, 'approve');
        });
      });
      panel.querySelectorAll('[data-fed-reject]').forEach(function (button) {
        button.addEventListener('click', function () {
          decideRequest(button.dataset.fedReject, 'reject');
        });
      });
    }

    function manageStatus(message) {
      var el = box.body.querySelector('#mcfFedManageStatus');
      if (el) el.textContent = message || '';
    }

    /** People waiting to be let in — the same requests the owner's DM lists. */
    function requestBlock(fed) {
      var requests = fed.requests || [];
      if (!requests.length) return '';

      var rows = requests.map(function (request) {
        var username = request.username;
        return '<div class="mcf-fed-manage-row mcf-fed-request-row">' +
          '<div class="mcf-fed-manage-person">' +
            '<strong>@' + MCF.escapeHtml(username) + '</strong>' +
            '<span class="mcf-fed-presence">asked ' +
              MCF.escapeHtml(MCF.agoLabel(request.requestedAt)) + '</span>' +
          '</div>' +
          '<div class="mcf-fed-manage-actions">' +
            '<button type="button" class="small-btn" data-fed-approve="' +
              MCF.escapeHtml(username) + '">Approve</button>' +
            '<button type="button" class="ghost small-btn" data-fed-reject="' +
              MCF.escapeHtml(username) + '">Reject</button>' +
          '</div>' +
        '</div>';
      }).join('');

      return '<div class="mcf-fed-requests">' +
        '<h4 class="mcf-fed-requests-title">Join requests' +
          '<span class="mcf-fed-tag">' + requests.length + '</span></h4>' +
        rows +
      '</div>';
    }

    /** Approve (they join) or reject (they are told, and may ask again). */
    function decideRequest(username, decision) {
      if (state.busy) return;
      state.busy = true;
      manageStatus(decision === 'approve' ? 'Approving…' : 'Rejecting…');

      MCF.postJSON(
        '/api/federations/' + encodeURIComponent(state.federation.id) +
          '/requests/' + encodeURIComponent(username) + '/' + decision,
        {}
      )
        .then(function (data) {
          state.busy = false;
          if (!data || !data.ok) {
            var message = errorText(data && data.error);
            manageStatus(message);
            MCF.toast(message, 'error');
            refresh();
            return;
          }
          apply(data.federation);
          MCF.toast(
            decision === 'approve'
              ? '@' + username + ' joined ' + state.federation.name
              : 'Request from @' + username + ' rejected',
            'success'
          );
        })
        .catch(function () {
          state.busy = false;
          manageStatus('Could not answer that request.');
        });
    }

    function setRole(select, username, roleId) {
      if (state.busy) return;
      state.busy = true;
      select.disabled = true;
      manageStatus('Saving…');

      MCF.postJSON(
        '/api/federations/' + encodeURIComponent(state.federation.id) +
          '/members/' + encodeURIComponent(username) + '/role',
        { roleId: roleId }
      ).then(function (data) {
        state.busy = false;
        select.disabled = false;

        if (!data || !data.ok) {
          var message = errorText(data && data.error);
          manageStatus(message);
          MCF.toast(message, 'error');
          refresh();
          return;
        }
        apply(data.federation);
        MCF.toast('Role updated', 'success');
      });
    }

    function removeMember(username) {
      if (state.busy) return;
      state.busy = true;
      manageStatus('Removing…');

      MCF.authFetch(
        '/api/federations/' + encodeURIComponent(state.federation.id) +
          '/members/' + encodeURIComponent(username),
        { method: 'DELETE' }
      )
        .then(function (res) { return res.json(); })
        .then(function (data) {
          state.busy = false;

          if (!data || !data.ok) {
            var message = errorText(data && data.error);
            manageStatus(message);
            MCF.toast(message, 'error');
            refresh();
            return;
          }

          if (data.selfRemoved) {
            cacheMembership(null);
            box.close();
            MCF.toast('You left ' + state.federation.name, 'success');
            return;
          }

          apply(data.federation);
          MCF.toast('@' + username + ' was removed', 'success');
        })
        .catch(function () {
          state.busy = false;
          manageStatus('Could not remove that member.');
        });
    }

    /* ---------- tab 2: the roles ---------- */

    function roleEditorHtml(fed, role, owner) {
      var editing = !!role;
      var tag = editing ? 'data-fed-role-edit-row="' + MCF.escapeHtml(role.id) + '"' : '';
      return '<div class="mcf-fed-role-editor" id="mcfFedRoleEditor" ' + tag + '>' +
        '<p class="mcf-fed-role-editor-title">' +
          (editing ? 'Editing “' + MCF.escapeHtml(role.name) + '”' : 'Add a role') +
        '</p>' +
        '<div class="mcf-fed-role-editor-fields">' +
          '<input class="mcf-input" type="text" data-fed-role-name maxlength="24" ' +
            'aria-label="Role name" placeholder="Role name" value="' +
            MCF.escapeHtml(role ? role.name : '') + '">' +
          '<input class="mcf-input" type="text" data-fed-role-desc maxlength="120" ' +
            'aria-label="Role description" placeholder="What it is for (optional)" value="' +
            MCF.escapeHtml(role ? role.description : '') + '">' +
        '</div>' +
        (owner
          ? '<label class="mcf-fed-role-admin"><input type="checkbox" data-fed-role-admin' +
            (role && role.admin ? ' checked' : '') + '> Can manage the federation</label>'
          : '<p class="small muted">Only the owner can give a role management rights.</p>') +
        '<div class="mcf-row-actions">' +
          '<button type="button" class="small-btn" data-fed-role-save>' +
            (editing ? 'Save role' : 'Add role') + '</button>' +
          (editing ? '<button type="button" class="ghost small-btn" data-fed-role-cancel>Cancel</button>' : '') +
        '</div>' +
      '</div>';
    }

    function renderRolesTab(panel) {
      var fed = state.federation;
      var owner = !!fed.isOwner;

      var builtIns = (fed.roles || []).filter(function (role) { return role.builtIn; });
      var custom = (fed.roles || []).filter(function (role) { return !role.builtIn; });

      var builtRows = builtIns.map(function (role) {
        return '<div class="mcf-fed-manage-row mcf-fed-role-builtin">' +
          '<div class="mcf-fed-role-copy"><strong>' + MCF.escapeHtml(role.name) + '</strong>' +
            '<span class="mcf-fed-tag">Built in</span>' +
            (role.description
              ? '<span class="small muted">' + MCF.escapeHtml(role.description) + '</span>'
              : '') +
          '</div>' +
        '</div>';
      }).join('');

      var customRows = custom.map(function (role) {
        if (state.editingRoleId === role.id) {
          return '<div class="mcf-fed-manage-row mcf-fed-role-row-editing">' +
            roleEditorHtml(fed, role, owner) + '</div>';
        }
        // Only the owner may touch a role that carries management rights.
        var canTouch = owner || !role.admin;
        return '<div class="mcf-fed-manage-row">' +
          '<div class="mcf-fed-role-copy"><strong>' + MCF.escapeHtml(role.name) + '</strong>' +
            (role.admin ? '<span class="mcf-fed-tag mcf-fed-role-admin-tag">Can manage</span>' : '') +
            (role.description
              ? '<span class="small muted">' + MCF.escapeHtml(role.description) + '</span>'
              : '') +
          '</div>' +
          '<div class="mcf-fed-role-actions">' +
            (canTouch
              ? '<button type="button" class="ghost small-btn" data-fed-role-edit="' +
                MCF.escapeHtml(role.id) + '">Edit</button>' +
                '<button type="button" class="ghost small-btn" data-fed-role-delete="' +
                MCF.escapeHtml(role.id) + '">Delete</button>'
              : '') +
          '</div>' +
        '</div>';
      }).join('');

      panel.innerHTML =
        '<p class="small muted">Owner, Co-owner and Member are built in. Add the roles your ' +
          'members can hold — tick “Can manage” to let that role run this federation.</p>' +
        '<div class="mcf-fed-manage-list">' + builtRows +
          (customRows || '<p class="small muted">No custom roles yet — add the first one below.</p>') +
        '</div>' +
        (state.editingRoleId ? '' : roleEditorHtml(fed, null, owner)) +
        '<div class="mcf-row-actions">' +
          '<span class="small muted" id="mcfFedManageStatus"></span>' +
        '</div>';

      panel.querySelectorAll('[data-fed-role-edit]').forEach(function (button) {
        button.addEventListener('click', function () {
          state.editingRoleId = button.dataset.fedRoleEdit;
          render();
        });
      });
      panel.querySelectorAll('[data-fed-role-delete]').forEach(function (button) {
        var roleId = button.dataset.fedRoleDelete;
        arm(button, 'Delete', 'Confirm delete', function () { deleteRole(roleId); });
      });

      var editor = panel.querySelector('#mcfFedRoleEditor');
      if (!editor) return;

      var save = editor.querySelector('[data-fed-role-save]');
      if (save) {
        save.addEventListener('click', function () {
          if (state.editingRoleId) saveRole(editor, state.editingRoleId);
          else addRole(editor);
        });
      }
      var cancel = editor.querySelector('[data-fed-role-cancel]');
      if (cancel) {
        cancel.addEventListener('click', function () {
          state.editingRoleId = null;
          render();
        });
      }
    }

    /** Read one role draft out of its editor inputs. */
    function roleDraft(editor) {
      var name = editor.querySelector('[data-fed-role-name]');
      var description = editor.querySelector('[data-fed-role-desc]');
      var admin = editor.querySelector('[data-fed-role-admin]');
      return {
        name: name ? name.value.trim() : '',
        description: description ? description.value.trim() : '',
        admin: !!(admin && admin.checked)
      };
    }

    function roleDraftError(payload) {
      if (!payload.name) return 'Give the role a name.';
      if (payload.name.length < 2) return 'Role names need at least two letters.';
      return '';
    }

    function rolesUrl(suffix) {
      return '/api/federations/' + encodeURIComponent(state.federation.id) + '/roles' + (suffix || '');
    }

    function roleRequest(request) {
      if (state.busy) return;
      state.busy = true;
      manageStatus(request.busyLabel);

      request.run()
        .then(function (data) {
          state.busy = false;
          if (!data || !data.ok) {
            var message = errorText(data && data.error);
            manageStatus(message);
            MCF.toast(message, 'error');
            return;
          }
          state.editingRoleId = null;
          apply(data.federation);
          MCF.toast(request.doneLabel, 'success');
        })
        .catch(function () {
          state.busy = false;
          manageStatus(request.failLabel);
        });
    }

    function addRole(editor) {
      var payload = roleDraft(editor);
      var problem = roleDraftError(payload);
      if (problem) {
        manageStatus(problem);
        return;
      }
      roleRequest({
        busyLabel: 'Adding…',
        doneLabel: payload.name + ' added',
        failLabel: 'Could not add that role.',
        run: function () {
          return MCF.postJSON(rolesUrl(), payload);
        }
      });
    }

    function saveRole(editor, roleId) {
      var payload = roleDraft(editor);
      var problem = roleDraftError(payload);
      if (problem) {
        manageStatus(problem);
        return;
      }
      roleRequest({
        busyLabel: 'Saving…',
        doneLabel: payload.name + ' saved',
        failLabel: 'Could not save that role.',
        run: function () {
          return MCF.postJSON(rolesUrl('/' + encodeURIComponent(roleId)), payload, 'PATCH');
        }
      });
    }

    function deleteRole(roleId) {
      roleRequest({
        busyLabel: 'Deleting…',
        doneLabel: 'Role deleted',
        failLabel: 'Could not delete that role.',
        run: function () {
          return MCF.authFetch(rolesUrl('/' + encodeURIComponent(roleId)), { method: 'DELETE' })
            .then(function (res) { return res.json(); });
        }
      });
    }

    /* ---------- tab 3: the details ---------- */

    function renderDetails(panel) {
      var fed = state.federation;
      var preview = fed.imageUrl
        ? '<img id="mcfFedDetailsPreview" class="mcf-fed-image-preview" src="' +
          MCF.escapeHtml(fed.imageUrl) + '" alt="">'
        : '<img id="mcfFedDetailsPreview" class="mcf-fed-image-preview" alt="" hidden>';

      panel.innerHTML =
        '<p class="small muted">This is what the Join list shows, plus the rules your members play by.</p>' +
        '<div class="mcf-field"><label for="mcfFedDetailsName">Federation name</label>' +
          '<input class="mcf-input" type="text" id="mcfFedDetailsName" maxlength="40" value="' +
            MCF.escapeHtml(fed.name) + '"></div>' +
        '<div class="mcf-field"><label for="mcfFedDetailsDescription">Description</label>' +
          '<textarea class="mcf-input" id="mcfFedDetailsDescription" rows="3" maxlength="600">' +
            MCF.escapeHtml(fed.description) + '</textarea></div>' +
        '<div class="mcf-field"><label for="mcfFedDetailsRules">Rules</label>' +
          '<textarea class="mcf-input" id="mcfFedDetailsRules" rows="4" maxlength="1500">' +
            MCF.escapeHtml(fed.rules) + '</textarea></div>' +
        '<div class="mcf-field"><label for="mcfFedDetailsImage">Federation image</label>' +
          '<div class="mcf-fed-image-row">' + preview +
            '<div>' +
              '<input type="file" id="mcfFedDetailsImage" accept="image/*">' +
              '<div class="small muted" id="mcfFedDetailsImageStatus">Leave it alone to keep the current image.</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="mcf-row-actions">' +
          '<button type="button" class="small-btn" id="mcfFedDetailsSave">Save details</button>' +
          '<span class="small muted" id="mcfFedManageStatus"></span>' +
        '</div>';

      panel.querySelector('#mcfFedDetailsImage').addEventListener('change', function (event) {
        uploadFederationImage(
          event.target.files && event.target.files[0],
          panel.querySelector('#mcfFedDetailsImageStatus'),
          panel.querySelector('#mcfFedDetailsPreview'),
          function (url) { state.imageUrl = url; }
        );
      });

      panel.querySelector('#mcfFedDetailsSave').addEventListener('click', function () {
        if (state.busy) return;
        state.busy = true;
        var button = panel.querySelector('#mcfFedDetailsSave');
        button.disabled = true;
        manageStatus('Saving…');

        MCF.authFetch('/api/federations/' + encodeURIComponent(fed.id), {
          method: 'PATCH',
          body: JSON.stringify({
            name: panel.querySelector('#mcfFedDetailsName').value,
            description: panel.querySelector('#mcfFedDetailsDescription').value,
            rules: panel.querySelector('#mcfFedDetailsRules').value,
            imageUrl: state.imageUrl
          })
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            state.busy = false;
            button.disabled = false;

            if (!data || !data.ok) {
              var message = errorText(data && data.error);
              manageStatus(message);
              MCF.toast(message, 'error');
              return;
            }
            apply(data.federation);
            MCF.toast('Federation details saved', 'success');
          })
          .catch(function () {
            state.busy = false;
            button.disabled = false;
            manageStatus('Could not save the details.');
          });
      });
    }

    render();
  }

  function showFederation(federation) {
    var box = MCF.popup({ title: federation.name, label: federation.name + ' federation', wide: true });

    var roles = (federation.roles || []).map(function (role) {
      return '<li><strong>' + MCF.escapeHtml(role.name) + '</strong>' +
        (role.admin ? ' <span class="mcf-fed-tag">admin</span>' : '') +
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
            (federation.isOwner
              ? 'You run this federation.'
              : (federation.canManage
                ? 'You help manage this federation.'
                : 'You are a member of this federation.')) +
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
      '<div class="mcf-row-actions">' +
        (federation.canManage
          ? '<button type="button" class="small-btn" id="mcfFedManageFromCard">Manage federation</button>'
          : '') +
        '<button type="button" class="ghost small-btn" id="mcfFedOpenChat">Open chatroom</button>' +
      '</div>';

    box.body.querySelector('#mcfFedOpenChat').addEventListener('click', function () {
      box.close();
      openChatroom();
    });

    var manageButton = box.body.querySelector('#mcfFedManageFromCard');
    if (manageButton) {
      manageButton.addEventListener('click', function () {
        box.close();
        openManage();
      });
    }
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

      // Each federation reads like a row on the user roster: a big square
      // image, its name over the owner/member line and its description
      // underneath, with the Join button where the roster keeps its actions.
      var rows = (data.federations || []).map(function (federation) {
        var mine = membership && membership.id === federation.id;
        var requested = !!federation.requested;
        var image = federation.imageUrl
          ? '<img class="mcf-fed-roster-thumb" src="' + MCF.escapeHtml(federation.imageUrl) + '" alt="">'
          : '<span class="mcf-fed-roster-thumb mcf-fed-hero-empty" aria-hidden="true">' +
            MCF.escapeHtml(String(federation.name || '?').slice(0, 2).toUpperCase()) + '</span>';
        var members = federation.memberCount === 1 ? '1 member' : federation.memberCount + ' members';

        return '<div class="mcf-fed-join-row" data-fed-join-row="' +
            MCF.escapeHtml(federation.id) + '">' +
          image +
          '<div class="mcf-fed-roster-copy">' +
            '<div class="mcf-fed-roster-name">' + MCF.escapeHtml(federation.name) + '</div>' +
            '<div class="mcf-fed-roster-meta">@' + MCF.escapeHtml(federation.owner) +
              ' · ' + members + '</div>' +
            (federation.description
              ? '<div class="mcf-fed-roster-desc">' + MCF.escapeHtml(federation.description) + '</div>'
              : '') +
          '</div>' +
          '<div class="mcf-fed-roster-actions">' +
            (mine
              ? '<span class="mcf-fed-tag">Yours</span>'
              : (requested
                ? '<span class="mcf-fed-tag">Requested</span>'
                : '<button type="button" class="small-btn" data-join="' +
                  MCF.escapeHtml(federation.id) + '"' +
                  (membership ? ' disabled' : '') + '>Join</button>')) +
          '</div>' +
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

  /**
   * Join is a request. The owner gets a DM they can approve or reject from,
   * and Manage → Members shows the same pending list to every manager.
   */
  function join(button, box) {
    var id = button.dataset.join;
    var status = box.body.querySelector('#mcfFedJoinStatus');
    button.disabled = true;
    if (status) status.textContent = 'Sending your request…';

    MCF.postJSON('/api/federations/' + encodeURIComponent(id) + '/join', {}).then(function (data) {
      if (!data || !data.ok) {
        var message = errorText(data && data.error);
        if (status) status.textContent = message;
        MCF.toast(message, 'error');
        button.disabled = false;
        return;
      }

      box.close();
      MCF.toast(
        'Request sent to @' + data.owner + ' — they will approve or reject it',
        'success'
      );
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

  /**
   * A floating, movable chatroom, like the arena chat, with the federation's
   * online members down the side. One window at a time: asking again brings
   * the open one to the front instead of stacking copies.
   */
  function showChatroom(federation) {
    if (!federation.isMember) {
      MCF.toast('Only members can open this chatroom', 'error');
      return;
    }
    if (openChat && openChat.el.isConnected) {
      openChat.focus();
      return;
    }

    var timer = null;
    var me = session();
    var el = document.createElement('div');
    el.className = 'mcf-fed-chat-window';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', federation.name + ' chatroom');
    el.innerHTML =
      '<div class="mcf-fed-chat-head" data-fed-chat-drag>' +
        '<div class="mcf-fed-chat-title">' +
          '<strong>' + MCF.escapeHtml(federation.name) + '</strong>' +
          '<span class="small muted">Federation chatroom</span>' +
        '</div>' +
        '<button type="button" class="ghost small-btn" data-fed-chat-close ' +
          'aria-label="Close chatroom">✕</button>' +
      '</div>' +
      '<div class="mcf-fed-chat-main">' +
        '<div class="mcf-fed-chat-log mcf-fed-chat-feed" id="mcfFedChatLog" aria-live="polite">' +
          '<p class="small muted">Loading…</p>' +
        '</div>' +
        '<aside class="mcf-fed-chat-people" aria-label="Federation members online">' +
          '<div class="mcf-fed-chat-people-title">Online <span id="mcfFedChatOnlineCount">0</span></div>' +
          '<div id="mcfFedChatOnline" class="mcf-fed-chat-online"></div>' +
        '</aside>' +
      '</div>' +
      '<div class="mcf-fed-chat-compose">' +
        '<input class="mcf-input" type="text" id="mcfFedChatInput" maxlength="500" ' +
          'placeholder="Message your federation" aria-label="Write a federation message" ' +
          'enterkeyhint="send">' +
        '<button type="button" class="small-btn" id="mcfFedChatSend">Send</button>' +
      '</div>' +
      '<span class="small muted mcf-fed-chat-status" id="mcfFedChatStatus"></span>';

    document.body.appendChild(el);

    var log = el.querySelector('#mcfFedChatLog');
    var input = el.querySelector('#mcfFedChatInput');
    var status = el.querySelector('#mcfFedChatStatus');
    var onlineHost = el.querySelector('#mcfFedChatOnline');
    var onlineCount = el.querySelector('#mcfFedChatOnlineCount');
    var messagesUrl = '/api/federations/' + encodeURIComponent(federation.id) + '/messages';
    var presenceUrl = '/api/federations/' + encodeURIComponent(federation.id) + '/presence';

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

    /** Only federation members the arena sees as online — nobody else. */
    function renderOnline(people) {
      var online = Array.isArray(people) ? people : [];
      onlineCount.textContent = String(online.length);
      if (!online.length) {
        onlineHost.innerHTML = '<p class="small muted">Nobody is online right now.</p>';
        return;
      }
      onlineHost.innerHTML = online.map(function (person) {
        var self = !!me && person.username === me.username;
        return '<div class="mcf-fed-chat-member">' +
          '<span class="mcf-fed-chat-dot" aria-hidden="true"></span>' +
          '<span class="mcf-fed-chat-member-name">' +
            MCF.escapeHtml(person.display || person.username) +
            (self ? ' <span class="mcf-fed-chat-you">you</span>' : '') +
          '</span>' +
        '</div>';
      }).join('');
    }

    function loadPresence() {
      return MCF.getJSON(presenceUrl).then(function (data) {
        if (data && data.ok) renderOnline(data.online);
      });
    }

    function load() {
      loadPresence();
      return MCF.getJSON(messagesUrl).then(function (data) {
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

      MCF.postJSON(messagesUrl, { text: text }).then(function (data) {
        if (!data || !data.ok) {
          if (status) status.textContent = errorText(data && data.error);
          input.value = text;
          return;
        }
        render(data.messages);
        log.scrollTop = log.scrollHeight;
      });
    }

    function close() {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('keydown', onKey);
      el.remove();
      if (openChat && openChat.el === el) openChat = null;
    }

    function onKey(event) {
      if (event.key === 'Escape') close();
    }

    function focus() {
      el.style.zIndex = String(++chatZ);
    }

    el.addEventListener('mousedown', focus);
    el.querySelector('[data-fed-chat-close]').addEventListener('click', close);
    el.querySelector('#mcfFedChatSend').addEventListener('click', send);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        send();
      }
    });
    document.addEventListener('keydown', onKey);
    makeChatMovable(el);

    openChat = { el: el, focus: focus };
    focus();

    load();
    timer = setInterval(load, CHAT_POLL_MS);
  }

  /**
   * Drag the window by its header. On phones it is a full-screen sheet, so
   * there is nothing to drag — the same CSS that sizes it turns this off.
   */
  function makeChatMovable(el) {
    var head = el.querySelector('[data-fed-chat-drag]');
    if (!head) return;

    var dragging = false;
    var startX = 0;
    var startY = 0;
    var startLeft = 0;
    var startTop = 0;

    function move(event) {
      if (!dragging) return;
      var left = startLeft + (event.clientX - startX);
      var top = startTop + (event.clientY - startY);
      left = Math.max(0, Math.min(left, window.innerWidth - 120));
      top = Math.max(0, Math.min(top, window.innerHeight - 60));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }

    function stop() {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('mcf-fed-chat-dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', stop);
    }

    head.addEventListener('mousedown', function (event) {
      if (event.target.closest && event.target.closest('button')) return;
      if (window.innerWidth <= 768) return;

      var rect = el.getBoundingClientRect();
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';

      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      el.classList.add('mcf-fed-chat-dragging');
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', stop);
      event.preventDefault();
    });
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
