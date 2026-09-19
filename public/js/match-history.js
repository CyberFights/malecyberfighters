/* ============================================================
   match-history.js — the win/loss record (client)
   ------------------------------------------------------------
   Every confirmed match as a row: who, when, what style, how it
   ended — plus head-to-head records, the rivalry list, a
   "log a match" form for matches played outside the engine, and
   the rematch button that pre-fills a challenge.

   Depends on features-core.js and MatchStyles.
============================================================ */
(function () {
  'use strict';

  if (!window.MCF) return;

  function socket() { return window.socket || null; }

  function styleText(styles) {
    return (styles || []).map(function (id) {
      return window.MatchStyles ? window.MatchStyles.icon(id) + ' ' + window.MatchStyles.label(id) : id;
    }).join(', ');
  }

  function outcomeLabel(outcome) {
    if (outcome === 'win') return '<span class="mcf-outcome mcf-outcome-win">W</span>';
    if (outcome === 'loss') return '<span class="mcf-outcome mcf-outcome-loss">L</span>';
    return '<span class="mcf-outcome mcf-outcome-draw">D</span>';
  }

  function currentUsername() {
    var s = MCF.session();
    return s ? s.username : '';
  }

  function matchRow(match) {
    var row = document.createElement('div');
    row.className = 'mcf-match-row';
    var opponent = match.opponent || (match.winner && match.loser
      ? (match.winner === currentUsername() ? match.loser : match.winner)
      : '—');

    var status = match.status !== 'confirmed'
      ? ' <span class="small muted">(' + (match.status === 'pending' ? 'waiting for ' + (match.reporter === currentUsername() ? 'their' : 'your') + ' confirmation' : 'declined') + ')</span>'
      : '';

    row.innerHTML =
      '<div class="mcf-match-main">' +
        outcomeLabel(match.outcome) +
        '<div>' +
          '<div><b>' + MCF.escapeHtml(opponent) + '</b>' + status + '</div>' +
          '<div class="small muted">' + MCF.escapeHtml(styleText(match.styles)) +
            (match.bestOf > 1 ? ' · best of ' + match.bestOf : '') +
            ' · ' + (match.source === 'engine' ? 'dice match' : 'logged') +
            ' · ' + MCF.dateLabel(match.createdAt) + '</div>' +
          (match.notes ? '<div class="small">' + MCF.escapeHtml(match.notes) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="mcf-match-actions">' +
        (match.status === 'confirmed' && match.opponent
          ? '<button type="button" class="small-btn ghost mcf-match-rematch" data-id="' + match._id + '">Rematch</button>' +
            '<button type="button" class="small-btn ghost mcf-match-h2h" data-user="' + MCF.escapeHtml(match.opponent) + '">Head to head</button>'
          : '') +
      '</div>';

    return row;
  }

  function summaryBar(summary) {
    return '<div class="mcf-record-bar">' +
      '<span class="mcf-record-stat"><b>' + (summary.wins || 0) + '</b> wins</span>' +
      '<span class="mcf-record-stat"><b>' + (summary.losses || 0) + '</b> losses</span>' +
      '<span class="mcf-record-stat"><b>' + (summary.draws || 0) + '</b> draws</span>' +
      '<span class="mcf-record-stat"><b>' + (summary.matches || 0) + '</b> matches</span>' +
    '</div>';
  }

  /* ---------- the record window ---------- */

  async function open(username) {
    username = username || currentUsername();
    if (!username) {
      MCF.toast('Sign in to see your record', 'error');
      return;
    }

    var box = MCF.popup({ title: username === currentUsername() ? 'My match record' : username + "'s record", label: 'Match record', wide: true });
    box.body.innerHTML = '<p class="small muted">Loading…</p>';

    var url = username === currentUsername() ? '/api/matches/mine' : '/api/matches/user/' + encodeURIComponent(username);
    var data = await MCF.getJSON(url);
    if (!data || !data.ok) {
      box.body.innerHTML = '<p class="small muted">Could not load the record.</p>';
      return;
    }

    box.body.innerHTML = '';
    var head = document.createElement('div');
    head.innerHTML = summaryBar(data.summary || {});
    box.body.appendChild(head);

    var actions = document.createElement('div');
    actions.className = 'mcf-row-actions';
    actions.innerHTML =
      '<button type="button" class="small-btn" id="mcfLogMatch">Log a match</button>' +
      (username === currentUsername() ? '' : '<button type="button" class="small-btn ghost" id="mcfMyRecord">My record</button>');
    box.body.appendChild(actions);

    actions.querySelector('#mcfLogMatch').addEventListener('click', function () { logForm(box); });
    var myBtn = actions.querySelector('#mcfMyRecord');
    if (myBtn) myBtn.addEventListener('click', function () { box.close(); open(); });

    // Rivalries — the opponents this member has met three times or more.
    var rivals = (data.summary && data.summary.rivals) || [];
    if (rivals.length) {
      var rivalHeading = document.createElement('h4');
      rivalHeading.className = 'mcf-section-heading';
      rivalHeading.textContent = 'Rivalries';
      box.body.appendChild(rivalHeading);
      rivals.forEach(function (rival) {
        var el = document.createElement('div');
        el.className = 'mcf-rival-row';
        el.innerHTML =
          '<span>⚔️ <b>' + MCF.escapeHtml(rival.opponent) + '</b> ' +
          '<span class="small muted">' + rival.matches + ' matches · ' + rival.wins + '–' + rival.losses + '</span></span>' +
          '<button type="button" class="small-btn ghost mcf-match-h2h" data-user="' + MCF.escapeHtml(rival.opponent) + '">Head to head</button>';
        box.body.appendChild(el);
      });
    }

    var heading = document.createElement('h4');
    heading.className = 'mcf-section-heading';
    heading.textContent = 'Matches';
    box.body.appendChild(heading);

    if (!(data.matches || []).length) {
      var empty = document.createElement('p');
      empty.className = 'small muted';
      empty.textContent = 'No matches recorded yet. Finish a dice match, or log one below.';
      box.body.appendChild(empty);
    } else {
      data.matches.forEach(function (match) {
        box.body.appendChild(matchRow(match));
      });
    }

    box.body.addEventListener('click', function (e) {
      var rematchBtn = e.target.closest('.mcf-match-rematch');
      if (rematchBtn) {
        if (window.MCFChallenges && window.MCFChallenges.rematch) {
          window.MCFChallenges.rematch(rematchBtn.dataset.id);
        }
        return;
      }
      var h2hBtn = e.target.closest('.mcf-match-h2h');
      if (h2hBtn) {
        headToHead(h2hBtn.dataset.user);
      }
    });
  }

  /* ---------- head to head ---------- */

  async function headToHead(other) {
    if (!other || !currentUsername()) return;

    var box = MCF.popup({ title: 'You vs ' + other, label: 'Head to head record', wide: true });
    box.body.innerHTML = '<p class="small muted">Loading…</p>';

    var data = await MCF.getJSON('/api/matches/head-to-head?with=' + encodeURIComponent(other));
    if (!data || !data.ok) {
      box.body.innerHTML = '<p class="small muted">Could not load the head-to-head.</p>';
      return;
    }

    box.body.innerHTML = '';
    var head = document.createElement('div');
    head.innerHTML = summaryBar(data.summary || {});
    box.body.appendChild(head);

    var actions = document.createElement('div');
    actions.className = 'mcf-row-actions';
    actions.innerHTML = '<button type="button" class="small-btn" id="mcfH2hRematch">Rematch ' + MCF.escapeHtml(other) + '</button>';
    box.body.appendChild(actions);
    actions.querySelector('#mcfH2hRematch').addEventListener('click', function () {
      if (window.MCFChallenges) window.MCFChallenges.open(other, { note: 'Rematch.' });
    });

    if (!(data.matches || []).length) {
      box.body.appendChild(Object.assign(document.createElement('p'), {
        className: 'small muted',
        textContent: 'You two have not met in a recorded match yet.'
      }));
      return;
    }
    data.matches.forEach(function (match) {
      box.body.appendChild(matchRow(match));
    });
  }

  /* ---------- log a match ---------- */

  function logForm(parentBox) {
    var box = MCF.popup({ title: 'Log a match', label: 'Log a match for confirmation' });
    var styles = [];

    function render() {
      box.body.innerHTML =
        '<p class="small muted">For matches played outside the dice engine (freeform, Discord, anywhere). Your opponent is asked to confirm it from their DMs — a record only counts once they do.</p>' +
        '<div class="mcf-field"><label>Opponent</label>' +
          '<input id="mcfLmOpponent" class="mcf-input" type="text" placeholder="username">' +
        '</div>' +
        '<div class="mcf-field"><label>Styles</label><div class="mcf-lfg-styles">' + chips(styles) + '</div></div>' +
        '<div class="mcf-field"><label>Who won?</label>' +
          '<select id="mcfLmWon" class="mcf-input"><option value="true">I won</option><option value="false">I lost</option></select>' +
        '</div>' +
        '<div class="mcf-field"><label>Notes <span class="small muted">(optional)</span></label>' +
          '<input id="mcfLmNotes" class="mcf-input" type="text" maxlength="500">' +
        '</div>' +
        '<div class="mcf-row-actions"><button type="button" class="small-btn" id="mcfLmSend">Send for confirmation</button>' +
        '<span id="mcfLmStatus" class="small muted"></span></div>';

      box.body.querySelectorAll('.mcf-lfg-style').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var id = chip.dataset.style;
          var index = styles.indexOf(id);
          if (index === -1) styles.push(id);
          else styles.splice(index, 1);
          render();
        });
      });

      box.body.querySelector('#mcfLmSend').addEventListener('click', send);
    }

    async function send() {
      var opponent = box.body.querySelector('#mcfLmOpponent').value.trim();
      var status = box.body.querySelector('#mcfLmStatus');
      if (!opponent) {
        MCF.toast('Name your opponent', 'error');
        return;
      }
      if (!styles.length) {
        MCF.toast('Pick at least one style', 'error');
        return;
      }

      status.textContent = 'Sending…';
      var data = await MCF.postJSON('/api/matches/log', {
        opponent: opponent,
        styles: styles,
        won: box.body.querySelector('#mcfLmWon').value === 'true',
        notes: box.body.querySelector('#mcfLmNotes').value
      });

      if (!data || !data.ok) {
        status.textContent = '';
        MCF.toast(data && data.error === 'blocked'
          ? 'A record is not possible with this member'
          : 'Could not log the match', 'error');
        return;
      }

      MCF.toast('Match sent to ' + opponent + ' for confirmation');
      box.close();
      parentBox.close();
      open();
    }

    function chips(selected) {
      var catalogue = window.MatchStyles ? window.MatchStyles.catalogue() : [];
      return catalogue.map(function (style) {
        var on = selected.indexOf(style.id) !== -1;
        return '<button type="button" class="mcf-chip' + (on ? ' mcf-chip-on' : '') + ' mcf-lfg-style" data-style="' + style.id + '">' +
          style.icon + ' ' + MCF.escapeHtml(style.label) + '</button>';
      }).join('');
    }

    render();
  }

  /* ---------- live updates ---------- */

  function bind() {
    var btn = document.getElementById('btnRecord');
    if (btn) btn.addEventListener('click', function () { open(); });

    var s = socket();
    if (s) {
      s.on('matchRecorded', function () {
        MCF.toast('Match recorded');
      });
      s.on('matchLogged', function (match) {
        MCF.toast((match && match.reporter ? match.reporter : 'Someone') + ' logged a match with you — confirm it in your DMs', 'info');
      });
      s.on('matchStatus', function (match) {
        if (match && match.status === 'confirmed') MCF.toast('A match record was confirmed');
        if (match && match.status === 'declined') MCF.toast('A match record was declined');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.MCFMatchHistory = { open: open, headToHead: headToHead };
})();
