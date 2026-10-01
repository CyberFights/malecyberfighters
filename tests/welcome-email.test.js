/**
 * Tests for welcome email generation and sending on registration.
 * Ensures the welcome email contains the member's login credentials (username and password)
 * and descriptions of all core site features:
 *   - Arena (public chat)
 *   - User roster
 *   - DMs
 *   - Audio calls
 *   - Custom rooms
 *   - Dice matches
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWelcomeEmail, sendWelcomeEmail, escapeHtml } = require('../mailer');

test('buildWelcomeEmail produces a personalized welcome subject', () => {
  const { subject } = buildWelcomeEmail({ username: 'BrawlerBob', password: 'SecretPassword123' });
  assert.equal(subject, 'Welcome to Male Cyber Fighters, BrawlerBob!');
});

test('buildWelcomeEmail includes username and password in both plain text and HTML', () => {
  const username = 'GrapplerJax';
  const password = 'MySuperSecretPassword!456';
  const { text, html } = buildWelcomeEmail({ username, password });

  // Plain text checks
  assert.ok(text.includes(`Username: ${username}`), 'text includes username');
  assert.ok(text.includes(`Password: ${password}`), 'text includes password');
  assert.ok(text.includes('Welcome to Male Cyber Fighters!'), 'text includes welcome greeting');

  // HTML checks
  assert.ok(html.includes(username), 'html includes username');
  assert.ok(html.includes(password), 'html includes password');
  assert.ok(html.includes('Welcome to <strong>Male Cyber Fighters</strong>!'), 'html includes welcome greeting');
});

test('buildWelcomeEmail includes descriptions of all six core features in text and HTML', () => {
  const { text, html } = buildWelcomeEmail({ username: 'Titan', password: 'password123' });

  // 1. Arena (public chat)
  assert.match(text, /The Arena \(Public Chat\)/i, 'text mentions The Arena (Public Chat)');
  assert.match(html, /The Arena \(Public Chat\)/i, 'html mentions The Arena (Public Chat)');
  assert.match(text, /public chatroom/i, 'text describes arena as public chatroom');
  assert.match(html, /public chatroom/i, 'html describes arena as public chatroom');

  // 2. User roster
  assert.match(text, /User Roster/i, 'text mentions User Roster');
  assert.match(html, /User Roster/i, 'html mentions User Roster');
  assert.match(text, /directory|browse/i, 'text describes user roster');
  assert.match(html, /directory|browse/i, 'html describes user roster');

  // 3. DMs (Direct Messages)
  assert.match(text, /DMs \(Direct Messages\)/i, 'text mentions DMs (Direct Messages)');
  assert.match(html, /DMs \(Direct Messages\)/i, 'html mentions DMs (Direct Messages)');
  assert.match(text, /private/i, 'text describes DMs');
  assert.match(html, /private/i, 'html describes DMs');

  // 4. Audio calls
  assert.match(text, /Audio Calls/i, 'text mentions Audio Calls');
  assert.match(html, /Audio Calls/i, 'html mentions Audio Calls');
  assert.match(text, /voice/i, 'text describes audio/voice calls');
  assert.match(html, /voice/i, 'html describes audio/voice calls');

  // 5. Custom rooms
  assert.match(text, /Custom Rooms/i, 'text mentions Custom Rooms');
  assert.match(html, /Custom Rooms/i, 'html mentions Custom Rooms');
  assert.match(text, /rooms/i, 'text describes rooms');
  assert.match(html, /rooms/i, 'html describes rooms');

  // 6. Dice matches
  assert.match(text, /Dice Matches/i, 'text mentions Dice Matches');
  assert.match(html, /Dice Matches/i, 'html mentions Dice Matches');
  assert.match(text, /slash commands|\/create-game|\/move/i, 'text describes dice match moves/commands');
  assert.match(html, /slash commands|\/create-game|\/move/i, 'html describes dice match moves/commands');
});

test('buildWelcomeEmail safely escapes HTML in usernames and passwords', () => {
  const username = 'Fighter<script>alert(1)</script>';
  const password = 'pass"word&<test>\'';
  const { html, text } = buildWelcomeEmail({ username, password });

  // Plain text should have raw values
  assert.ok(text.includes(username));
  assert.ok(text.includes(password));

  // HTML must not contain unescaped tags or dangerous chars
  assert.ok(!html.includes('<script>'), 'no unescaped script tag in html');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped script tag in html');
  assert.ok(html.includes('pass&quot;word&amp;&lt;test&gt;&#39;'), 'escaped password in html');
});

test('buildWelcomeEmail tolerates missing or empty credentials gracefully', () => {
  const { subject, text, html } = buildWelcomeEmail({});
  assert.ok(subject.includes('Welcome to Male Cyber Fighters'));
  assert.ok(text.includes('Username:'));
  assert.ok(text.includes('Password:'));
  assert.ok(html.includes('Username:'));
  assert.ok(html.includes('Password:'));
});

test('sendWelcomeEmail resolves gracefully without throwing when unconfigured', async () => {
  const result = await sendWelcomeEmail({
    to: 'testuser@example.com',
    username: 'TestUser',
    password: 'Password123'
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
});
