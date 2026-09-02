/* ============================================================
   SLASH COMMANDS — Hp dice-match endpoints in the chat text bars
   (https://github.com/CyberFights/Hp)

   Adds slash commands to every chat text bar (public arena chat,
   room chat and DMs, on both the desktop and mobile UIs):

     Stateless dice actions (Hp server.js):
       /roll  /submit  /escape  /pin-escape  /tease  /recover

     Match lifecycle (Hp server2.js):
       /create-game  /join-game  /move  /game-state
       /end-game  /end-all-games        + /help

   When the server is configured with HP_API_URL the commands are
   resolved through our /api/hp/* proxy against the real Hp service.
   Otherwise (or if the service is unreachable) an embedded local
   dice engine that mirrors the Hp math keeps every command working.

   Integration points: chat.js / mobile.js call
   window.SlashCommands.tryHandle(text, ctx) from their send paths,
   and any text bar that starts with "/" gets an autocomplete popup.
============================================================ */
(function () {
  'use strict';

  var SESSION_KEY = 'cw_session_v1';
  var GAMES_KEY = 'mcf_hp_games_v1';
  var LAST_GAME_KEY = 'mcf_hp_last_game';

  /* ------------------------------------------------------------
     Tiny helpers
  ------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function currentUser() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      var s = raw ? JSON.parse(raw) : null;
      return s && s.username ? String(s.username) : '';
    } catch (e) { return ''; }
  }

  function currentDisplay() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      var s = raw ? JSON.parse(raw) : null;
      return (s && (s.display || s.username)) || currentUser();
    } catch (e) { return currentUser(); }
  }

  function randInt(n) { return Math.floor(Math.random() * n) + 1; }
  function clampNum(v, min, max) { return Math.min(Math.max(v, min), max); }
  function pct(x) { return Math.round(x * 100) + '%'; }

  /* ------------------------------------------------------------
     Argument parsing
  ------------------------------------------------------------ */
  function usageError(cmd) {
    return new Error('Usage: ' + cmd.usage);
  }

  function parseNumber(cmd, raw, label, opts) {
    opts = opts || {};
    if (raw === undefined || raw === '') {
      if (opts.optional) return undefined;
      throw usageError(cmd);
    }
    var n = Number(raw);
    if (!isFinite(n)) throw new Error('"' + label + '" must be a number. Usage: ' + cmd.usage);
    if (opts.int) n = Math.floor(n);
    return n;
  }

  function parseSides(cmd, raw) {
    if (raw === undefined || raw === '') return undefined;
    var n = Number(raw);
    if (!isFinite(n) || n < 2) throw new Error('sides must be a number ≥ 2. Usage: ' + cmd.usage);
    return Math.floor(n);
  }

  /* ------------------------------------------------------------
     Remote Hp service (through our /api/hp/* proxy)
  ------------------------------------------------------------ */
  var remoteState = null; // null = unknown, true/false afterwards

  function isRemoteConfigured() {
    if (remoteState !== null) return Promise.resolve(remoteState);
    return fetch('/api/hp-config')
      .then(function (res) { return res.ok ? res.json() : { configured: false }; })
      .then(function (data) { remoteState = !!(data && data.configured); return remoteState; })
      .catch(function () { remoteState = false; return false; });
  }

  /**
   * Resolve an Hp action. Tries the real service when configured;
   * falls back to the local engine when the service is not configured
   * or unreachable. Hp-level errors (validation, "not your turn", ...)
   * are surfaced as thrown Errors and never fall back.
   */
  function hpAction(action, body) {
    return isRemoteConfigured().then(function (configured) {
      if (!configured) {
        return { data: localDispatch(action, body), local: true };
      }
      return fetch('/api/hp/' + encodeURIComponent(action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (res) {
        // 502/503 come from our proxy when the Hp server is missing or
        // unreachable — degrade to the local engine in that case.
        if (res.status === 502 || res.status === 503) {
          return { data: localDispatch(action, body), local: true };
        }
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok || !data) {
            // Hp-level error (validation, "not your turn", ...) — surface it,
            // do not silently fall back to the local engine.
            throw hpFail((data && data.error) || ('Hp service error (HTTP ' + res.status + ')'));
          }
          return { data: data, local: false };
        });
      }).catch(function (err) {
        if (err && err._hp) throw err; // surface Hp-level errors as-is
        // Network failure talking to our own proxy — use the local engine.
        return { data: localDispatch(action, body), local: true };
      });
    });
  }

  function hpFail(message) {
    var e = new Error(message);
    e._hp = true;
    return e;
  }

  /* ------------------------------------------------------------
     Local dice engine — faithful mirror of CyberFights/Hp
     (server.js math + server2.js game flow, games kept in
     localStorage so they survive reloads)
  ------------------------------------------------------------ */
  var Local = {
    rollDice: function (sides) { return randInt((sides && sides >= 2) ? Math.floor(sides) : 6); },

    requireNumbers: function (body, keys) {
      keys.forEach(function (k) {
        if (typeof body[k] !== 'number' || !isFinite(body[k])) {
          throw hpFail(keys.join(', ') + ' must be numbers');
        }
      });
    },

    sides: function (body) {
      return (typeof body.sides === 'number' && body.sides >= 2) ? Math.floor(body.sides) : 6;
    },

    // ---- stateless actions (Hp server.js) ----
    roll: function (body) {
      Local.requireNumbers(body, ['atk', 'def', 'health', 'stamina']);
      var sides = Local.sides(body);
      var roll = Local.rollDice(sides);
      var effectiveAttack = Math.max(body.atk - body.def, 0);
      var damage = clampNum(roll * effectiveAttack, 0, 18);
      var staminaLoss = Math.floor(roll - 1);
      return {
        roll: roll, sides: sides, atk: body.atk, def: body.def,
        effectiveAttack: effectiveAttack, damage: damage,
        healthBefore: body.health,
        healthAfter: Math.max(body.health - damage, 0),
        staminaBefore: body.stamina, staminaLoss: staminaLoss,
        staminaAfter: Math.max(body.stamina - staminaLoss)
      };
    },

    submit: function (body) {
      Local.requireNumbers(body, ['atk', 'def', 'health', 'stamina']);
      var sides = Local.sides(body);
      var rollTarget = Local.rollDice(sides);
      var rollSelf = Local.rollDice(sides);
      var effectiveAttack = Math.max(body.atk - body.def, 0);
      var damageToTarget = clampNum(rollTarget * effectiveAttack, 0, 18);
      var damageToSelf = clampNum(rollSelf * effectiveAttack, 0, 18);
      var healthBeforeAttacker = (typeof body.attackerHealth === 'number') ? body.attackerHealth : body.health;
      var staminaLoss = Math.floor(rollTarget - 1);
      return {
        rollTarget: rollTarget, rollSelf: rollSelf, sides: sides,
        atk: body.atk, def: body.def, effectiveAttack: effectiveAttack,
        damageToTarget: damageToTarget,
        healthBeforeTarget: body.health,
        healthAfterTarget: Math.max(body.health - damageToTarget),
        damageToSelf: damageToSelf,
        healthBeforeAttacker: healthBeforeAttacker,
        healthAfterAttacker: Math.max(healthBeforeAttacker - damageToSelf),
        staminaBefore: body.stamina, staminaLoss: staminaLoss,
        staminaAfter: Math.max(body.stamina - staminaLoss)
      };
    },

    escape: function (body) {
      Local.requireNumbers(body, ['atk', 'def', 'health', 'stamina', 'opponentHealth']);
      var sides = Local.sides(body);
      var maxOppHealth = (typeof body.opponentMaxHealth === 'number' && body.opponentMaxHealth > 0) ? body.opponentMaxHealth : 100;
      var baseChance = (typeof body.baseEscapeChance === 'number' && body.baseEscapeChance >= 0 && body.baseEscapeChance <= 1) ? body.baseEscapeChance : 0.8;
      var healthFraction = Math.max(0, Math.min(1, body.health / maxOppHealth));
      var escapeChance = baseChance * healthFraction;
      var escapeRoll = Math.random();
      var escapeSuccess = escapeRoll < escapeChance;
      var effectiveAttack = Math.max(body.atk - body.def, 0);

      var attackRoll = null;
      var damageToOpponent = 0;
      var opponentHealthAfter = body.opponentHealth;
      var staminaLoss = 0;
      var staminaAfter = body.stamina;

      if (escapeSuccess) {
        attackRoll = Local.rollDice(sides);
        damageToOpponent = clampNum(attackRoll * effectiveAttack, 0, 18);
        opponentHealthAfter = Math.max(body.opponentHealth - damageToOpponent);
        staminaLoss = Math.floor(attackRoll - 1);
        staminaAfter = Math.max(body.stamina - staminaLoss);
      }

      return {
        atk: body.atk, def: body.def, effectiveAttack: effectiveAttack,
        health: body.health, opponentMaxHealth: maxOppHealth,
        opponentHealthBefore: body.opponentHealth, opponentHealthAfter: opponentHealthAfter,
        sides: sides, baseEscapeChance: baseChance, healthFraction: healthFraction,
        escapeChance: escapeChance, escapeRoll: escapeRoll, escapeSuccess: escapeSuccess,
        attackRoll: attackRoll, damageToOpponent: damageToOpponent,
        staminaBefore: body.stamina, staminaLoss: staminaLoss, staminaAfter: staminaAfter
      };
    },

    pinEscape: function (body) {
      Local.requireNumbers(body, ['health', 'stamina', 'opponentHealth']);
      var sides = Local.sides(body);
      var maxOppHealth = (typeof body.opponentMaxHealth === 'number' && body.opponentMaxHealth > 0) ? body.opponentMaxHealth : 100;
      var baseChance = (typeof body.baseEscapeChance === 'number' && body.baseEscapeChance >= 0 && body.baseEscapeChance <= 1) ? body.baseEscapeChance : 0.8;
      var healthFraction = Math.max(0, Math.min(1, body.health / maxOppHealth));
      var escapeChancePerRoll = baseChance * healthFraction;
      var rolls = [];
      var anySuccess = false;
      for (var i = 0; i < 3; i++) {
        var rollValue = Math.random();
        var success = rollValue < escapeChancePerRoll;
        rolls.push({ rollValue: rollValue, success: success });
        if (success) anySuccess = true;
      }
      return {
        health: body.health, opponentMaxHealth: maxOppHealth,
        opponentHealthBefore: body.opponentHealth, opponentHealthAfter: body.opponentHealth,
        sides: sides, baseEscapeChance: baseChance, healthFraction: healthFraction,
        escapeChancePerRoll: escapeChancePerRoll, rolls: rolls, escapeSuccess: anySuccess
      };
    },

    tease: function (body) {
      Local.requireNumbers(body, ['atk', 'def', 'stamina', 'opponentAttraction']);
      var sides = Local.sides(body);
      var maxAttraction = (typeof body.opponentMaxAttraction === 'number' && body.opponentMaxAttraction > 0) ? body.opponentMaxAttraction : null;
      var roll = Local.rollDice(sides);
      var effectiveAttack = Math.max(body.atk - body.def, 0);
      var attractionIncrease = clampNum(roll * effectiveAttack, 0, 18);
      var attractionAfter = body.opponentAttraction + attractionIncrease;
      if (maxAttraction !== null) attractionAfter = Math.min(attractionAfter, maxAttraction);
      attractionAfter = Math.max(attractionAfter);
      var staminaLoss = Math.floor(roll - 1);
      return {
        roll: roll, sides: sides, atk: body.atk, def: body.def,
        effectiveAttack: effectiveAttack, attractionIncrease: attractionIncrease,
        attractionBefore: body.opponentAttraction, attractionAfter: attractionAfter,
        opponentMaxAttraction: maxAttraction,
        staminaBefore: body.stamina, staminaLoss: staminaLoss,
        staminaAfter: Math.max(body.stamina - staminaLoss)
      };
    },

    recover: function (body) {
      Local.requireNumbers(body, ['health', 'stamina']);
      var sides = Local.sides(body);
      var rolls = [Local.rollDice(sides), Local.rollDice(sides), Local.rollDice(sides), Local.rollDice(sides)];
      var recoveryTotal = rolls.reduce(function (sum, r) { return sum + r; }, 0);
      var healthCap = (typeof body.maxHealth === 'number' && body.maxHealth > 0) ? body.maxHealth : null;
      var staminaCap = (typeof body.maxStamina === 'number' && body.maxStamina > 0) ? body.maxStamina : null;
      var healthAfterRaw = body.health + recoveryTotal;
      var staminaAfterRaw = body.stamina + recoveryTotal;
      return {
        rolls: rolls, sides: sides, recoveryTotal: recoveryTotal,
        healthBefore: body.health,
        healthAfter: healthCap !== null ? clampNum(healthAfterRaw, 0, healthCap) : Math.max(healthAfterRaw, 0),
        staminaBefore: body.stamina,
        staminaAfter: staminaCap !== null ? clampNum(staminaAfterRaw, 0, staminaCap) : Math.max(staminaAfterRaw, 0),
        maxHealth: healthCap, maxStamina: staminaCap
      };
    },

    // ---- stateful games (Hp server2.js) ----
    loadGames: function () {
      try {
        var raw = localStorage.getItem(GAMES_KEY);
        var games = raw ? JSON.parse(raw) : {};
        return (games && typeof games === 'object') ? games : {};
      } catch (e) { return {}; }
    },

    saveGames: function (games) {
      try { localStorage.setItem(GAMES_KEY, JSON.stringify(games)); } catch (e) { /* ignore */ }
    },

    newPlayerState: function () {
      return { health: 100, stamina: 100, attraction: 0, atkMultiplier: 1, defMultiplier: 1 };
    },

    pinAllowedRolls: function (currentHealth, maxHealth) {
      var hpPct = maxHealth > 0 ? (currentHealth / maxHealth) * 100 : 0;
      if (hpPct > 75) return [1, 2, 3, 4, 5, 6];
      if (hpPct > 50) return [1, 2, 3, 4, 5];
      if (hpPct > 25) return [1, 2, 3, 4];
      return [1, 6];
    },

    createGame: function (body) {
      var roomId = body && body.roomId;
      if (!roomId) throw hpFail('Missing roomId.');
      var games = Local.loadGames();
      var existing = games[roomId];
      // A room with a still-running match cannot start a new one, but once
      // the previous match has ended the room is free to play again.
      if (existing && !(existing.state && existing.state.finished)) {
        throw hpFail('Room already exists.');
      }
      games[roomId] = {
        id: roomId,
        players: [],
        state: {
          turnIndex: 0, finished: false, winner: null, outcome: null,
          p1: Local.newPlayerState(), p2: Local.newPlayerState()
        }
      };
      Local.saveGames(games);
      return { gameId: roomId };
    },

    joinGame: function (body) {
      var games = Local.loadGames();
      var game = games[body && body.roomId];
      if (!game) throw hpFail('Room not found.');
      if (game.players.length >= 2) throw hpFail('Room is full.');
      if (game.players.indexOf(body.playerId) === -1) game.players.push(body.playerId);
      Local.saveGames(games);
      return { success: true, gameId: game.id, players: game.players.slice() };
    },

    gameState: function (body) {
      var games = Local.loadGames();
      var game = games[body && body.roomId];
      if (!game) throw hpFail('Game not found.');
      return {
        id: game.id, players: game.players.slice(),
        state: game.state, outcome: game.state.outcome
      };
    },

    endGame: function (body) {
      var games = Local.loadGames();
      var game = games[body && body.roomId];
      if (!game) throw hpFail('Game not found.');
      if (game.state.finished) throw hpFail('The game is already finished.');
      game.state.finished = true;
      game.state.winner = body.winner || null;
      game.state.outcome = body.outcome || 'manually ended';
      Local.saveGames(games);
      return { success: true, message: 'The game has been manually ended.', state: game.state };
    },

    endAllGames: function (body) {
      var games = Local.loadGames();
      var ended = 0;
      Object.keys(games).forEach(function (id) {
        var game = games[id];
        if (!game.state.finished) {
          game.state.finished = true;
          game.state.winner = null;
          game.state.outcome = (body && body.outcome) || 'manually ended';
          ended++;
        }
      });
      Local.saveGames(games);
      return { success: true, message: 'All active games have been manually ended.', endedGamesCount: ended };
    },

    diceMatch: function (body) {
      var games = Local.loadGames();
      var game = games[body && body.roomId];
      if (!game) throw hpFail('Game not found.');

      var playerId = body.playerId;
      var state = game.state;

      if (state.finished) throw hpFail('Match is already finished.');
      if (game.players.indexOf(playerId) === -1) throw hpFail('Player is not in this game.');
      if (game.players.indexOf(playerId) !== state.turnIndex % game.players.length) {
        throw hpFail('Not your turn.');
      }

      var playerIndex = game.players.indexOf(playerId);
      var selfKey = playerIndex === 0 ? 'p1' : 'p2';
      var oppKey = playerIndex === 0 ? 'p2' : 'p1';
      var self = state[selfKey];
      var opp = state[oppKey];

      var moveType = body.moveType;
      var atkMul = (typeof body.atkMultiplier === 'number') ? body.atkMultiplier : 1;
      var defMul = (typeof body.defMultiplier === 'number') ? body.defMultiplier : 1;

      var result = {
        playerId: playerId, playerIndex: playerIndex, moveType: moveType,
        atkMultiplier: atkMul, defMultiplier: defMul,
        attackRoll: null, submissionRoll: null, selfDamageRoll: null,
        escapeRoll: null, teasingRoll: null, pinRoll: null,
        escaped: false, pinEscaped: false,
        damageDealt: 0, selfDamage: 0, staminaGained: 0,
        updatedHealth: self.health, updatedStamina: self.stamina, updatedAttraction: self.attraction,
        won: false, lost: false, tie: false, ko: false
      };

      if (moveType === 'attack') {
        var roll = Local.rollDice(6);
        result.attackRoll = roll;
        var staminaCost = Math.floor(roll / 2);
        var damage = Math.max(0, Math.floor(roll * (atkMul - defMul)));
        result.damageDealt = damage;
        self.stamina = clampNum(self.stamina - staminaCost, 0, 100);
        opp.health = clampNum(opp.health - damage, 0, 100);
      }

      if (moveType === 'submission') {
        var submissionRoll = Local.rollDice(6);
        var selfDamageRoll = Local.rollDice(6);
        result.submissionRoll = submissionRoll;
        result.selfDamageRoll = selfDamageRoll;
        var subStaminaCost = Math.floor(submissionRoll / 2);
        var subDamage = Math.max(0, Math.floor(submissionRoll * (atkMul - defMul)));
        var recoil = Math.max(0, Math.floor(selfDamageRoll * defMul));
        result.damageDealt = subDamage;
        result.selfDamage = recoil;
        self.stamina = clampNum(self.stamina - subStaminaCost, 0, 100);
        opp.health = clampNum(opp.health - subDamage, 0, 100);
        opp.attraction = clampNum(opp.attraction + subDamage, 0, 100);
        self.health = clampNum(self.health - recoil, 0, 100);
      }

      if (moveType === 'escape') {
        var escapeRoll = Local.rollDice(6);
        result.escapeRoll = escapeRoll;
        result.escaped = escapeRoll % 2 === 0;
        var escStaminaCost = Math.floor(escapeRoll / 2);
        self.stamina = clampNum(self.stamina - escStaminaCost, 0, 100);
        if (result.escaped) {
          var counterRoll = Local.rollDice(6);
          result.attackRoll = counterRoll;
          var counterDamage = Math.max(0, Math.floor(counterRoll * atkMul - defMul));
          result.damageDealt = counterDamage;
          opp.health = clampNum(opp.health - counterDamage, 0, 100);
        }
      }

      if (moveType === 'teasing') {
        var teasingRoll = Local.rollDice(6);
        result.teasingRoll = teasingRoll;
        var teaseStaminaCost = Math.floor(teasingRoll / 2);
        var attractionGain = Math.max(0, Math.floor(teasingRoll * atkMul));
        self.stamina = clampNum(self.stamina - teaseStaminaCost, 0, 100);
        opp.attraction = clampNum(opp.attraction + attractionGain, 0, 100);
      }

      if (moveType === 'pin') {
        var pinRoll = Local.rollDice(6);
        result.pinRoll = pinRoll;
        result.pinEscaped = Local.pinAllowedRolls(self.health, 20).indexOf(pinRoll) !== -1;
      }

      self.health = clampNum(self.health, 0, 100);
      self.stamina = clampNum(self.stamina, 0, 100);
      self.attraction = clampNum(self.attraction, 0, 100);
      opp.health = clampNum(opp.health, 0, 100);
      opp.stamina = clampNum(opp.stamina, 0, 100);
      opp.attraction = clampNum(opp.attraction, 0, 100);

      result.updatedHealth = self.health;
      result.updatedStamina = self.stamina;
      result.updatedAttraction = self.attraction;

      result.won = opp.health <= 0;
      result.lost = self.health <= 0;
      result.tie = self.health <= 0 && opp.health <= 0;
      result.ko = result.tie;

      if (result.tie) {
        state.finished = true; state.outcome = 'tie'; state.winner = null;
      } else if (result.ko) {
        state.finished = true; state.outcome = 'ko'; state.winner = null;
      } else if (result.won) {
        state.finished = true; state.outcome = 'win'; state.winner = playerId;
      } else if (result.lost) {
        state.finished = true; state.outcome = 'loss';
        state.winner = game.players.find(function (id) { return id !== playerId; }) || null;
      }

      state.turnIndex = (state.turnIndex + 1) % game.players.length;
      Local.saveGames(games);

      return {
        result: result,
        game: { id: game.id, players: game.players.slice(), state: state, outcome: state.outcome }
      };
    }
  };

  function localDispatch(action, body) {
    switch (action) {
      case 'roll': return Local.roll(body || {});
      case 'submit': return Local.submit(body || {});
      case 'escape': return Local.escape(body || {});
      case 'pin-escape': return Local.pinEscape(body || {});
      case 'tease': return Local.tease(body || {});
      case 'recover': return Local.recover(body || {});
      case 'create-game': return Local.createGame(body || {});
      case 'join-game': return Local.joinGame(body || {});
      case 'dice-match': return Local.diceMatch(body || {});
      case 'game-state': return Local.gameState(body || {});
      case 'end-game': return Local.endGame(body || {});
      case 'end-all-games': return Local.endAllGames(body || {});
      default: throw hpFail('Unknown Hp action: ' + action);
    }
  }

  /* ------------------------------------------------------------
     Room / player defaults for the match commands
  ------------------------------------------------------------ */
  function defaultRoomId(ctx) {
    if (ctx && ctx.room) return String(ctx.room);
    if (ctx && ctx.kind === 'dm' && ctx.target) {
      var me = (currentUser() || 'me').toLowerCase();
      var other = String(ctx.target).toLowerCase();
      return 'dm-' + [me, other].sort().join('-');
    }
    return null;
  }

  function lastGameRoom() {
    try { return localStorage.getItem(LAST_GAME_KEY) || null; } catch (e) { return null; }
  }

  function rememberGameRoom(roomId) {
    try { if (roomId) localStorage.setItem(LAST_GAME_KEY, String(roomId)); } catch (e) { /* ignore */ }
  }

  function resolveGameRoom(args, ctx, argIndex) {
    var explicit = args[argIndex];
    if (explicit) return String(explicit);
    return lastGameRoom() || defaultRoomId(ctx) || '';
  }

  function requireRoom(roomId, cmd) {
    if (!roomId) throw new Error('No game room given. Usage: ' + cmd.usage);
    return roomId;
  }

  function requireLogin() {
    var me = currentUser();
    if (!me) throw new Error('Log in first to use match commands.');
    return me;
  }

  /* ------------------------------------------------------------
     Result formatters
  ------------------------------------------------------------ */
  function localTag(out) { return out.local ? '  ·  ⚙️ local engine' : ''; }

  var formatters = {
    roll: function (d, out) {
      return '🎲 ' + currentDisplay() + ' attacks! Rolled ' + d.roll + ' on a d' + d.sides +
        ' • ATK ' + d.atk + ' − DEF ' + d.def + ' = ' + d.effectiveAttack +
        ' → ' + d.damage + ' damage' +
        ' • target HP ' + d.healthBefore + '→' + d.healthAfter +
        ' • stamina ' + d.staminaBefore + '→' + d.staminaAfter + localTag(out);
    },
    submit: function (d, out) {
      return '🤼 ' + currentDisplay() + ' locks in a submission hold! Rolls ' +
        d.rollTarget + '/' + d.rollSelf + ' (d' + d.sides + ')' +
        ' → ' + d.damageToTarget + ' dmg to target (' + d.healthBeforeTarget + '→' + d.healthAfterTarget + ' HP)' +
        ', ' + d.damageToSelf + ' recoil (' + d.healthBeforeAttacker + '→' + d.healthAfterAttacker + ' HP)' +
        ' • stamina ' + d.staminaBefore + '→' + d.staminaAfter + localTag(out);
    },
    escape: function (d, out) {
      if (!d.escapeSuccess) {
        return '💨 ' + currentDisplay() + ' tries to escape… and fails! (' +
          pct(d.escapeChance) + ' chance, rolled ' + d.escapeRoll.toFixed(2) + ')' + localTag(out);
      }
      return '💨 ' + currentDisplay() + ' ESCAPES! (' + pct(d.escapeChance) + ' chance, rolled ' +
        d.escapeRoll.toFixed(2) + ') Counter hit for ' + d.damageToOpponent +
        ' — opponent ' + d.opponentHealthBefore + '→' + d.opponentHealthAfter + ' HP' +
        ' • stamina ' + d.staminaBefore + '→' + d.staminaAfter + localTag(out);
    },
    'pin-escape': function (d, out) {
      var marks = d.rolls.map(function (r) { return r.success ? '✅' : '❌'; }).join(' ');
      return '🪤 ' + currentDisplay() + ' fights the pin — 3 shakes: ' + marks +
        ' (' + pct(d.escapeChancePerRoll) + ' each) → ' +
        (d.escapeSuccess ? 'ESCAPED! 🎉' : 'still pinned down…') + localTag(out);
    },
    tease: function (d, out) {
      var cap = d.opponentMaxAttraction != null ? ' (cap ' + d.opponentMaxAttraction + ')' : '';
      return '😏 ' + currentDisplay() + ' teases! Rolled ' + d.roll + ' on a d' + d.sides +
        ' → attraction +' + d.attractionIncrease + ' (' + d.attractionBefore + '→' + d.attractionAfter + ')' + cap +
        ' • stamina ' + d.staminaBefore + '→' + d.staminaAfter + localTag(out);
    },
    recover: function (d, out) {
      return '💖 ' + currentDisplay() + ' recovers! Rolls ' + d.rolls.join(' + ') + ' = ' + d.recoveryTotal +
        ' → HP ' + d.healthBefore + '→' + d.healthAfter +
        ' • stamina ' + d.staminaBefore + '→' + d.staminaAfter + localTag(out);
    },
    'create-game': function (d, out) {
      rememberGameRoom(d.gameId);
      return '🎮 Match "' + d.gameId + '" created! Your opponent can join with /join-game ' +
        d.gameId + ' (or just /join-game in this chat).' + localTag(out);
    },
    'join-game': function (d, out) {
      rememberGameRoom(d.gameId);
      var ready = d.players.length >= 2
        ? ' Both fighters are in — start with /move attack!'
        : ' Waiting for a second fighter…';
      return '🎮 ' + currentDisplay() + ' joined "' + d.gameId + '" (' + d.players.join(' vs ') + ').' + ready + localTag(out);
    },
    'dice-match': function (d, out) {
      var r = d.result;
      var st = d.game.state;
      var line;

      if (r.moveType === 'attack') {
        line = '⚔️ ' + currentDisplay() + ' attacks in "' + d.game.id + '" — rolled ' + r.attackRoll + ' → ' + r.damageDealt + ' damage!';
      } else if (r.moveType === 'submission') {
        line = '🤼 ' + currentDisplay() + ' locks in a submission — roll ' + r.submissionRoll + ' deals ' + r.damageDealt +
          ', recoil roll ' + r.selfDamageRoll + ' costs ' + r.selfDamage + ' HP.';
      } else if (r.moveType === 'escape') {
        line = r.escaped
          ? '💨 ' + currentDisplay() + ' breaks free (roll ' + r.escapeRoll + ') and counters for ' + r.damageDealt + '!'
          : '💨 ' + currentDisplay() + ' tries to escape — roll ' + r.escapeRoll + ', held down!';
      } else if (r.moveType === 'teasing') {
        line = '😏 ' + currentDisplay() + ' teases (roll ' + r.teasingRoll + ') — the opponent is getting flustered…';
      } else if (r.moveType === 'pin') {
        line = '📌 ' + currentDisplay() + ' goes for the pin — roll ' + r.pinRoll + ': ' +
          (r.pinEscaped ? 'kicked out!' : 'held down!');
      } else {
        line = '🎮 ' + currentDisplay() + ' plays "' + r.moveType + '".';
      }

      var p1 = d.game.players[0] || 'P1';
      var p2 = d.game.players[1] || 'P2';
      line += '  ·  🩸 ' + p1 + ': ' + st.p1.health + ' HP / ' + st.p1.stamina + ' ST / ' + st.p1.attraction + '♥  ·  ' +
        p2 + ': ' + st.p2.health + ' HP / ' + st.p2.stamina + ' ST / ' + st.p2.attraction + '♥';

      if (r.won) line += '  ·  🏆 ' + currentDisplay() + ' WINS the match!';
      else if (r.tie) line += '  ·  🤝 Double knock-out — the match is a tie!';
      else if (r.lost) line += '  ·  💀 ' + currentDisplay() + ' is down!';
      else {
        var next = d.game.players[st.turnIndex % d.game.players.length];
        if (next) line += '  ·  ▶️ ' + next + ', your turn — /move attack|submission|escape|teasing|pin';
      }
      return line + localTag(out);
    },
    'game-state': function (d, out) {
      var st = d.state;
      var p1 = d.players[0] || 'P1';
      var p2 = d.players[1] || 'P2';
      var head = st.finished
        ? '📊 Match "' + d.id + '" — FINISHED (' + (st.outcome || 'ended') + ', winner: ' + (st.winner || '—') + ')'
        : '📊 Match "' + d.id + '" — ' + (d.players[st.turnIndex % Math.max(d.players.length, 1)] || 'nobody') + ' to move';
      return head +
        '\n🩸 ' + p1 + ': ' + st.p1.health + ' HP / ' + st.p1.stamina + ' ST / ' + st.p1.attraction + '♥  ·  ' +
        p2 + ': ' + st.p2.health + ' HP / ' + st.p2.stamina + ' ST / ' + st.p2.attraction + '♥' + localTag(out);
    },
    'end-game': function (d, out) {
      return '🏁 Match ended — outcome: ' + (d.state.outcome || 'manually ended') +
        (d.state.winner ? ', winner: ' + d.state.winner : '') + '.' + localTag(out);
    },
    'end-all-games': function (d, out) {
      return '🏁 Ended ' + d.endedGamesCount + ' active match(es).' + localTag(out);
    }
  };

  /* ------------------------------------------------------------
     Room game panels — HP / Stamina / Hormone bars
     While a dice match is running in a room, a scoreboard with two
     fighters' bars is shown at the top of the room chat. New games
     are blocked for that room until the current match has ended.
  ------------------------------------------------------------ */
  var PANEL_REG_KEY = 'mcf_hp_room_games_v1';
  var PANEL_POLL_MS = 8000;
  var PANEL_LINGER_MS = 5000;
  var panelPollTimer = null;
  var panelPollRoom = null;
  var panelFinalizeTimers = {};
  var lastPopupSignature = null;

  function panelDefaultPlayer() {
    return { health: 100, stamina: 100, attraction: 0 };
  }

  function panelDefaultState() {
    return {
      turnIndex: 0, finished: false, winner: null, outcome: null,
      p1: panelDefaultPlayer(), p2: panelDefaultPlayer()
    };
  }

  function panelEl() { return document.getElementById('roomGamePanel'); }

  function currentRoomId() {
    var popup = document.getElementById('roomChatPopup');
    if (!popup) return null;
    var room = popup.getAttribute('data-room');
    return room ? String(room) : null;
  }

  function barHtml(cls, label, value) {
    var v = Math.max(0, Math.min(100, Number(value) || 0));
    return '<div class="roomgame-bar ' + cls + '"><span style="width:' + Math.round(v) +
      '%"></span><em>' + label + ' ' + Math.round(v) + '</em></div>';
  }

  function playerHtml(name, p, isTurn, waiting) {
    var turnCls = isTurn ? ' turn' : '';
    var arrow = isTurn ? '▶ ' : '';
    if (waiting || !p) {
      return '<div class="roomgame-player waiting">' +
        '<div class="roomgame-name">' + escapeHtml(name) + '</div>' +
        barHtml('hp', 'HP', 100) + barHtml('st', 'ST', 100) + barHtml('hm', 'HORMONE', 0) +
        '</div>';
    }
    return '<div class="roomgame-player' + turnCls + '">' +
      '<div class="roomgame-name">' + arrow + escapeHtml(name) + '</div>' +
      barHtml('hp', 'HP', p.health) + barHtml('st', 'ST', p.stamina) + barHtml('hm', 'HORMONE', p.attraction) +
      '</div>';
  }

  function panelActiveHtml(roomId, entry) {
    var st = entry.state;
    var players = entry.players || [];
    var twoPlayers = players.length >= 2;
    var turnOf = twoPlayers && !st.finished ? (st.turnIndex % 2) : -1;

    return '<div class="roomgame-panel">' +
      '<div class="roomgame-head">' +
        '<span class="roomgame-title">🎮 MATCH · ' + escapeHtml(entry.id || roomId) + '</span>' +
        '<button type="button" class="roomgame-end small-btn">End match</button>' +
      '</div>' +
      '<div class="roomgame-players">' +
        playerHtml(players[0] || 'Waiting for fighter 1…', st.p1, turnOf === 0, !players[0]) +
        playerHtml(players[1] || 'Waiting for fighter 2…', st.p2, turnOf === 1, !players[1]) +
      '</div>' +
      '</div>';
  }

  function panelFinishedHtml(entry) {
    var st = entry.state;
    var detail = st.outcome ? escapeHtml(st.outcome) : 'finished';
    if (st.winner) detail += ' · winner: ' + escapeHtml(st.winner);
    return '<div class="roomgame-panel finished">' +
      '<div class="roomgame-head"><span class="roomgame-title">🏁 Match over — ' + detail + '</span></div>' +
      '</div>';
  }

  function deliverRoomMessage(roomId, text) {
    var me = currentUser();
    var sock = window.socket;
    if (!me || !sock || typeof sock.emit !== 'function') return false;
    sock.emit('roomMessage', {
      room: String(roomId),
      from: me,
      display: currentDisplay(),
      text: text,
      time: new Date().toISOString()
    });
    return true;
  }

  function endRoomGame(roomId) {
    var cmd = findCommand('end-game');
    if (!cmd) return;
    var ctx = { kind: 'room', room: roomId };
    Promise.resolve(cmd.run([String(roomId)], ctx)).then(function (out) {
      if (!out || !out.text) return;
      if (!deliverRoomMessage(roomId, out.text)) echoLocal(ctx, out.text);
    }).catch(function (err) {
      echoLocal(ctx, '⚠️ /end-game: ' + (err && err.message ? err.message : 'failed'));
    });
  }

  function bindPanelButtons(el, roomId) {
    var btn = el.querySelector('.roomgame-end');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (!window.confirm('End the match in this room?')) return;
      endRoomGame(roomId);
    });
  }

  var GamePanels = {
    loadReg: function () {
      try {
        var raw = localStorage.getItem(PANEL_REG_KEY);
        var reg = raw ? JSON.parse(raw) : {};
        return (reg && typeof reg === 'object') ? reg : {};
      } catch (e) { return {}; }
    },

    saveReg: function (reg) {
      try { localStorage.setItem(PANEL_REG_KEY, JSON.stringify(reg)); } catch (e) { /* ignore */ }
    },

    get: function (roomId) {
      if (roomId === undefined || roomId === null || roomId === '') return null;
      return GamePanels.loadReg()[String(roomId)] || null;
    },

    hasActive: function (roomId) {
      var entry = GamePanels.get(roomId);
      return !!(entry && entry.state && !entry.state.finished);
    },

    upsert: function (roomId, game) {
      if (roomId === undefined || roomId === null || roomId === '') return;
      roomId = String(roomId);

      var reg = GamePanels.loadReg();
      var prev = reg[roomId];

      reg[roomId] = {
        id: (game && game.id) || roomId,
        players: (game && game.players) ? game.players.slice() : (prev ? prev.players : []),
        state: (game && game.state) ? game.state : (prev ? prev.state : panelDefaultState()),
        updatedAt: Date.now()
      };
      GamePanels.saveReg(reg);

      if (currentRoomId() === roomId) GamePanels.render(roomId);
      if (reg[roomId].state.finished) GamePanels.scheduleFinalize(roomId);
    },

    markFinished: function (roomId) {
      if (roomId === undefined || roomId === null || roomId === '') return;
      roomId = String(roomId);
      var entry = GamePanels.get(roomId);
      if (entry) {
        entry.state.finished = true;
        if (!entry.state.outcome) entry.state.outcome = 'manually ended';
        var reg = GamePanels.loadReg();
        reg[roomId] = entry;
        GamePanels.saveReg(reg);
        if (currentRoomId() === roomId) GamePanels.render(roomId);
      }
      GamePanels.scheduleFinalize(roomId);
    },

    finalizeAll: function () {
      var reg = GamePanels.loadReg();
      Object.keys(reg).forEach(function (id) { GamePanels.markFinished(id); });
    },

    scheduleFinalize: function (roomId) {
      roomId = String(roomId);
      if (panelFinalizeTimers[roomId]) clearTimeout(panelFinalizeTimers[roomId]);
      panelFinalizeTimers[roomId] = setTimeout(function () {
        delete panelFinalizeTimers[roomId];
        GamePanels.remove(roomId);
      }, PANEL_LINGER_MS);
    },

    remove: function (roomId) {
      roomId = String(roomId);
      var reg = GamePanels.loadReg();
      if (!(roomId in reg)) return;
      delete reg[roomId];
      GamePanels.saveReg(reg);
      if (panelPollRoom === roomId) stopPanelPoll();
      if (currentRoomId() === roomId) GamePanels.render(roomId); // hides the panel
    },

    render: function (roomId) {
      var el = panelEl();
      if (!el) return;
      var entry = GamePanels.get(roomId);

      if (!entry) {
        el.hidden = true;
        el.innerHTML = '';
        stopPanelPoll();
        return;
      }

      if (entry.state && entry.state.finished) {
        el.hidden = false;
        el.innerHTML = panelFinishedHtml(entry);
        stopPanelPoll();
        return;
      }

      el.hidden = false;
      el.innerHTML = panelActiveHtml(roomId, entry);
      bindPanelButtons(el, String(roomId));
      startPanelPoll(String(roomId));
    },

    syncToRoom: function () {
      var room = currentRoomId();
      var el = panelEl();
      if (!room) {
        if (el) { el.hidden = true; el.innerHTML = ''; }
        stopPanelPoll();
        return;
      }
      if (!GamePanels.get(room)) {
        if (el) { el.hidden = true; el.innerHTML = ''; }
        stopPanelPoll();
        return;
      }
      GamePanels.render(room);
    }
  };

  function stopPanelPoll() {
    if (panelPollTimer) { clearInterval(panelPollTimer); panelPollTimer = null; }
    panelPollRoom = null;
  }

  function startPanelPoll(roomId) {
    stopPanelPoll();
    panelPollRoom = String(roomId);
    refreshPanelFromRemote(panelPollRoom);
    panelPollTimer = setInterval(function () {
      refreshPanelFromRemote(panelPollRoom);
    }, PANEL_POLL_MS);
  }

  // Authoritative refresh from the Hp server while a panel is visible.
  // (The local engine keeps state in this browser, so nothing to poll.)
  function refreshPanelFromRemote(roomId) {
    if (!roomId) { stopPanelPoll(); return; }
    roomId = String(roomId);
    if (currentRoomId() !== roomId) { stopPanelPoll(); return; }

    isRemoteConfigured().then(function (configured) {
      if (!configured || currentRoomId() !== roomId) return null;
      return fetch('/api/hp/game-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: roomId })
      });
    }).then(function (res) {
      if (!res) return;
      if (res.status === 404) { GamePanels.remove(roomId); return; } // game gone upstream
      if (!res.ok) return;
      return res.json().then(function (data) {
        if (data && data.state) GamePanels.upsert(roomId, data);
      });
    }).catch(function () { /* transient — the next tick retries */ });
  }

  // Watch the room popup: show/hide the panel whenever a room opens or
  // closes (works across the desktop and mobile UIs without hooking
  // their open/close functions).
  function roomPopupSignature() {
    var popup = document.getElementById('roomChatPopup');
    if (!popup) return '';
    var room = popup.getAttribute('data-room') || '';
    var hiddenByStyle = popup.style && popup.style.display === 'none';
    var hiddenByAttr = popup.hidden === true;
    return room + '|' + ((hiddenByStyle || hiddenByAttr) ? '0' : '1');
  }

  function observeRoomPopup() {
    var popup = document.getElementById('roomChatPopup');
    lastPopupSignature = roomPopupSignature();
    GamePanels.syncToRoom();

    if (!popup || typeof MutationObserver === 'undefined') return;
    var observer = new MutationObserver(function () {
      var sig = roomPopupSignature();
      if (sig === lastPopupSignature) return; // e.g. popup being dragged
      lastPopupSignature = sig;
      GamePanels.syncToRoom();
    });
    observer.observe(popup, { attributes: true, attributeFilter: ['data-room', 'style', 'class', 'hidden'] });
  }

  // Another tab changed the panel registry (local-engine games) — refresh.
  window.addEventListener('storage', function (e) {
    if (e && e.key && e.key !== PANEL_REG_KEY) return;
    GamePanels.syncToRoom();
  });

  /* ------------------------------------------------------------
     Command registry
  ------------------------------------------------------------ */
  var COMMANDS = [
    {
      name: 'roll',
      usage: '/roll <atk> <def> <health> <stamina> [sides]',
      desc: 'Attack roll — dice damage from the Hp API',
      run: function (args, ctx) {
        var cmd = this;
        var body = {
          atk: parseNumber(cmd, args[0], 'atk'),
          def: parseNumber(cmd, args[1], 'def'),
          health: parseNumber(cmd, args[2], 'health'),
          stamina: parseNumber(cmd, args[3], 'stamina'),
          sides: parseSides(cmd, args[4])
        };
        return hpAction('roll', body).then(function (out) {
          return { text: formatters.roll(out.data, out), share: true };
        });
      }
    },
    {
      name: 'submit',
      usage: '/submit <atk> <def> <health> <stamina> [attackerHealth] [sides]',
      desc: 'Submission hold — damages target, recoil on you',
      run: function (args, ctx) {
        var cmd = this;
        var body = {
          atk: parseNumber(cmd, args[0], 'atk'),
          def: parseNumber(cmd, args[1], 'def'),
          health: parseNumber(cmd, args[2], 'health'),
          stamina: parseNumber(cmd, args[3], 'stamina'),
          attackerHealth: parseNumber(cmd, args[4], 'attackerHealth', { optional: true }),
          sides: parseSides(cmd, args[5])
        };
        return hpAction('submit', body).then(function (out) {
          return { text: formatters.submit(out.data, out), share: true };
        });
      }
    },
    {
      name: 'escape',
      usage: '/escape <atk> <def> <health> <stamina> <oppHP> [oppMaxHP] [chance] [sides]',
      desc: 'Try to escape — counter-attack on success',
      run: function (args, ctx) {
        var cmd = this;
        var body = {
          atk: parseNumber(cmd, args[0], 'atk'),
          def: parseNumber(cmd, args[1], 'def'),
          health: parseNumber(cmd, args[2], 'health'),
          stamina: parseNumber(cmd, args[3], 'stamina'),
          opponentHealth: parseNumber(cmd, args[4], 'oppHP'),
          opponentMaxHealth: parseNumber(cmd, args[5], 'oppMaxHP', { optional: true }),
          baseEscapeChance: parseNumber(cmd, args[6], 'chance', { optional: true }),
          sides: parseSides(cmd, args[7])
        };
        return hpAction('escape', body).then(function (out) {
          return { text: formatters.escape(out.data, out), share: true };
        });
      }
    },
    {
      name: 'pin-escape',
      usage: '/pin-escape <health> <stamina> <oppHP> [oppMaxHP] [chance] [sides]',
      desc: 'Shake 3 times to kick out of a pin',
      run: function (args, ctx) {
        var cmd = this;
        var body = {
          health: parseNumber(cmd, args[0], 'health'),
          stamina: parseNumber(cmd, args[1], 'stamina'),
          opponentHealth: parseNumber(cmd, args[2], 'oppHP'),
          opponentMaxHealth: parseNumber(cmd, args[3], 'oppMaxHP', { optional: true }),
          baseEscapeChance: parseNumber(cmd, args[4], 'chance', { optional: true }),
          sides: parseSides(cmd, args[5])
        };
        return hpAction('pin-escape', body).then(function (out) {
          return { text: formatters['pin-escape'](out.data, out), share: true };
        });
      }
    },
    {
      name: 'tease',
      usage: '/tease <atk> <def> <stamina> <oppAttraction> [maxAttraction] [sides]',
      desc: 'Raise the opponent\u2019s attraction',
      run: function (args, ctx) {
        var cmd = this;
        var body = {
          atk: parseNumber(cmd, args[0], 'atk'),
          def: parseNumber(cmd, args[1], 'def'),
          stamina: parseNumber(cmd, args[2], 'stamina'),
          opponentAttraction: parseNumber(cmd, args[3], 'oppAttraction'),
          opponentMaxAttraction: parseNumber(cmd, args[4], 'maxAttraction', { optional: true }),
          sides: parseSides(cmd, args[5])
        };
        return hpAction('tease', body).then(function (out) {
          return { text: formatters.tease(out.data, out), share: true };
        });
      }
    },
    {
      name: 'recover',
      usage: '/recover <health> <stamina> [maxHP] [maxStamina] [sides]',
      desc: 'Heal HP & stamina with 4 dice',
      run: function (args, ctx) {
        var cmd = this;
        var body = {
          health: parseNumber(cmd, args[0], 'health'),
          stamina: parseNumber(cmd, args[1], 'stamina'),
          maxHealth: parseNumber(cmd, args[2], 'maxHP', { optional: true }),
          maxStamina: parseNumber(cmd, args[3], 'maxStamina', { optional: true }),
          sides: parseSides(cmd, args[4])
        };
        return hpAction('recover', body).then(function (out) {
          return { text: formatters.recover(out.data, out), share: true };
        });
      }
    },
    {
      name: 'create-game',
      usage: '/create-game [roomId]',
      desc: 'Start a dice match in this chat (default: this room)',
      run: function (args, ctx) {
        var roomId = args[0] || defaultRoomId(ctx) || ('game-' + Math.random().toString(36).slice(2, 7));

        // One active match per room: block new game starts until the
        // current match has ended.
        if (GamePanels.hasActive(roomId)) {
          var entry = GamePanels.get(roomId);
          var who = (entry && entry.players && entry.players.length)
            ? ' (' + entry.players.join(' vs ') + ')'
            : '';
          throw new Error('A match is already underway in "' + roomId + '"' + who +
            '. End it first with /end-game ' + roomId + '.');
        }

        return hpAction('create-game', { roomId: roomId }).then(function (out) {
          GamePanels.upsert(roomId, { id: out.data.gameId, players: [], state: panelDefaultState() });
          return { text: formatters['create-game'](out.data, out), share: true };
        });
      }
    },
    {
      name: 'join-game',
      usage: '/join-game [roomId] [playerId]',
      desc: 'Join the dice match (defaults to this chat, you)',
      run: function (args, ctx) {
        var me = requireLogin();
        var roomId = resolveGameRoom(args, ctx, 0);
        var playerId = args[1] || me;
        return hpAction('join-game', { roomId: requireRoom(roomId, this), playerId: playerId }).then(function (out) {
          if (out.data && out.data.players) {
            GamePanels.upsert(out.data.gameId || roomId, { id: out.data.gameId || roomId, players: out.data.players });
          }
          return { text: formatters['join-game'](out.data, out), share: true };
        });
      }
    },
    {
      name: 'move',
      aliases: ['dice-match', 'attack', 'submission', 'teasing', 'pin'],
      usage: '/move <attack|submission|escape|teasing|pin> [roomId] [atkMul] [defMul]',
      desc: 'Play your turn in the dice match',
      run: function (args, ctx) {
        var me = requireLogin();
        var moveType = String(args[0] || '').toLowerCase();
        var valid = ['attack', 'submission', 'escape', 'teasing', 'pin'];
        if (valid.indexOf(moveType) === -1) throw usageError(this);
        var roomId = resolveGameRoom(args, ctx, 1);
        var body = {
          roomId: requireRoom(roomId, this),
          playerId: me,
          moveType: moveType,
          atkMultiplier: parseNumber(this, args[2], 'atkMul', { optional: true }),
          defMultiplier: parseNumber(this, args[3], 'defMul', { optional: true })
        };
        return hpAction('dice-match', body).then(function (out) {
          if (out.data && out.data.game) GamePanels.upsert(out.data.game.id || body.roomId, out.data.game);
          return { text: formatters['dice-match'](out.data, out), share: true };
        });
      }
    },
    {
      name: 'game-state',
      usage: '/game-state [roomId]',
      desc: 'Show the match scoreboard',
      run: function (args, ctx) {
        var roomId = resolveGameRoom(args, ctx, 0);
        roomId = requireRoom(roomId, this);
        return hpAction('game-state', { roomId: roomId }).then(function (out) {
          if (out.data) GamePanels.upsert(roomId, out.data);
          return { text: formatters['game-state'](out.data, out), share: true };
        });
      }
    },
    {
      name: 'end-game',
      usage: '/end-game [roomId] [outcome]',
      desc: 'Manually end the match',
      run: function (args, ctx) {
        var roomId = resolveGameRoom(args, ctx, 0);
        roomId = requireRoom(roomId, this);
        return hpAction('end-game', { roomId: roomId, outcome: args[1] }).then(function (out) {
          GamePanels.markFinished(roomId);
          return { text: formatters['end-game'](out.data, out), share: true };
        });
      }
    },
    {
      name: 'end-all-games',
      usage: '/end-all-games [outcome]',
      desc: 'End every active match on the Hp server',
      run: function (args) {
        return hpAction('end-all-games', { outcome: args[0] }).then(function (out) {
          GamePanels.finalizeAll();
          return { text: formatters['end-all-games'](out.data, out), share: true };
        });
      }
    },
    {
      name: 'help',
      aliases: ['commands'],
      usage: '/help',
      desc: 'List every slash command',
      run: function () {
        var lines = ['⚔️ SLASH COMMANDS (powered by CyberFights/Hp):', ''];
        COMMANDS.forEach(function (c) {
          lines.push(c.usage + '  —  ' + c.desc);
        });
        lines.push('');
        lines.push('Tip: type "/" in any text bar to autocomplete. Match commands');
        lines.push('default to the room you\u2019re chatting in, so duels live right here.');
        lines.push('While a match runs, the room shows HP / Stamina / Hormone bars up');
        lines.push('top, and new games are blocked until that match ends.');
        return Promise.resolve({ text: lines.join('\n'), share: false });
      }
    }
  ];

  function findCommand(name) {
    name = String(name || '').toLowerCase();
    for (var i = 0; i < COMMANDS.length; i++) {
      var c = COMMANDS[i];
      if (c.name === name) return c;
      if (c.aliases && c.aliases.indexOf(name) !== -1) return c;
    }
    return null;
  }

  /* /attack, /submission, /teasing, /pin and /escape are also accepted as
     bare shortcuts for a match move, e.g. "/attack" == "/move attack".
     (/escape stays the stateless escape command; use /move escape there.) */

  /* ------------------------------------------------------------
     Local (non-shared) output
  ------------------------------------------------------------ */
  function feedFor(ctx) {
    if (!ctx) return null;
    if (ctx.kind === 'public') return $('publicFeed');
    if (ctx.kind === 'room') return $('roomFeed');
    if (ctx.kind === 'dm') {
      if (ctx.target && $('pmBody_' + ctx.target)) return $('pmBody_' + ctx.target);
      return $('dmMessages');
    }
    return null;
  }

  function echoLocal(ctx, text) {
    var feed = feedFor(ctx);
    if (!feed) return;
    var div = document.createElement('div');
    div.className = 'message-row slash-system';
    var box = document.createElement('div');
    box.className = 'slash-local-msg';
    box.textContent = text;
    div.appendChild(box);
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
  }

  /* ------------------------------------------------------------
     Entry point used by the chat send paths
     ctx = { kind: 'public'|'room'|'dm', room?, target?, input?, deliver(text) }
     Returns true when the text was consumed as a slash command.
  ------------------------------------------------------------ */
  function tryHandle(text, ctx) {
    var t = String(text == null ? '' : text).trim();
    if (!t.startsWith('/')) return false;

    hidePopup();

    var parts = t.split(/\s+/);
    var name = parts[0].slice(1).toLowerCase();
    var args = parts.slice(1);

    // Bare move shortcuts: "/attack" etc. become "/move attack".
    var moveShortcuts = ['attack', 'submission', 'teasing', 'pin'];
    if (moveShortcuts.indexOf(name) !== -1) {
      args = [name].concat(args);
      name = 'move';
    }

    var cmd = findCommand(name);
    if (!cmd) {
      echoLocal(ctx, '❓ Unknown command /' + name + '. Type /help for the full list.');
      return true;
    }

    Promise.resolve()
      .then(function () { return cmd.run(args, ctx); })
      .then(function (out) {
        if (!out || !out.text) return;
        if (out.share === false || typeof ctx.deliver !== 'function') {
          echoLocal(ctx, out.text);
        } else {
          ctx.deliver(out.text);
        }
      })
      .catch(function (err) {
        echoLocal(ctx, '⚠️ /' + cmd.name + ': ' + (err && err.message ? err.message : 'command failed'));
      });

    return true;
  }

  /* ------------------------------------------------------------
     Autocomplete popup (event delegation — works for every bar,
     including dynamically created DM inputs)
  ------------------------------------------------------------ */
  var BAR_IDS = { publicMessage: 1, roomMessageInput: 1, dmInput: 1 };

  function isChatBar(el) {
    if (!el || typeof el.id !== 'string') return false;
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    return !!BAR_IDS[el.id] || el.id.indexOf('pmInput_') === 0 || el.getAttribute('data-slash-bar') === '1';
  }

  var popup = null;
  var popupItems = [];
  var popupSel = 0;
  var popupFor = null;

  function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement('div');
    popup.className = 'slash-popup';
    popup.style.display = 'none';
    popup.setAttribute('role', 'listbox');
    document.body.appendChild(popup);

    popup.addEventListener('mousedown', function (e) {
      e.preventDefault(); // keep focus in the text bar
    });
    popup.addEventListener('click', function (e) {
      var item = e.target.closest('.slash-item');
      if (!item) return;
      var idx = Number(item.dataset.index);
      if (popupItems[idx]) completeWith(popupFor, popupItems[idx]);
    });
    return popup;
  }

  function hidePopup() {
    if (popup) popup.style.display = 'none';
    popupItems = [];
    popupSel = 0;
    popupFor = null;
  }

  function renderPopup(input) {
    var box = ensurePopup();

    box.innerHTML = '';
    var header = document.createElement('div');
    header.className = 'slash-header';
    header.textContent = '⚔️ Slash commands — Hp dice match';
    box.appendChild(header);

    popupItems.forEach(function (cmd, i) {
      var item = document.createElement('div');
      item.className = 'slash-item' + (i === popupSel ? ' sel' : '');
      item.dataset.index = String(i);
      item.setAttribute('role', 'option');

      var nameEl = document.createElement('span');
      nameEl.className = 'slash-name';
      nameEl.textContent = '/' + cmd.name;

      var usageEl = document.createElement('span');
      usageEl.className = 'slash-usage';
      usageEl.textContent = cmd.usage.replace(/^\/\S+\s*/, '');

      var descEl = document.createElement('span');
      descEl.className = 'slash-desc';
      descEl.textContent = cmd.desc;

      item.appendChild(nameEl);
      item.appendChild(usageEl);
      item.appendChild(descEl);
      box.appendChild(item);
    });

    // Position above the text bar (below it when there is no room above).
    var rect = input.getBoundingClientRect();
    box.style.display = 'block';
    box.style.visibility = 'hidden';
    var width = Math.max(280, Math.min(440, rect.width || 280));
    box.style.width = width + 'px';
    var height = box.offsetHeight;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    var top = rect.top - height - 6;
    if (top < 8) top = Math.min(rect.bottom + 6, window.innerHeight - height - 8);
    box.style.left = left + 'px';
    box.style.top = Math.max(8, top) + 'px';
    box.style.visibility = '';
    popupFor = input;
  }

  function syncPopup(input) {
    var v = input.value;
    if (!v.startsWith('/')) { hidePopup(); return; }

    var first = v.split(/\s+/)[0].toLowerCase();
    // Once the first token is a full command name, hide the popup so Enter
    // sends/executes the command instead of completing it.
    if (findCommand(first.slice(1))) { hidePopup(); return; }

    var matches = COMMANDS.filter(function (c) {
      return ('/' + c.name).indexOf(first) === 0 ||
        (c.aliases || []).some(function (a) { return ('/' + a).indexOf(first) === 0; });
    });

    if (!matches.length) { hidePopup(); return; }

    popupItems = matches.slice(0, 8);
    popupSel = 0;
    renderPopup(input);
  }

  function completeWith(input, cmd) {
    if (!input || !cmd) return;
    var v = input.value;
    var first = v.split(/\s+/)[0];
    var rest = v.slice(first.length).replace(/^\s+/, '');
    input.value = '/' + cmd.name + (cmd.usage.split(' ').length > 1 ? ' ' : '') + rest;
    hidePopup();
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
    // Let typing indicators / other listeners know the bar changed.
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
  }

  document.addEventListener('input', function (e) {
    if (!isChatBar(e.target)) return;
    syncPopup(e.target);
  }, true);

  document.addEventListener('focusin', function (e) {
    if (isChatBar(e.target)) syncPopup(e.target);
  });

  document.addEventListener('focusout', function (e) {
    if (isChatBar(e.target)) {
      // Delay so a click inside the popup can land first.
      setTimeout(function () {
        if (document.activeElement !== popupFor) hidePopup();
      }, 120);
    }
  });

  document.addEventListener('keydown', function (e) {
    var input = e.target;
    if (!isChatBar(input)) return;
    var open = popup && popup.style.display !== 'none' && popupItems.length > 0;

    if (!open) {
      if (e.key === 'Escape') return;
      return;
    }

    if (e.key === 'ArrowDown') {
      popupSel = (popupSel + 1) % popupItems.length;
      renderPopup(input);
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'ArrowUp') {
      popupSel = (popupSel - 1 + popupItems.length) % popupItems.length;
      renderPopup(input);
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      // While the popup is open the first token is still a partial name,
      // so Enter/Tab complete the command instead of sending it.
      completeWith(input, popupItems[popupSel]);
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Escape') {
      hidePopup();
      e.stopPropagation();
    }
  }, true);

  window.addEventListener('resize', hidePopup);
  window.addEventListener('scroll', hidePopup, true);

  // Show/hide the room scoreboard as rooms open and close.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeRoomPopup);
  } else {
    observeRoomPopup();
  }

  /* ------------------------------------------------------------
     Public API
  ------------------------------------------------------------ */
  window.SlashCommands = {
    tryHandle: tryHandle,
    commands: COMMANDS,
    refreshPopup: syncPopup,
    hidePopup: hidePopup,
    panels: GamePanels,
    endRoomGame: endRoomGame
  };
})();
