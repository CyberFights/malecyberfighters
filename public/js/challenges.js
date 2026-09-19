/* ============================================================
   challenges.js — formal match challenges (client)
   ------------------------------------------------------------
   The "you, me, the ring" offer: style, stakes, best-of and a
   terms checklist the guide insists on before any match. The
   opponent answers from this same window (or their DMs), and
   accepting opens the private match room that was created for
   the two of them.

   Rematch buttons live in the match record window (match-history.js)
   and call open() pre-filled from a past match.

   Depends on features-core.js and MatchStyles.
============================================================ */
(function () {
  'use strict';

  if (!window.MCF) return;

  // The terms checklist is mirrored from the server catalogue; the server
  // re-validates, this copy only renders it.
  var TERMS = [
    { id: 'style', label: 'Match style / length agreed' },
    { id: 'limits', label: 'Boundaries and intensity agreed' },
    { id: 'stakes', label: 'Stakes (or "no stakes") agreed' },
    { id: 'finish', label: 'How the match ends agreed' },
    { id: 'safeword', label: 'A stop signal agreed' }
  ];

  function socket() { return window.socket || null; }

  /* ---------- the form ---------- */

  function open(target, prefill) {
    prefill = prefill || {};
    var s = MCF.session();
    if (!s) {
      MCF.toast('Sign in to send a challenge', 'error');
      return;
    }
    if (!target || target === s.username) return;

    var state = {
      styles: (prefill.styles || []).slice(0, 3),
      terms: [],
      bestOf: prefill.bestOf || 1,
      stakes: prefill.stakes || '',
      note: prefill.note || ''
    };

    var box = MCF.popup({ title: 'Challenge ' + (target || ''), label: 'Match challenge form' });

    function render() {
      box.body.innerHTML =
        '<p class="small muted">A challenge names the terms before the first bell — the two minutes the beginner\'s guide calls the most important of the match. Every item below must be agreed with your opponent before the offer can be sent.</p>' +
        '<div class="mcf-field"><label>Opponent</label>' +
          '<input class="mcf-input" type="text" value="' + MCF.escapeHtml(target) + '" readonly>' +
        '</div>' +
        '<div class="mcf-field"><label>Match styles</label>' +
          '<div class="mcf-lfg-styles">' + chips(state.styles) + '</div>' +
        '</div>' +
        '<div class="mcf-field"><label>Series</label>' +
          '<select id="mcfChBestOf" class="mcf-input">' +
            [1, 3, 5].map(function (n) {
              return '<option value="' + n + '"' + (state.bestOf === n ? ' selected' : '') + '>Best of ' + n + '</option>';
            }).join('') +
          '</select>' +
        '</div>' +
        '<div class="mcf-field"><label>Stakes <span class="small muted">(what the winner gets — or "no stakes")</span></label>' +
          '<input id="mcfChStakes" class="mcf-input" type="text" maxlength="200" value="' + MCF.escapeHtml(state.stakes) + '" placeholder="e.g. loser posts a promo admitting defeat">' +
        '</div>' +
        '<div class="mcf-field"><label>Note <span class="small muted">(anything else the two of you agreed)</span></label>' +
          '<input id="mcfChNote" class="mcf-input" type="text" maxlength="300" value="' + MCF.escapeHtml(state.note) + '">' +
        '</div>' +
        '<div class="mcf-field"><label>Pre-match checklist</label>' +
          TERMS.map(function (term) {
            var on = state.terms.indexOf(term.id) !== -1;
            return '<label class="mcf-toggle-row mcf-term-row">' +
              '<input type="checkbox" class="mcf-ch-term" data-term="' + term.id + '"' + (on ? ' checked' : '') + '>' +
              '<span>' + MCF.escapeHtml(term.label) + '</span></label>';
          }).join('') +
        '</div>' +
        '<div class="mcf-row-actions">' +
          '<button type="button" class="small-btn" id="mcfChSend">Send challenge</button>' +
          '<span id="mcfChStatus" class="small muted"></span>' +
        '</div>';

      box.body.querySelectorAll('.mcf-lfg-style').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var id = chip.dataset.style;
          var index = state.styles.indexOf(id);
          if (index === -1) state.styles.push(id);
          else state.styles.splice(index, 1);
          render();
        });
      });
      box.body.querySelectorAll('.mcf-ch-term').forEach(function (check) {
        check.addEventListener('change', function (e) {
          var id = e.target.dataset.term;
          var index = state.terms.indexOf(id);
          if (e.target.checked && index === -1) state.terms.push(id);
          if (!e.target.checked && index !== -1) state.terms.splice(index, 1);
        });
      });
      box.body.querySelector('#mcfChBestOf').addEventListener('change', function (e) {
        state.bestOf = Number(e.target.value) || 1;
      });
      box.body.querySelector('#mcfChStakes').addEventListener('input', function (e) {
        state.stakes = e.target.value;
      });
      box.body.querySelector('#mcfChNote').addEventListener('input', function (e) {
        state.note = e.target.value;
      });
      box.body.querySelector('#mcfChSend').addEventListener('click', send);
    }

    async function send() {
      var status = box.body.querySelector('#mcfChStatus');
      status.textContent = 'Sending…';

      var data = await MCF.postJSON('/api/challenge', {
        to: target,
        styles: state.styles,
        terms: state.terms,
        bestOf: state.bestOf,
        stakes: state.stakes,
        note: state.note
      });

      if (!data || !data.ok) {
        status.textContent = '';
        if (data && data.error === 'terms_not_agreed') {
          MCF.toast('Tick every item on the pre-match checklist first', 'error');
        } else if (data && data.error === 'missing_styles') {
          MCF.toast('Pick at least one match style', 'error');
        } else if (data && data.error === 'blocked') {
          MCF.toast('A challenge is not possible with this member', 'error');
        } else {
          MCF.toast('Could not send the challenge', 'error');
        }
        return;
      }

      MCF.toast('Challenge sent to ' + target);
      box.close();
      list();
    }

    function chips(selected) {
      var catalogue = window.MatchStyles ? window.MatchStyles.catalogue() : [];
      return catalogue.map(function (style) {
        var on = selected.indexOf(style.id) !== -1;
        return '<button type="button" class="mcf-chip' + (on ? ' mcf-chip-on' : '') + ' mcf-lfg-style" data-style="' + style.id + '"' +
          ' title="' + MCF.escapeHtml(style.blurb) + '">' + style.icon + ' ' + MCF.escapeHtml(style.label) + '</button>';
      }).join('');
    }

    render();
  }

  /* ---------- my challenges ---------- */

  function challengeRow(ch, incoming) {
    var row = document.createElement('div');
    row.className = 'mcf-challenge-row';
    var styles = (ch.styles || []).map(function (id) {
      return window.MatchStyles ? window.MatchStyles.icon(id) + ' ' + window.MatchStyles.label(id) : id;
    }).join(', ');

    var actions = '';
    if (ch.status === 'pending') {
      if (incoming) {
        actions =
          '<button type="button" class="small-btn mcf-ch-accept" data-id="' + ch._id + '">Accept</button>' +
          '<button type="button" class="small-btn ghost mcf-ch-decline" data-id="' + ch._id + '">Decline</button>';
      } else {
        actions =
          '<button type="button" class="small-btn ghost mcf-ch-cancel" data-id="' + ch._id + '">Withdraw</button>';
      }
    } else if (ch.status === 'accepted' && ch.room) {
      actions = '<button type="button" class="small-btn mcf-ch-open-room" data-room="' + ch.room + '" data-name="' + MCF.escapeHtml('Match room') + '">Open room</button>';
    }

    row.innerHTML =
      '<div class="mcf-challenge-main">' +
        '<div><b>' + MCF.escapeHtml(incoming ? ch.from : ch.to) + '</b>' +
          ' <span class="small muted">' + (incoming ? 'wants to fight you' : '— your offer') + '</span></div>' +
        '<div class="small muted">' + MCF.escapeHtml(styles) +
          (ch.bestOf > 1 ? ' · best of ' + ch.bestOf : '') +
          (ch.stakes ? ' · stakes: ' + MCF.escapeHtml(ch.stakes) : '') + '</div>' +
        (ch.note ? '<div class="small">' + MCF.escapeHtml(ch.note) + '</div>' : '') +
        '<div class="small muted">' + statusLabel(ch) + '</div>' +
      '</div>' +
      '<div class="mcf-challenge-actions">' + actions + '</div>';

    return row;
  }

  function statusLabel(ch) {
    switch (ch.status) {
      case 'pending': return 'Waiting for ' + (ch.to === currentUsername() ? 'you' : 'them');
      case 'accepted': return 'Accepted ' + (ch.respondedAt ? MCF.agoLabel(ch.respondedAt) : '');
      case 'declined': return 'Declined';
      case 'cancelled': return 'Withdrawn';
      default: return ch.status;
    }
  }

  function currentUsername() {
    var s = MCF.session();
    return s ? s.username : '';
  }

  async function list() {
    var s = MCF.session();
    if (!s) {
      MCF.toast('Sign in to see your challenges', 'error');
      return;
    }

    var box = MCF.popup({ title: 'Challenges', label: 'My match challenges', wide: true });
    box.body.innerHTML = '<p class="small muted">Loading…</p>';

    var data = await MCF.getJSON('/api/challenge/list');
    if (!data || !data.ok) {
      box.body.innerHTML = '<p class="small muted">Could not load challenges.</p>';
      return;
    }

    box.body.innerHTML = '';

    function section(titleText, rows, incoming) {
      var heading = document.createElement('h4');
      heading.className = 'mcf-section-heading';
      heading.textContent = titleText;
      box.body.appendChild(heading);
      if (!rows.length) {
        var empty = document.createElement('p');
        empty.className = 'small muted';
        empty.textContent = 'Nothing here right now.';
        box.body.appendChild(empty);
        return;
      }
      rows.forEach(function (ch) {
        box.body.appendChild(challengeRow(ch, incoming));
      });
    }

    section('Incoming', data.incoming || [], true);
    section('Your offers', data.outgoing || [], false);
    section('Recent', data.recent || [], false);

    box.body.addEventListener('click', async function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var id = btn.dataset.id;

      if (btn.classList.contains('mcf-ch-accept')) {
        btn.disabled = true;
        var accepted = await MCF.postJSON('/api/challenge/' + id + '/respond', { action: 'accept' });
        if (accepted && accepted.ok) {
          MCF.toast('Challenge accepted — the match room is ready');
          if (accepted.roomId && typeof window.openRoomPopup === 'function') {
            box.close();
            window.openRoomPopup(accepted.roomId, accepted.roomName || 'Match room');
            return;
          }
        } else {
          btn.disabled = false;
          MCF.toast('Could not accept the challenge', 'error');
        }
        list();
      } else if (btn.classList.contains('mcf-ch-decline')) {
        btn.disabled = true;
        var declined = await MCF.postJSON('/api/challenge/' + id + '/respond', { action: 'decline' });
        if (!declined || !declined.ok) {
          btn.disabled = false;
          MCF.toast('Could not decline the challenge', 'error');
        }
        list();
      } else if (btn.classList.contains('mcf-ch-cancel')) {
        btn.disabled = true;
        var cancelled = await MCF.postJSON('/api/challenge/' + id + '/respond', { action: 'cancel' });
        if (!cancelled || !cancelled.ok) {
          btn.disabled = false;
          MCF.toast('Could not withdraw the challenge', 'error');
        }
        list();
      } else if (btn.classList.contains('mcf-ch-open-room')) {
        if (typeof window.openRoomPopup === 'function') {
          window.openRoomPopup(btn.dataset.room, btn.dataset.name || 'Match room');
        }
      }
    });
  }

  /* ---------- rematch (from the match record) ---------- */

  async function rematch(matchId) {
    var s = MCF.session();
    if (!s) return;

    // Pull the record to pre-fill the form — the head-to-head view already
    // has it, but fetching here keeps the caller dumb.
    var data = await MCF.getJSON('/api/matches/mine');
    if (data && data.ok) {
      var match = (data.matches || []).find(function (m) { return m._id === String(matchId); });
      if (match) {
        var opponent = match.opponent;
        if (opponent) {
          open(opponent, {
            styles: match.styles || [],
            bestOf: match.bestOf || 1,
            note: 'Rematch.'
          });
          return;
        }
      }
    }
    MCF.toast('Could not start the rematch', 'error');
  }

  /* ---------- live updates ---------- */

  function bind() {
    var btn = document.getElementById('btnChallenges');
    if (btn) btn.addEventListener('click', list);

    var s = socket();
    if (s) {
      s.on('challengeReceived', function (challenge) {
        MCF.toast((challenge.from || 'Someone') + ' sent you a match challenge', 'info');
        ping();
      });
      s.on('challengeStatus', function (challenge) {
        if (challenge.status === 'declined') MCF.toast(challenge.to + ' declined your challenge');
        if (challenge.status === 'cancelled') MCF.toast('Challenge withdrawn');
      });
      s.on('challengeAccepted', function (payload) {
        MCF.toast('Challenge accepted — the match room is ready');
        if (payload && payload.roomId && typeof window.openRoomPopup === 'function') {
          window.openRoomPopup(payload.roomId, payload.roomName || 'Match room');
        }
      });
    }
  }

  /** A small counter ping so the Challenges button shows there is something to see. */
  function ping() {
    var btn = document.getElementById('btnChallenges');
    if (!btn) return;
    var badge = btn.querySelector('.mcf-btn-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'mcf-btn-badge';
      badge.textContent = '•';
      btn.appendChild(badge);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFChallenges = { open: open, list: list, rematch: rematch };
})();
