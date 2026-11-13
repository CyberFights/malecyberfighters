/* ============================================================
   federation-tournaments.js — federation vs federation brackets
   ------------------------------------------------------------
   The "Tournaments" button in the Federations section, and the
   three windows behind it:

     Federation Tournaments  the hub: invitations waiting on you,
                             your federation's tournaments, and what
                             is running elsewhere.
     Challenge a federation  pick the opponent; the challenge lands
                             in its owner's DMs and waits for an
                             answer.
     the bracket             two lineups of up to sixteen wrestlers,
                             and — once both owners lock theirs in —
                             the single-elimination bracket the server
                             drew from them.

   A manager of a federation (owner, or a role marked admin) picks that
   side's lineup and may report results; everybody signed in can open a
   bracket to watch. The rules themselves live on the server
   (federationTournaments.js) — this module only draws them.

   Depends on features-core.js (window.MCF).
============================================================ */
(function () {
  'use strict';

  if (!window.MCF) return;

  var MAX_ENTRANTS = 16;

  var ERROR_TEXT = {
    not_allowed: 'That account cannot use tournaments.',
    not_in_federation: 'Join or create a federation first.',
    not_a_manager: 'Only the owner and the federation’s co-owners/admins can do that.',
    not_in_tournament: 'Your federation is not in this tournament.',
    not_the_opponent: 'Only the challenged federation can answer this invitation.',
    opponent_required: 'Pick a federation to challenge.',
    opponent_not_found: 'That federation no longer exists.',
    cannot_challenge_self: 'You cannot challenge your own federation.',
    tournament_exists: 'You already have an open tournament with that federation.',
    tournament_not_found: 'That tournament no longer exists.',
    tournament_not_draft: 'The lineups are closed — the bracket has already started.',
    tournament_not_active: 'That tournament is not running.',
    tournament_started: 'The bracket has started — it cannot be called off now.',
    roster_locked: 'Your lineup is locked in. Unlock it to change it.',
    roster_empty: 'Pick at least one wrestler before locking the lineup.',
    entrants_invalid: 'That lineup could not be read — try again.',
    too_many_entrants: 'A lineup holds at most ' + MAX_ENTRANTS + ' wrestlers.',
    not_a_member: 'Only members of your federation can wrestle for it.',
    match_not_found: 'That match is no longer on the card.',
    round_locked: 'That round is already in the books.',
    match_has_no_opponent: 'That wrestler has a bye — there is nobody to beat.',
    bad_winner: 'Pick one of the two wrestlers.',
    already_answered: 'That invitation has already been answered.',
    auth_required: 'Sign in to run a tournament.',
    server_error: 'Something went wrong — try again in a moment.'
  };

  var STATUS_TEXT = {
    pending: 'Awaiting answer',
    draft: 'Picking lineups',
    active: 'Bracket running',
    complete: 'Finished',
    declined: 'Declined',
    cancelled: 'Called off'
  };

  function esc(value) { return MCF.escapeHtml(value); }
  function errorText(code) { return ERROR_TEXT[code] || 'Something went wrong — try again.'; }
  function statusLabel(status) { return STATUS_TEXT[status] || String(status || ''); }
  function session() { return MCF.session(); }

  function bindAll(id, handler) {
    document.querySelectorAll('[id="' + id + '"]').forEach(function (el) {
      el.addEventListener('click', handler);
    });
  }

  function api(url, body, method) {
    return MCF.postJSON(url, body || {}, method).then(function (data) {
      if (!data || !data.ok) {
        MCF.toast(errorText(data && data.error), 'error');
        return null;
      }
      return data;
    });
  }

  function initials(name) {
    return String(name || '?').slice(0, 2).toUpperCase();
  }

  function sideHead(tournament, key) {
    var side = tournament[key];
    var thumb = side.imageUrl
      ? '<img class="mcf-tourn-thumb" src="' + esc(side.imageUrl) + '" alt="">'
      : '<span class="mcf-tourn-thumb mcf-fed-hero-empty" aria-hidden="true">' + esc(initials(side.name)) + '</span>';
    var wrestlers = side.count === 1 ? '1 wrestler' : side.count + ' wrestlers';

    return '<div class="mcf-tourn-side' + (side.isViewerFederation ? ' mcf-tourn-side-you' : '') + '">' +
      thumb +
      '<div class="mcf-tourn-side-copy">' +
        '<strong>' + esc(side.name) + '</strong>' +
        '<span class="small muted">@' + esc(side.owner) + ' · ' + wrestlers + '</span>' +
      '</div>' +
    '</div>';
  }

  function summary(tournament) {
    if (tournament.status === 'pending') {
      return tournament.away.isViewerFederation
        ? 'They are waiting for your answer.'
        : 'Waiting for ' + tournament.away.name + ' to answer.';
    }
    if (tournament.status === 'draft') {
      return 'Lineups: ' + tournament.home.count + ' vs ' + tournament.away.count +
        ' of ' + MAX_ENTRANTS + '.';
    }
    if (tournament.status === 'active') {
      var round = tournament.rounds[tournament.rounds.length - 1];
      if (!round) return 'The bracket is being drawn.';
      var left = round.matches.filter(function (match) { return !match.winner; }).length;
      return round.label + ' — ' + left + (left === 1 ? ' match' : ' matches') + ' to report.';
    }
    if (tournament.status === 'complete' && tournament.champion) {
      return '🏆 ' + tournament.champion.display + ' (' + tournament.champion.federationName + ') won it.';
    }
    return statusLabel(tournament.status) + '.';
  }

  function chip(tournament) {
    return '<span class="mcf-tourn-chip mcf-tourn-chip-' + esc(tournament.status) + '">' +
      esc(statusLabel(tournament.status)) + '</span>';
  }

  /* ---------------------------------------------------------
     THE HUB
  --------------------------------------------------------- */

  function open() {
    if (!session()) {
      MCF.toast('Sign in to run a tournament', 'error');
      return;
    }

    var state = { data: null, busy: false };
    var box = MCF.popup({
      title: 'Federation Tournaments',
      label: 'Federation tournaments',
      wide: true
    });

    function row(tournament) {
      var id = esc(tournament.id);
      var actions = [];

      if (tournament.status === 'pending' && tournament.away.isViewerFederation && tournament.away.canManage) {
        actions.push('<button type="button" class="small-btn" data-tourn-accept="' + id + '">Accept</button>');
        actions.push('<button type="button" class="ghost small-btn" data-tourn-decline="' + id + '">Decline</button>');
      }
      if (tournament.status === 'pending' && tournament.home.isViewerFederation && tournament.home.canManage) {
        actions.push('<button type="button" class="ghost small-btn" data-tourn-cancel="' + id + '">Withdraw</button>');
      }
      actions.push('<button type="button" class="ghost small-btn" data-tourn-open="' + id + '">' +
        (tournament.rounds.length ? 'Bracket' : 'Open') + '</button>');

      return '<li class="mcf-tourn-row" data-tourn-id="' + id + '">' +
        '<div class="mcf-tourn-row-head">' +
          '<strong>' + esc(tournament.title || (tournament.home.name + ' vs ' + tournament.away.name)) + '</strong>' +
          chip(tournament) +
        '</div>' +
        '<p class="small muted">' + esc(summary(tournament)) + '</p>' +
        '<div class="mcf-row-actions">' + actions.join('') + '</div>' +
      '</li>';
    }

    function section(title, items, empty) {
      if (!items.length && !empty) return '';
      return '<section class="mcf-tourn-section">' +
        '<h4 class="mcf-tourn-section-title">' + esc(title) + '</h4>' +
        (items.length
          ? '<ul class="mcf-tourn-rows">' + items.map(row).join('') + '</ul>'
          : '<p class="small muted">' + esc(empty) + '</p>') +
      '</section>';
    }

    function render() {
      var data = state.data;
      if (!data) {
        box.body.innerHTML = '<p class="small muted">Loading tournaments…</p>';
        return;
      }

      var federation = data.federation;
      var mine = data.mine || [];
      var recent = data.recent || [];

      var html = '';

      if (!federation) {
        html += '<p class="mcf-fed-notice">Tournaments are fought between two federations. You need to run ' +
          '(or help run) one before you can challenge anybody.</p>' +
          '<div class="mcf-row-actions">' +
            '<button type="button" class="small-btn" data-tourn-create-federation>Create a federation</button>' +
            '<button type="button" class="ghost small-btn" data-tourn-join-federation>Browse federations</button>' +
          '</div>';
        box.body.innerHTML = html;
        return;
      }

      html += '<div class="mcf-tourn-banner">' +
        '<div><strong>' + esc(federation.name) + '</strong>' +
        '<div class="small muted">' +
          (federation.canManage
            ? 'Challenge another federation and pick up to ' + MAX_ENTRANTS + ' of your wrestlers.'
            : 'Only the owner and the federation’s admins can enter wrestlers.') +
        '</div></div>' +
        (federation.canManage
          ? '<button type="button" class="small-btn" data-tourn-challenge>Challenge a federation</button>'
          : '') +
      '</div>';

      var invitations = mine.filter(function (tournament) {
        return tournament.status === 'pending' &&
          tournament.away.isViewerFederation && tournament.away.canManage;
      });
      html += section('Invitations', invitations, '');

      var ours = mine.filter(function (tournament) { return invitations.indexOf(tournament) === -1; });
      html += section('Your tournaments', ours, 'No tournaments yet — challenge a federation to start one.');

      html += section('Running now', recent, '');

      box.body.innerHTML = html;
    }

    function refresh() {
      return MCF.getJSON('/api/federations/tournaments').then(function (data) {
        if (!data || !data.ok) {
          MCF.toast('Could not load tournaments', 'error');
          return null;
        }
        state.data = data;
        render();
        return data;
      });
    }

    box.body.addEventListener('click', function (event) {
      var target = event.target.closest('[data-tourn-open], [data-tourn-accept], [data-tourn-decline], ' +
        '[data-tourn-cancel], [data-tourn-challenge], [data-tourn-create-federation], [data-tourn-join-federation]');
      if (!target) return;

      if (target.hasAttribute('data-tourn-open')) {
        openBracket(target.getAttribute('data-tourn-open'));
        return;
      }
      if (target.hasAttribute('data-tourn-challenge')) {
        openChallenge(refresh);
        return;
      }
      if (target.hasAttribute('data-tourn-create-federation')) {
        box.close();
        if (window.MCFFederations) window.MCFFederations.openCreate();
        return;
      }
      if (target.hasAttribute('data-tourn-join-federation')) {
        box.close();
        if (window.MCFFederations) window.MCFFederations.openJoin();
        return;
      }

      var id = target.getAttribute('data-tourn-accept') ||
        target.getAttribute('data-tourn-decline') ||
        target.getAttribute('data-tourn-cancel');
      if (!id) return;

      var base = '/api/federations/tournaments/' + encodeURIComponent(id);
      var request = target.hasAttribute('data-tourn-accept')
        ? api(base + '/accept')
        : target.hasAttribute('data-tourn-decline')
          ? api(base + '/decline')
          : api(base, {}, 'DELETE');

      target.disabled = true;
      request.then(function (data) {
        if (!data) {
          target.disabled = false;
          return;
        }
        refresh();
      });
    });

    render();
    refresh();
  }

  /* ---------------------------------------------------------
     CHALLENGE
  --------------------------------------------------------- */

  function openChallenge(onDone) {
    var box = MCF.popup({ title: 'Challenge a federation', label: 'Challenge a federation' });
    box.body.innerHTML = '<p class="small muted">Loading federations…</p>';

    MCF.getJSON('/api/federations').then(function (data) {
      if (!data || !data.ok) {
        box.body.innerHTML = '<p class="small muted">Could not load federations.</p>';
        return;
      }

      var membershipId = data.membership && data.membership.id ? String(data.membership.id) : '';
      var opponents = (data.federations || []).filter(function (federation) {
        return String(federation.id) !== membershipId;
      });

      if (!opponents.length) {
        box.body.innerHTML = '<p class="small muted">There is no other federation to challenge yet.</p>';
        return;
      }

      box.body.innerHTML =
        '<p class="small muted">Pick the federation you want across the ring. Its owner gets a direct ' +
          'message and accepts or declines it.</p>' +
        '<label class="mcf-tourn-field" for="mcfTournTitle">Event name <span class="small muted">(optional)</span></label>' +
        '<input id="mcfTournTitle" class="mcf-input" type="text" maxlength="60" placeholder="Iron Ring vs Steel Cage">' +
        '<fieldset class="mcf-tourn-opponents"><legend class="small muted">Opponent</legend>' +
          opponents.map(function (federation, index) {
            return '<label class="mcf-tourn-opponent">' +
              '<input type="radio" name="mcfTournOpponent" value="' + esc(federation.id) + '"' +
                (index === 0 ? ' checked' : '') + '>' +
              (federation.imageUrl
                ? '<img class="mcf-tourn-thumb" src="' + esc(federation.imageUrl) + '" alt="">'
                : '<span class="mcf-tourn-thumb mcf-fed-hero-empty" aria-hidden="true">' +
                  esc(initials(federation.name)) + '</span>') +
              '<span class="mcf-tourn-opponent-copy">' +
                '<strong>' + esc(federation.name) + '</strong>' +
                '<span class="small muted">@' + esc(federation.owner) + ' · ' +
                  (federation.memberCount === 1 ? '1 member' : federation.memberCount + ' members') + '</span>' +
              '</span>' +
            '</label>';
          }).join('') +
        '</fieldset>' +
        '<div class="mcf-row-actions">' +
          '<button type="button" class="small-btn" id="mcfTournSend">Send the challenge</button>' +
          '<button type="button" class="ghost small-btn" id="mcfTournCancel">Cancel</button>' +
        '</div>';

      box.body.querySelector('#mcfTournCancel').addEventListener('click', function () { box.close(); });

      box.body.querySelector('#mcfTournSend').addEventListener('click', function (event) {
        var picked = box.body.querySelector('input[name="mcfTournOpponent"]:checked');
        if (!picked) {
          MCF.toast(errorText('opponent_required'), 'error');
          return;
        }
        var button = event.currentTarget;
        button.disabled = true;

        api('/api/federations/tournaments', {
          opponentId: picked.value,
          title: box.body.querySelector('#mcfTournTitle').value
        }).then(function (result) {
          if (!result) {
            button.disabled = false;
            return;
          }
          box.close();
          MCF.toast('Challenge sent — its owner has been messaged.', 'success');
          if (typeof onDone === 'function') onDone();
          openBracket(result.tournament.id);
        });
      });
    });
  }

  /* ---------------------------------------------------------
     THE BRACKET
  --------------------------------------------------------- */

  function entrantLine(entrant) {
    if (!entrant) return '<span class="small muted">bye</span>';
    return '<strong>' + esc(entrant.display || entrant.username) + '</strong>' +
      '<span class="small muted">' + esc(entrant.federationName) + '</span>';
  }

  function matchCard(tournament, round, match) {
    var pickable = tournament.canDecide && round.current && !match.bye && !match.winner;

    function slot(key) {
      var who = match[key];
      var classes = 'mcf-tourn-slot' + (match.winner === key ? ' mcf-tourn-slot-win' : '') +
        (who ? '' : ' mcf-tourn-slot-bye');

      if (pickable && who) {
        return '<button type="button" class="' + classes + ' mcf-tourn-slot-pick"' +
          ' data-tourn-pick="' + key + '" data-tourn-match="' + esc(match.id) + '"' +
          ' title="Report ' + esc(who.display || who.username) + ' as the winner">' +
          entrantLine(who) + '</button>';
      }
      return '<div class="' + classes + '">' + entrantLine(who) + '</div>';
    }

    return '<li class="mcf-tourn-match' + (match.winner ? ' mcf-tourn-match-done' : '') + '">' +
      slot('home') + slot('away') +
    '</li>';
  }

  function bracketHtml(tournament) {
    return '<div class="mcf-tourn-bracket">' +
      tournament.rounds.map(function (round) {
        return '<section class="mcf-tourn-round" aria-label="' + esc(round.label) + '">' +
          '<h4 class="mcf-tourn-round-title">' + esc(round.label) + '</h4>' +
          '<ol class="mcf-tourn-matches">' +
            round.matches.map(function (match) { return matchCard(tournament, round, match); }).join('') +
          '</ol>' +
        '</section>';
      }).join('') +
    '</div>';
  }

  function lineupHtml(state, key) {
    var tournament = state.tournament;
    var side = tournament[key];
    var editable = tournament.editableSide === key && Array.isArray(state.members);
    var locked = side.ready;

    var body;
    if (editable) {
      var chosen = state.chosen || [];
      body = '<div class="mcf-tourn-picker" data-tourn-picker>' +
        (state.members.length
          ? state.members.map(function (member) {
            var username = String(member.username || '');
            return '<label class="mcf-tourn-pick">' +
              '<input type="checkbox" value="' + esc(username) + '"' +
                (chosen.indexOf(username) === -1 ? '' : ' checked') + '>' +
              '<span>' + esc(member.display || username) + '</span>' +
            '</label>';
          }).join('')
          : '<p class="small muted">Your federation has no other members yet.</p>') +
      '</div>' +
      '<p class="small muted"><span data-tourn-count>' + chosen.length + '</span> / ' + MAX_ENTRANTS +
        ' picked — the order you pick them is the seed order.</p>' +
      '<div class="mcf-row-actions">' +
        '<button type="button" class="small-btn" data-tourn-save>Save lineup</button>' +
        '<button type="button" class="ghost small-btn" data-tourn-lock>Lock in lineup</button>' +
      '</div>';
    } else {
      body = side.entrants.length
        ? '<ol class="mcf-tourn-lineup">' + side.entrants.map(function (entrant, index) {
          return '<li><span class="mcf-tourn-seed">' + (index + 1) + '</span>' +
            esc(entrant.display || entrant.username) + '</li>';
        }).join('') + '</ol>'
        : '<p class="small muted">No wrestlers entered yet.</p>';

      if (side.canManage && locked) {
        body += '<div class="mcf-row-actions">' +
          '<button type="button" class="ghost small-btn" data-tourn-unlock>Unlock lineup</button>' +
        '</div>';
      }
    }

    return '<section class="mcf-tourn-lineup-card' + (side.isViewerFederation ? ' mcf-tourn-side-you' : '') + '"' +
      ' aria-label="' + esc(side.name) + ' lineup">' +
      '<header class="mcf-tourn-lineup-head">' +
        '<strong>' + esc(side.name) + '</strong>' +
        (locked ? '<span class="mcf-tourn-locked">Locked in</span>' : '') +
      '</header>' +
      body +
    '</section>';
  }

  function openBracket(id) {
    if (!session()) {
      MCF.toast('Sign in to open a bracket', 'error');
      return;
    }

    var state = {
      tournament: null,
      members: null,
      chosen: null,
      busy: false
    };

    var box = MCF.popup({ title: 'Tournament', label: 'Tournament bracket', wide: true });
    box.body.innerHTML = '<p class="small muted">Loading the bracket…</p>';

    function apply(tournament) {
      if (!tournament) return;
      var sideChanged = !state.tournament || state.tournament.editableSide !== tournament.editableSide;
      state.tournament = tournament;

      if (tournament.editableSide && (!state.members || sideChanged)) {
        // The picker needs this federation's own roster; /mine is the one
        // endpoint that hands a member their own member list.
        state.members = null;
        MCF.getJSON('/api/federations/mine').then(function (data) {
          var federation = data && data.ok ? data.federation : null;
          state.members = federation && federation.members ? federation.members : [];
          var editable = state.tournament && state.tournament.editableSide;
          state.chosen = editable
            ? (state.tournament[editable].entrants || []).map(function (entrant) { return entrant.username; })
            : [];
          render();
        });
      }

      render();
    }

    function render() {
      var tournament = state.tournament;
      if (!tournament) return;

      box.setTitle(tournament.title || (tournament.home.name + ' vs ' + tournament.away.name));

      var html = '<div class="mcf-tourn-head">' +
        sideHead(tournament, 'home') +
        '<span class="mcf-tourn-versus" aria-hidden="true">vs</span>' +
        sideHead(tournament, 'away') +
        chip(tournament) +
      '</div>';

      html += '<p class="small muted mcf-tourn-summary">' + esc(summary(tournament)) + '</p>';

      if (tournament.status === 'pending') {
        html += '<div class="mcf-tourn-answer">' +
          '<p>Waiting for <strong>' + esc(tournament.away.name) + '</strong> to answer.</p>' +
          (tournament.away.canManage
            ? '<div class="mcf-row-actions">' +
              '<button type="button" class="small-btn" data-tourn-accept>Accept the challenge</button>' +
              '<button type="button" class="ghost small-btn" data-tourn-decline>Decline</button>' +
            '</div>'
            : '') +
        '</div>';
      }

      if (tournament.status === 'draft' || tournament.status === 'active' || tournament.status === 'complete') {
        html += '<div class="mcf-tourn-lineups">' +
          lineupHtml(state, 'home') +
          lineupHtml(state, 'away') +
        '</div>';
      }

      if (tournament.rounds.length) html += bracketHtml(tournament);

      if (tournament.status === 'complete' && tournament.champion) {
        html += '<p class="mcf-tourn-champion">🏆 <strong>' + esc(tournament.champion.display) + '</strong> (' +
          esc(tournament.champion.federationName) + ') wins the tournament.</p>';
      }

      if (tournament.status === 'active' && tournament.canManage) {
        html += '<p class="small muted">Report each match by pressing the wrestler who won it. ' +
          'Results are final once the next round is drawn.</p>';
      }

      box.body.innerHTML = html;
      syncCount();
      bindPicker();
    }

    function syncCount() {
      var counter = box.body.querySelector('[data-tourn-count]');
      if (counter && state.chosen) counter.textContent = String(state.chosen.length);
    }

    function bindPicker() {
      var picker = box.body.querySelector('[data-tourn-picker]');
      if (!picker || !state.chosen) return;
      picker.addEventListener('change', function () {
        var picked = [];
        picker.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
          if (input.checked) picked.push(input.value);
        });
        if (picked.length > MAX_ENTRANTS) {
          var extra = picked.pop();
          var box2 = picker.querySelector('input[value="' + extra.replace(/"/g, '\\"') + '"]');
          if (box2) box2.checked = false;
          MCF.toast(errorText('too_many_entrants'), 'error');
        }
        state.chosen = picked;
        syncCount();
      });
    }

    function reload() {
      return MCF.getJSON('/api/federations/tournaments/' + encodeURIComponent(id)).then(function (data) {
        if (!data || !data.ok) {
          MCF.toast('Could not load the bracket', 'error');
          return null;
        }
        apply(data.tournament);
        return data.tournament;
      });
    }

    function saveRoster(thenLock) {
      if (state.busy) return Promise.resolve(null);
      state.busy = true;
      var base = '/api/federations/tournaments/' + encodeURIComponent(id);

      return api(base + '/roster', { entrants: (state.chosen || []).slice() }, 'PUT').then(function (saved) {
        if (!saved) {
          state.busy = false;
          return null;
        }
        state.tournament = saved.tournament;
        if (!thenLock) {
          state.busy = false;
          render();
          MCF.toast('Lineup saved.', 'success');
          return saved.tournament;
        }
        return api(base + '/ready', { ready: true }).then(function (locked) {
          state.busy = false;
          if (!locked) {
            render();
            return null;
          }
          apply(locked.tournament);
          MCF.toast(locked.tournament.status === 'active'
            ? 'Both lineups are in — the bracket is live!'
            : 'Lineup locked in.', 'success');
          return locked.tournament;
        });
      });
    }

    box.body.addEventListener('click', function (event) {
      var target = event.target.closest('[data-tourn-pick], [data-tourn-accept], [data-tourn-decline], ' +
        '[data-tourn-save], [data-tourn-lock], [data-tourn-unlock]');
      if (!target) return;

      var base = '/api/federations/tournaments/' + encodeURIComponent(id);

      if (target.hasAttribute('data-tourn-save')) {
        if (target.disabled) return;
        target.disabled = true;
        saveRoster(false);
        return;
      }
      if (target.hasAttribute('data-tourn-lock')) {
        if (target.disabled) return;
        target.disabled = true;
        saveRoster(true);
        return;
      }
      if (target.hasAttribute('data-tourn-unlock')) {
        if (target.disabled) return;
        target.disabled = true;
        api(base + '/ready', { ready: false }).then(function (data) {
          if (!data) {
            target.disabled = false;
            return;
          }
          apply(data.tournament);
        });
        return;
      }
      if (target.hasAttribute('data-tourn-accept')) {
        target.disabled = true;
        api(base + '/accept').then(function (data) {
          if (!data) {
            target.disabled = false;
            return;
          }
          apply(data.tournament);
        });
        return;
      }
      if (target.hasAttribute('data-tourn-decline')) {
        target.disabled = true;
        api(base + '/decline').then(function (data) {
          if (!data) {
            target.disabled = false;
            return;
          }
          apply(data.tournament);
        });
        return;
      }

      // A press on a wrestler reports them as the match's winner.
      var matchId = target.getAttribute('data-tourn-match');
      var winner = target.getAttribute('data-tourn-pick');
      if (!matchId || !winner) return;
      target.disabled = true;
      api(base + '/matches/' + encodeURIComponent(matchId), { winner: winner }).then(function (data) {
        if (!data) {
          target.disabled = false;
          return;
        }
        apply(data.tournament);
        if (data.tournament.status === 'complete' && data.tournament.champion) {
          MCF.toast('🏆 ' + data.tournament.champion.display + ' wins the tournament!', 'success');
        }
      });
    });

    reload();
  }

  /* ---------------------------------------------------------
     Wiring
  --------------------------------------------------------- */

  function bind() {
    bindAll('btnFederationTournaments', open);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFFederationTournaments = {
    open: open,
    openChallenge: openChallenge,
    openBracket: openBracket,
    MAX_ENTRANTS: MAX_ENTRANTS
  };
})();
