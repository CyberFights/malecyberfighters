/* ============================================================
   i18n.js — interface translation + presence labels
   ------------------------------------------------------------
   The site auto-translates *messages* to each member's profile
   language, but the chrome around them (buttons, placeholders)
   was English-only. This module translates the chrome for the
   languages the community actually picks, applied from (in
   order): the member's saved override in Preferences, then the
   profile language, then English.

   Scope is deliberately the fixed chrome — element ids and
   placeholders — because that set is stable and testable. That
   includes the action-button category toggles (navAccount …
   navHelp); their label is the button's first text node, which is
   what setLabel() swaps.
   Member-written content is never touched.

   Also home of the presence label helper ("Online" / "Active 2h
   ago"), which is a localization concern (i18n.agoLabel).
============================================================ */
(function () {
  'use strict';

  var LANG_KEY = 'mcf_lang';

  /** The languages this module carries a dictionary for. */
  var LANGUAGES = {
    en: 'English',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    pt: 'Português',
    it: 'Italiano'
  };

  /* id → text. `ph:` entries set the placeholder of that input. */
  var STRINGS = {
    en: {
      btnLogin: 'Login', btnRegister: 'Register',
      btnOpenChat: 'Open Arena', btnRoster: 'User Roster',
      btnArchives: 'Archives', btnDMs: 'DMs', btnRooms: 'Rooms',
      btnForums: 'Forums', openSupport: 'Support',
      btnAssistance: 'Assistance', btnGuide: "Beginner's Guide",
      btnMyProfile: 'Profile', btnEditProfile: 'Edit',
      btnLogout: 'Log out', btnTOS: 'Terms of Service',
      btnPrivacy: 'Privacy Policy', btnRules: 'Server Rules',
      btnLfg: 'Find a Match', btnChallenges: 'Challenges',
      btnRecord: 'Record', btnAchievements: 'Achievements',
      btnPreferences: 'Preferences', btnBookmarks: 'Bookmarks',
      navAccount: 'Account', navChatrooms: 'Chatrooms', navCommunity: 'Community',
      navMatches: 'Matches', navHelp: 'Help',
      sendPublic: 'Send', dmSend: 'Send', roomSendBtn: 'Send',
      'ph:publicMessage': 'Say something to the arena',
      'ph:roomMessageInput': 'Message room',
      'ph:dmInput': 'Write a message',
      online: 'Online',
      activeAgo: 'Active {ago}',
      lastSeenNever: 'Away'
    },
    es: {
      btnLogin: 'Entrar', btnRegister: 'Registro',
      btnOpenChat: 'Abrir arena', btnRoster: 'Lista de luchadores',
      btnArchives: 'Archivos', btnDMs: 'MD', btnRooms: 'Salas',
      btnForums: 'Foros', openSupport: 'Soporte',
      btnAssistance: 'Ayuda', btnGuide: 'Guía para principiantes',
      btnMyProfile: 'Perfil', btnEditProfile: 'Editar',
      btnLogout: 'Cerrar sesión', btnTOS: 'Términos del servicio',
      btnPrivacy: 'Política de privacidad', btnRules: 'Reglas del servidor',
      btnLfg: 'Buscar combate', btnChallenges: 'Desafíos',
      btnRecord: 'Historial', btnAchievements: 'Logros',
      btnPreferences: 'Preferencias', btnBookmarks: 'Guardados',
      navAccount: 'Cuenta', navChatrooms: 'Salas de chat', navCommunity: 'Comunidad',
      navMatches: 'Combates', navHelp: 'Ayuda',
      sendPublic: 'Enviar', dmSend: 'Enviar', roomSendBtn: 'Enviar',
      'ph:publicMessage': 'Escribe algo en la arena',
      'ph:roomMessageInput': 'Mensaje de la sala',
      'ph:dmInput': 'Escribe un mensaje',
      online: 'En línea',
      activeAgo: 'Activo {ago}',
      lastSeenNever: 'Ausente'
    },
    fr: {
      btnLogin: 'Connexion', btnRegister: 'Inscription',
      btnOpenChat: 'Ouvrir l\'arène', btnRoster: 'Liste des lutteurs',
      btnArchives: 'Archives', btnDMs: 'MP', btnRooms: 'Salons',
      btnForums: 'Forums', openSupport: 'Assistance',
      btnAssistance: 'Aide', btnGuide: 'Guide du débutant',
      btnMyProfile: 'Profil', btnEditProfile: 'Modifier',
      btnLogout: 'Déconnexion', btnTOS: 'Conditions d\'utilisation',
      btnPrivacy: 'Confidentialité', btnRules: 'Règles du serveur',
      btnLfg: 'Trouver un match', btnChallenges: 'Défis',
      btnRecord: 'Palmarès', btnAchievements: 'Succès',
      btnPreferences: 'Préférences', btnBookmarks: 'Favoris',
      navAccount: 'Compte', navChatrooms: 'Salons de chat', navCommunity: 'Communauté',
      navMatches: 'Combats', navHelp: 'Aide',
      sendPublic: 'Envoyer', dmSend: 'Envoyer', roomSendBtn: 'Envoyer',
      'ph:publicMessage': 'Dis quelque chose à l\'arène',
      'ph:roomMessageInput': 'Message du salon',
      'ph:dmInput': 'Écrire un message',
      online: 'En ligne',
      activeAgo: 'Actif {ago}',
      lastSeenNever: 'Absent'
    },
    de: {
      btnLogin: 'Anmelden', btnRegister: 'Registrieren',
      btnOpenChat: 'Arena öffnen', btnRoster: 'Kämpferliste',
      btnArchives: 'Archiv', btnDMs: 'DMs', btnRooms: 'Räume',
      btnForums: 'Foren', openSupport: 'Hilfe',
      btnAssistance: 'Assistent', btnGuide: 'Anfängerleitfaden',
      btnMyProfile: 'Profil', btnEditProfile: 'Bearbeiten',
      btnLogout: 'Abmelden', btnTOS: 'Nutzungsbedingungen',
      btnPrivacy: 'Datenschutz', btnRules: 'Serverregeln',
      btnLfg: 'Match finden', btnChallenges: 'Herausforderungen',
      btnRecord: 'Kampfbilanz', btnAchievements: 'Erfolge',
      btnPreferences: 'Einstellungen', btnBookmarks: 'Lesezeichen',
      navAccount: 'Konto', navChatrooms: 'Chaträume', navCommunity: 'Community',
      navMatches: 'Kämpfe', navHelp: 'Hilfe',
      sendPublic: 'Senden', dmSend: 'Senden', roomSendBtn: 'Senden',
      'ph:publicMessage': 'Sag der Arena etwas',
      'ph:roomMessageInput': 'Raumnachricht',
      'ph:dmInput': 'Nachricht schreiben',
      online: 'Online',
      activeAgo: 'Aktiv {ago}',
      lastSeenNever: 'Abwesend'
    },
    pt: {
      btnLogin: 'Entrar', btnRegister: 'Registrar',
      btnOpenChat: 'Abrir arena', btnRoster: 'Lutadores',
      btnArchives: 'Arquivos', btnDMs: 'MDs', btnRooms: 'Salas',
      btnForums: 'Fóruns', openSupport: 'Suporte',
      btnAssistance: 'Ajuda', btnGuide: 'Guia para iniciantes',
      btnMyProfile: 'Perfil', btnEditProfile: 'Editar',
      btnLogout: 'Sair', btnTOS: 'Termos de serviço',
      btnPrivacy: 'Privacidade', btnRules: 'Regras do servidor',
      btnLfg: 'Achar luta', btnChallenges: 'Desafios',
      btnRecord: 'Histórico', btnAchievements: 'Conquistas',
      btnPreferences: 'Preferências', btnBookmarks: 'Salvos',
      navAccount: 'Conta', navChatrooms: 'Salas de chat', navCommunity: 'Comunidade',
      navMatches: 'Combates', navHelp: 'Ajuda',
      sendPublic: 'Enviar', dmSend: 'Enviar', roomSendBtn: 'Enviar',
      'ph:publicMessage': 'Diga algo na arena',
      'ph:roomMessageInput': 'Mensagem da sala',
      'ph:dmInput': 'Escreva uma mensagem',
      online: 'Online',
      activeAgo: 'Ativo {ago}',
      lastSeenNever: 'Ausente'
    },
    it: {
      btnLogin: 'Accedi', btnRegister: 'Registrati',
      btnOpenChat: 'Apri arena', btnRoster: 'Lottatori',
      btnArchives: 'Archivi', btnDMs: 'MD', btnRooms: 'Stanze',
      btnForums: 'Forum', openSupport: 'Assistenza',
      btnAssistance: 'Aiuto', btnGuide: 'Guida per principianti',
      btnMyProfile: 'Profilo', btnEditProfile: 'Modifica',
      btnLogout: 'Esci', btnTOS: 'Termini di servizio',
      btnPrivacy: 'Privacy', btnRules: 'Regole del server',
      btnLfg: 'Trova match', btnChallenges: 'Sfide',
      btnRecord: 'Storico', btnAchievements: 'Obiettivi',
      btnPreferences: 'Preferenze', btnBookmarks: 'Salvati',
      navAccount: 'Account', navChatrooms: 'Chat', navCommunity: 'Comunità',
      navMatches: 'Incontri', navHelp: 'Aiuto',
      sendPublic: 'Invia', dmSend: 'Invia', roomSendBtn: 'Invia',
      'ph:publicMessage': 'Dì qualcosa all\'arena',
      'ph:roomMessageInput': 'Messaggio della stanza',
      'ph:dmInput': 'Scrivi un messaggio',
      online: 'Online',
      activeAgo: 'Attivo {ago}',
      lastSeenNever: 'Assente'
    }
  };

  function readOverride() {
    try { return localStorage.getItem(LANG_KEY) || ''; } catch (e) { return ''; }
  }

  /** The language to render in right now: override → profile → English. */
  function currentLanguage() {
    var override = readOverride();
    if (override && STRINGS[override]) return override;
    try {
      var session = JSON.parse(localStorage.getItem('cw_session_v1') || 'null');
      if (session && session.language && STRINGS[session.language]) return session.language;
    } catch (e) { /* fall through */ }
    return 'en';
  }

  /**
   * Replace an element's label without touching its children (a button like
   * "DMs <span class=badge>" must keep its badge).
   */
  function setLabel(el, text) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var node = walker.nextNode();
    if (node) {
      node.nodeValue = text;
      return;
    }
    el.insertBefore(document.createTextNode(text), el.firstChild);
  }

  function apply() {
    var lang = currentLanguage();
    var strings = STRINGS[lang] || STRINGS.en;
    if (lang === 'en') strings = STRINGS.en;

    Object.keys(strings).forEach(function (key) {
      var value = strings[key];
      if (key.indexOf('ph:') === 0) {
        var input = document.getElementById(key.slice(3));
        if (input) input.placeholder = value;
        return;
      }
      // Both layouts of the desktop page carry the same ids; querySelectorAll
      // covers every copy (the getElementById proxy in utils.js returns one).
      document.querySelectorAll('#' + key).forEach(function (el) {
        setLabel(el, value);
      });
    });

    document.documentElement.dataset.mcfLang = lang;
    // Re-render the presence labels with the new language.
    refreshPresenceLabels();
  }

  /* ---------- presence labels ---------- */

  /** "Active 2h ago" (translated) for a member's lastSeenAt. */
  function agoLabel(date) {
    var label = window.MCF ? MCF.agoLabel(date) : '';
    if (!label) return '';
    var lang = currentLanguage();
    var template = (STRINGS[lang] || STRINGS.en).activeAgo;
    return template.replace('{ago}', label);
  }

  function presenceLabel(user) {
    if (!user) return '';
    if (user.online) return (STRINGS[currentLanguage()] || STRINGS.en).online;
    var ago = user.lastSeenAt ? agoLabel(user.lastSeenAt) : '';
    return ago || (STRINGS[currentLanguage()] || STRINGS.en).lastSeenNever;
  }

  /** Update every element marked as a presence slot (profile cards, boards). */
  function refreshPresenceLabels() {
    document.querySelectorAll('[data-mcf-presence]').forEach(function (el) {
      var raw = el.dataset.mcfPresence;
      var user = null;
      try { user = JSON.parse(raw); } catch (e) { return; }
      var label = presenceLabel(user);
      if (label) el.textContent = label;
    });
  }

  function boot() {
    apply();
    // Presence arrives after this script runs; refresh labels when it does.
    var s = window.socket || null;
    if (s) {
      s.on('presence', function () {
        // The page's own presence handler renders first (it is bound earlier),
        // so refresh one frame later rather than racing it.
        setTimeout(refreshPresenceLabels, 0);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.MCFI18N = {
    apply: apply,
    languages: function () { return Object.keys(LANGUAGES); },
    languageName: function (code) { return LANGUAGES[code] || code; },
    currentLanguage: currentLanguage,
    presenceLabel: presenceLabel,
    agoLabel: agoLabel,
    refreshPresenceLabels: refreshPresenceLabels
  };
})();
