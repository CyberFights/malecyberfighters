const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('shared styles prevent focus zoom in mobile chat composers and feature modals', () => {
  const css = read('css', 'features.css');
  const marker = 'iOS Safari and WKWebView zoom the whole page';
  const start = css.indexOf(marker);

  assert.notEqual(start, -1, 'the shared stylesheet should contain the iOS focus-zoom guard');

  const guard = css.slice(start, css.indexOf('\n}\n', start) + 3);
  assert.match(guard, /@media\s*\(max-width:\s*768px\),\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)/);

  for (const selector of [
    '#publicMessage',
    '#dmInput',
    '#roomMessageInput',
    '.pm-input input[type="text"]',
    '.assistance-input-bar input[type="text"]',
    '.mcf-input',
    '.mcf-modal select',
    '.mcf-modal input[type="text"]',
    '.mcf-modal textarea'
  ]) {
    assert.ok(guard.includes(selector), `${selector} should be protected from mobile focus zoom`);
  }

  assert.match(guard, /font-size:\s*16px\s*!important/);
});

test('both app shells load the shared focus and dialog helpers', () => {
  for (const page of ['index.html', 'mobile.html']) {
    const html = read(page);
    assert.match(
      html,
      /<link\s+rel="stylesheet"\s+href="\/css\/features\.css(?:\?[^"\s>]*)?">/i,
      `${page} should load features.css`
    );
    assert.match(
      html,
      /<script\s+src="\/js\/dialog-accessibility\.js"><\/script>/i,
      `${page} should load the dialog focus helper`
    );
  }
});

test('chat composers have accessible names and Send keyboard hints in both shells', () => {
  const expectedLabels = {
    publicMessage: 'Message the public arena',
    dmInput: 'Write a direct message',
    roomMessageInput: 'Write a room message'
  };

  for (const page of ['index.html', 'mobile.html']) {
    const html = read(page);
    for (const [id, label] of Object.entries(expectedLabels)) {
      const input = html.match(new RegExp(`<input\\b(?=[^>]*\\bid="${id}")[^>]*>`));
      assert.ok(input, `${page} should contain #${id}`);
      assert.ok(input[0].includes(`aria-label="${label}"`), `#${id} should have an accessible name`);
      assert.ok(input[0].includes('enterkeyhint="send"'), `#${id} should request the Send keyboard action`);
    }
  }

  assert.match(
    read('js', 'pm.js'),
    /id="pmInput_\$\{targetUsername\}"[^>]*aria-label="Write a direct message"[^>]*enterkeyhint="send"/,
    'the dynamically-created desktop DM composer should have an accessible name and Send hint'
  );
});

