/*
 * Male Cyber Fighters — emoji picker for chat text bars.
 *
 * A tiny, dependency-free emoji popover shared by every chat composer:
 * the arena chat bar, room bars, DM popups and per-user PM windows
 * (desktop and mobile). It works purely through event delegation, so
 * bars that are created later at runtime (PM windows in pm.js) pick it
 * up automatically as long as their emoji button carries the
 * `data-emoji-btn` attribute.
 *
 * - The picker targets the text input next to the button (or the element
 *   matched by an optional `data-emoji-input` CSS selector).
 * - Picked emojis are inserted at the caret and dispatch a bubbling
 *   `input` event, so typing indicators and other listeners stay in sync.
 * - Styles are injected once at runtime, which keeps the widget identical
 *   across desktop.css, mobile.css and the mobile2 inline stylesheet.
 */

(function () {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* Emoji set                                                         */
  /* ---------------------------------------------------------------- */

  var CATEGORIES = [
    {
      label: 'Smileys & emotions',
      emojis: '😀 😁 😂 🤣 😃 😄 😅 😆 😉 😊 😋 😎 😍 😘 🥰 😗 😙 😚 🙂 🤗 🤩 🤔 😐 😑 😏 😒 🙄 😴 😪 😬 🤤 😮 😲 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 😖 😣 😞 😔 😟 🙁 😕 😫 😩 🥱 🤐 😶'.split(' '),
    },
    {
      label: 'Gestures & people',
      emojis: '👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖖 👋 🤝 💪 🫶 🙏 ✍️ 💅 🤳 💃 🕺 🤠 🥷 🧑‍💻 👑 🧢 🎓 👀 🗣️ 🧠'.split(' '),
    },
    {
      label: 'Hearts & love',
      emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💌 💋 💯 🔥 💫 ⭐ 🌟 ✨ 💥 💢'.split(' '),
    },
    {
      label: 'Animals & nature',
      emojis: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦄 🐝 🦋 🐢 🐙 🦈 🐬 🐳 🌈 ☀️ 🌙 ⚡ 🌊 🍀 🌸 🌹 🌻 🌵'.split(' '),
    },
    {
      label: 'Food & drink',
      emojis: '🍏 🍎 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍔 🍟 🍕 🌭 🌮 🌯 🍿 🧀 🍗 🍦 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 ☕ 🍵 🥤 🍺 🍷'.split(' '),
    },
    {
      label: 'Activities & symbols',
      emojis: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🏓 🏸 🥊 🎮 🎲 🎯 🎸 🎹 🎬 🎤 🎧 🏆 🥇 🚗 ✈️ 🚀 🛸 ⏰ ⚠️ ✅ ❌ ➕ ➖ ➗ 💰 💎 🎁 🎉 🎊 🔔 🔒 🔓 📌 📎'.split(' '),
    },
  ];

  /* ---------------------------------------------------------------- */
  /* Injected styles (shared across all three frontends)               */
  /* ---------------------------------------------------------------- */

  var STYLE_ID = 'emoji-picker-style';

  var PICKER_CSS = [
    'button.emoji-btn{',
    '  width:auto;margin-top:0;flex:0 0 auto;',
    '  background:transparent;',
    '  border:1px solid rgba(160,200,255,0.25);',
    '  border-radius:8px;',
    '  box-shadow:none;',
    '  color:#8fb4d4;font-weight:400;',
    '  font-size:18px;line-height:1;',
    '  padding:8px 10px;cursor:pointer;',
    '  touch-action:manipulation;',
    '  transition:color 0.15s ease,border-color 0.15s ease,transform 0.12s ease;',
    '}',
    'button.emoji-btn:hover{color:#ffd166;border-color:rgba(255,209,102,0.55);}',
    'button.emoji-btn:active{transform:scale(0.92);}',
    '@media (max-width:768px){',
    '  .pm-window .pm-input button.emoji-btn{min-width:42px;min-height:42px;padding:9px 10px;}',
    '}',
    '.emoji-pop{',
    '  position:fixed;z-index:9999;box-sizing:border-box;',
    '  width:322px;max-width:calc(100vw - 16px);',
    '  max-height:min(320px,45vh);overflow-y:auto;overscroll-behavior:contain;',
    '  background:linear-gradient(180deg,#0c1526,#0a1120);',
    '  border:1px solid rgba(79,209,255,0.35);border-radius:12px;',
    '  box-shadow:0 14px 44px rgba(0,0,0,0.6),0 0 24px rgba(79,209,255,0.15);',
    '  padding:10px 8px 8px;',
    '  display:grid;grid-template-columns:repeat(8,1fr);gap:2px;',
    '}',
    '.emoji-pop .emoji-cat{',
    '  grid-column:1/-1;',
    '  font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;',
    '  color:#7b8ca5;padding:8px 4px 2px;',
    '}',
    '.emoji-pop .emoji-cat:first-child{padding-top:2px;}',
    '.emoji-pop button{',
    '  width:auto;margin-top:0;background:transparent;border:0;border-radius:8px;',
    '  box-shadow:none;color:#e8f7ff;',
    '  font-size:20px;line-height:1;padding:5px 0;cursor:pointer;',
    '  touch-action:manipulation;',
    '}',
    '.emoji-pop button:hover{background:rgba(127,216,255,0.16);}',
    '.emoji-pop button:active{transform:scale(1.25);}',
    '@media (prefers-reduced-motion:reduce){',
    '  button.emoji-btn,.emoji-pop button{transition:none;}',
    '}',
  ].join('\n');

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = PICKER_CSS;
    document.head.appendChild(style);
  }

  /* ---------------------------------------------------------------- */
  /* Popover state                                                     */
  /* ---------------------------------------------------------------- */

  var pop = null;      // open popover element (singleton)
  var openBtn = null;  // button the popover is anchored to

  function isMobile() {
    return window.innerWidth <= 768;
  }

  // The text bar an emoji button feeds: an explicit data-emoji-input
  // selector wins, otherwise the first text input of the surrounding bar.
  function targetInput(btn) {
    var sel = btn.getAttribute('data-emoji-input');
    if (sel) return document.querySelector(sel);
    var bar = btn.closest('.chat-input, .pm-input');
    if (!bar) return null;
    return bar.querySelector('input[type="text"], textarea');
  }

  function buildPopover() {
    var el = document.createElement('div');
    el.className = 'emoji-pop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Emoji picker');

    CATEGORIES.forEach(function (cat) {
      var heading = document.createElement('div');
      heading.className = 'emoji-cat';
      heading.textContent = cat.label;
      el.appendChild(heading);

      cat.emojis.forEach(function (ch) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = ch;
        b.setAttribute('aria-label', ch);
        el.appendChild(b);
      });
    });

    el.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || !openBtn) return;
      e.stopPropagation();
      pick(b.textContent);
    });

    return el;
  }

  function position(btn) {
    var rect = btn.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // Measure while invisible so width/height settle first.
    pop.style.visibility = 'hidden';
    var w = pop.offsetWidth;
    var h = pop.offsetHeight;

    var left = Math.max(8, Math.min(rect.left + (rect.width - w) / 2, vw - w - 8));
    var top;
    if (rect.top - 8 >= h) {
      top = rect.top - h - 8; // enough room above the bar: open upward
    } else {
      top = Math.min(rect.bottom + 8, Math.max(8, vh - h - 8));
    }

    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
    pop.style.visibility = 'visible';
  }

  function open(btn) {
    ensureStyles();

    if (pop && openBtn === btn) { close(); return; } // toggle off

    if (!pop) {
      pop = buildPopover();
      document.body.appendChild(pop);
    }
    openBtn = btn;
    position(btn);
  }

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    openBtn = null;
  }

  // Insert text at the caret and notify listeners (typing indicators etc.).
  function insertText(input, text) {
    var start = (input.selectionStart != null) ? input.selectionStart : input.value.length;
    var end = (input.selectionEnd != null) ? input.selectionEnd : input.value.length;
    if (typeof input.setRangeText === 'function') {
      input.setRangeText(text, start, end, 'end');
    } else {
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function pick(ch) {
    var input = openBtn && targetInput(openBtn);
    if (!input) return;
    insertText(input, ch);
    input.focus();
    // Small screens: hand back to the keyboard after one tap.
    if (isMobile()) close();
  }

  /* ---------------------------------------------------------------- */
  /* Global wiring (event delegation handles runtime-created PM bars)  */
  /* ---------------------------------------------------------------- */

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-emoji-btn]') : null;
    if (btn) {
      e.preventDefault(); // keep the text input's caret where it was
      open(btn);
      return;
    }
    if (pop && !pop.contains(e.target)) close();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && pop) close();
  });

  // Keep the popover glued to its bar; simpler to dismiss when the
  // viewport moves (window drags, mobile keyboard opening, page scroll).
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);

  // Small public API for future consumers.
  window.EmojiPicker = {
    insertText: insertText,
    close: close,
  };

  // Apply the button/popover styles immediately (not lazily on first open)
  // so emoji buttons match their neighbours from the moment the page renders.
  ensureStyles();
})();