test('narrow mobile composers keep Send adjacent to the message and preserve DOM focus order', () => {
  const css = read('css', 'mobile.css');
  const marker = '/* Keep the message field and Send button together on very narrow phones.';
  const start = css.indexOf(marker);
  assert.notEqual(start, -1, 'the narrow composer rules should exist');

  const end = css.indexOf('/* ============================================================\n   MESSAGE EDIT + REPLY', start);
  const narrowRule = css.slice(start, end);
  assert.match(narrowRule, /@media\s*\(max-width:\s*420px\)/);
  assert.match(narrowRule, /#dmPopup \.chat-input input\[type="text"\]/);
  assert.match(narrowRule, /#roomChatPopup \.chat-input input\[type="text"\]/);
  assert.match(narrowRule, /flex:\s*1\s+1\s+calc\(100%\s*-\s*80px\)/);
  assert.doesNotMatch(narrowRule, /\border\s*:/, 'the mobile layout should not visually reorder keyboard controls');

  const pmStart = css.indexOf('/* Full-screen DM windows have extra Call');
  const pmEnd = css.indexOf('/* ============================================================\n   ROOM MEMBERS', pmStart);
  const pmRule = css.slice(pmStart, pmEnd);
  assert.match(pmRule, /\.pm-window \.pm-input\s*\{\s*flex-wrap:\s*wrap;/);
  assert.match(pmRule, /\.pm-window \.pm-input input\[type="text"\][\s\S]*?flex:\s*1\s+1\s+calc\(100%\s*-\s*80px\)/);

  for (const page of ['index.html', 'mobile.html']) {
    const html = read(page);
    const roomStart = html.indexOf('id="roomReplyBar"');
    assert.notEqual(roomStart, -1, `${page} should contain the room composer`);
    const room = html.slice(roomStart, roomStart + 900);
    const roomOrder = [
      'id="roomMessageInput"',
      'id="roomSendBtn"',
      'class="small-btn',
      'id="roomImageBtn"'
    ].map(fragment => room.indexOf(fragment));
    assert.ok(roomOrder.every(position => position >= 0), `${page} should include the room message actions`);
    assert.deepEqual(roomOrder, roomOrder.slice().sort((a, b) => a - b), `${page} should keep room tab order aligned with visual order`);

    const dmStart = html.indexOf('id="dmInput"');
    const dm = html.slice(dmStart, dmStart + 600);
    const dmOrder = ['id="dmInput"', 'id="dmSend"', 'class="small-btn', 'id="dmImageBtn"']
      .map(fragment => dm.indexOf(fragment));
    assert.ok(dmOrder.every(position => position >= 0), `${page} should include the DM composer actions`);
    assert.deepEqual(dmOrder, dmOrder.slice().sort((a, b) => a - b), `${page} should keep DM tab order aligned with visual order`);
  }

  const dynamicPm = read('js', 'pm.js');
  const dynamicStart = dynamicPm.indexOf('<div class="pm-input">');
  const dynamicEnd = dynamicPm.indexOf('</div>', dynamicStart);
  const dynamicComposer = dynamicPm.slice(dynamicStart, dynamicEnd);
  const dynamicOrder = ['id="pmInput_', 'id="pmSend_', 'class="small-btn pm-call', 'id="pmImageBtn_', 'id="pmClipBtn_', 'id="pmEmojiBtn_']
    .map(fragment => dynamicComposer.indexOf(fragment));
  assert.ok(dynamicOrder.every(position => position >= 0));
  assert.deepEqual(dynamicOrder, dynamicOrder.slice().sort((a, b) => a - b));
});

test('mobile defaults improve tap targets, focus indication, and narrow forms', () => {
  const css = read('css', 'mobile.css');
  assert.match(css, /button\.small-btn\s*\{[^}]*min-height:\s*40px/s);
  assert.match(css, /\.chat-header-actions button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.chat-input button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /button:focus-visible[\s\S]*?outline:\s*2px solid/);
  assert.match(css, /\.field-row > \*\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /@media\s*\(max-width:\s*360px\)\s*\{\s*\.field-row\s*\{\s*flex-direction:\s*column;/);
  assert.match(css, /\.small\s*\{\s*font-size:\s*13px;/);
  assert.match(css, /label\s*\{\s*display:\s*block;\s*font-size:\s*14px;/);
  assert.match(css, /html\s*\{\s*background-image:\s*none;\s*background-attachment:\s*scroll;/);
});

test('help and legal overlays are named modal dialogs with focus handling', () => {
  for (const page of ['index.html', 'mobile.html']) {
    const html = read(page);
    const dialogs = [
      ['supportPopup', 'supportTitle'],
      ['modalRules', 'rulesTitle'],
      ['modalTOS', 'tosTitle'],
      ['modalPrivacy', 'privacyTitle']
    ];
    if (page === 'index.html') dialogs.push(['assistancePopup', 'assistanceTitle']);

    for (const [id, titleId] of dialogs) {
      const dialog = html.match(new RegExp(`<div\\b(?=[^>]*\\bid="${id}")[^>]*>`));
      assert.ok(dialog, `${page} should contain #${id}`);
      assert.match(dialog[0], /role="dialog"/);
      assert.match(dialog[0], /aria-modal="true"/);
      assert.ok(dialog[0].includes(`aria-labelledby="${titleId}"`));
      assert.ok(html.includes(`id="${titleId}"`), `${id} should label the dialog`);
      assert.match(dialog[0], /data-dialog-a11y/);
      assert.match(dialog[0], /aria-hidden="true"/);
    }
  }

  assert.match(read('index.html'), /id="assistanceInput"[^>]*data-dialog-initial-focus/);
  assert.match(read('js', 'assistance.js'), /MCFDialogAccessibility\.open\(popup\)/);
  assert.match(read('js', 'assistance.js'), /MCFDialogAccessibility\.close\(popup\)/);

  const helper = read('js', 'dialog-accessibility.js');
  assert.match(helper, /event\.key === 'Escape'/);
  assert.match(helper, /event\.key !== 'Tab'/);
  assert.match(helper, /returnFocus/);
});
