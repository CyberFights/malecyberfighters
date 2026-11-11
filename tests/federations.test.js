/**
 * Federations — the registration form's rules, the view of a federation a
 * member gets, and the action-row wiring.
 *
 * The parts a database cannot be trusted to enforce (a name is long enough,
 * the roles do not collide, the image is an https upload) are pure functions
 * in federations.js, so they run here without Mongo. The page tests load the
 * real public/index.html and public/mobile.html, so the "Federations" section
 * cannot drift away from the buttons the client module binds to.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  LIMITS,
  BUILT_IN_ROLES,
  normalizeFederation,
  normalizeRoles,
  normalizeMessage,
  federationNameKey,
  roleIdFromName,
  isHttpsUrl,
  federationSummary,
  serializeFederation,
  serializeMessages,
  membershipOf
} = require('../federations.js');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const PAGE = read('public', 'index.html');
const MOBILE = read('public', 'mobile.html');
const CLIENT = read('public', 'js', 'federations.js');
const CORE = read('public', 'js', 'features-core.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validBody() {
  return {
    name: 'Iron Ring Federation',
    description: 'A heavyweight promotion for men who like their matches long and loud.',
    rules: 'Titles are won by pinfall or submission and defended once a month.',
    roles: [
      { name: 'Commissioner', description: 'Books the cards' },
      { name: 'Champion' }
    ],
    imageUrl: 'https://i.ibb.co/abc123/ring.png'
  };
}

function doc(overrides = {}) {
  return {
    _id: 'fed1',
    name: 'Iron Ring Federation',
    description: 'A heavyweight promotion.',
    rules: 'Pinfall or submission.',
    imageUrl: '',
    owner: 'owner',
    roles: [{ id: 'commissioner', name: 'Commissioner', description: 'Books the cards' }],
    members: [
      { username: 'owner', display: 'The Owner', roleId: 'owner', joinedAt: new Date('2026-01-01T00:00:00Z') },
      { username: 'rookie', display: 'Rookie', roleId: 'member', joinedAt: new Date('2026-01-02T00:00:00Z') }
    ],
    messages: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides
  };
}

/* ---------------------------------------------------------------
   Registration validation
--------------------------------------------------------------- */

test('a complete registration passes and keeps its roles', () => {
  const result = normalizeFederation(validBody());
  assert.equal(result.ok, true);
  assert.equal(result.federation.name, 'Iron Ring Federation');
  assert.equal(result.federation.nameKey, 'iron ring federation');
  assert.deepEqual(result.federation.roles, [
    { id: 'commissioner', name: 'Commissioner', description: 'Books the cards' },
    { id: 'champion', name: 'Champion', description: '' }
  ]);
  assert.equal(result.federation.imageUrl, 'https://i.ibb.co/abc123/ring.png');
});

test('the name is trimmed, collapsed and required to be a real name', () => {
  const body = validBody();
  body.name = '   Iron    Ring  ';
  assert.equal(normalizeFederation(body).federation.name, 'Iron Ring');

  body.name = '';
  assert.equal(normalizeFederation(body).error, 'name_required');
  body.name = 'ab';
  assert.equal(normalizeFederation(body).error, 'name_short');
  body.name = 'x'.repeat(LIMITS.name + 1);
  assert.equal(normalizeFederation(body).error, 'name_long');
});

test('the name key ignores case so names cannot be duplicated by casing', () => {
  assert.equal(federationNameKey('  IRON   Ring '), 'iron ring');
});

test('the description is the recruiting pitch and must be worth reading', () => {
  const body = validBody();
  body.description = '';
  assert.equal(normalizeFederation(body).error, 'description_required');
  body.description = 'too short';
  assert.equal(normalizeFederation(body).error, 'description_short');
  body.description = 'd'.repeat(LIMITS.description + 1);
  assert.equal(normalizeFederation(body).error, 'description_long');
});

test('rules are optional but capped, and keep their paragraphs', () => {
  const body = validBody();
  body.rules = '';
  assert.equal(normalizeFederation(body).ok, true);
  assert.equal(normalizeFederation(body).federation.rules, '');

  body.rules = 'First rule.\r\n\r\nSecond rule.';
  assert.equal(normalizeFederation(body).federation.rules, 'First rule.\n\nSecond rule.');

  body.rules = 'r'.repeat(LIMITS.rules + 1);
  assert.equal(normalizeFederation(body).error, 'rules_long');
});

test('roles: blank rows are the form’s leftovers, not an error', () => {
  const body = validBody();
  body.roles = [{ name: '' }, { name: '   ' }, { name: 'Referee' }];
  const result = normalizeFederation(body);
  assert.equal(result.ok, true);
  assert.equal(result.federation.roles.length, 1);
  assert.equal(result.federation.roles[0].id, 'referee');
});

test('roles cannot reuse the built-ins or each other', () => {
  assert.equal(normalizeFederation({ ...validBody(), roles: [{ name: 'Owner' }] }).error, 'role_duplicate');
  assert.equal(normalizeFederation({ ...validBody(), roles: [{ name: 'Member' }] }).error, 'role_duplicate');
  assert.equal(normalizeFederation({
    ...validBody(),
    roles: [{ name: 'Champion' }, { name: 'champion' }]
  }).error, 'role_duplicate');
});

test('roles are bounded in number and name length', () => {
  const many = Array.from({ length: LIMITS.roles + 1 }, (unused, i) => ({ name: 'Role ' + i }));
  assert.equal(normalizeFederation({ ...validBody(), roles: many }).error, 'roles_too_many');
  assert.equal(normalizeFederation({ ...validBody(), roles: [{ name: 'R' }] }).error, 'role_name_short');
  assert.equal(normalizeFederation({
    ...validBody(),
    roles: [{ name: 'x'.repeat(LIMITS.roleName + 1) }]
  }).error, 'role_name_long');
  assert.equal(normalizeFederation({ ...validBody(), roles: 'champion' }).error, 'roles_invalid');
});

test('role descriptions are capped rather than rejected', () => {
  const result = normalizeRoles([{ name: 'Enforcer', description: 'e'.repeat(LIMITS.roleDescription + 50) }]);
  assert.equal(result.ok, true);
  assert.equal(result.roles[0].description.length, LIMITS.roleDescription);
});

test('role ids are slugs the owner can read', () => {
  assert.equal(roleIdFromName('Head Booker'), 'head-booker');
  assert.equal(roleIdFromName('  Champion!!  '), 'champion');
  assert.equal(roleIdFromName('!!!'), 'role');
});

test('the image must be an https upload — never a javascript: or http URL', () => {
  const body = validBody();
  for (const bad of ['http://i.ibb.co/x.png', 'javascript:alert(1)', 'not a url', 'https://' + 'x'.repeat(LIMITS.imageUrl)]) {
    body.imageUrl = bad;
    assert.equal(normalizeFederation(body).error, 'image_invalid', bad.slice(0, 30));
  }
  body.imageUrl = '';
  assert.equal(normalizeFederation(body).ok, true, 'the image is optional');
  assert.equal(isHttpsUrl('https://i.ibb.co/x.png'), true);
});

/* ---------------------------------------------------------------
   Chatroom messages
--------------------------------------------------------------- */

test('a chatroom message must say something', () => {
  assert.equal(normalizeMessage({ text: '   ' }).error, 'message_required');
  assert.equal(normalizeMessage({}).error, 'message_required');
  assert.equal(normalizeMessage({ html: '<b>hi</b>' }).error, 'message_required');
});

test('chatroom messages are cleaned and capped', () => {
  const result = normalizeMessage({ text: '  hello\n\n\n\nthere\u0000 ' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello\n\nthere');
  assert.equal(normalizeMessage({ text: 'm'.repeat(LIMITS.message + 80) }).text.length, LIMITS.message);
});

/* ---------------------------------------------------------------
   Views
--------------------------------------------------------------- */

test('the owner sees the roster; an outsider sees the recruiting card', () => {
  const ownerView = serializeFederation(doc(), 'owner');
  assert.equal(ownerView.isOwner, true);
  assert.equal(ownerView.isMember, true);
  assert.equal(ownerView.memberCount, 2);
  assert.deepEqual(ownerView.members.map(member => member.username), ['owner', 'rookie']);

  const outsider = serializeFederation(doc(), 'stranger');
  assert.equal(outsider.isOwner, false);
  assert.equal(outsider.isMember, false);
  assert.deepEqual(outsider.members, [], 'the roster needs membership');
  assert.equal(outsider.memberCount, 2, 'the count does not');
});

test('built-in roles come first and custom roles cannot shadow them', () => {
  const view = serializeFederation(doc({
    roles: [
      { id: 'champion', name: 'Champion', description: '' },
      { id: 'owner', name: 'Impostor', description: 'should be ignored' }
    ]
  }), 'owner');
  assert.deepEqual(view.roles.map(role => role.id), ['owner', 'member', 'champion']);
  assert.equal(view.roles[0].builtIn, true);
  assert.equal(view.roles[2].builtIn, false);
  assert.deepEqual(BUILT_IN_ROLES.map(role => role.id), ['owner', 'member']);
});

test('a summary carries no roster and no bylaws', () => {
  const summary = federationSummary(doc());
  assert.deepEqual(Object.keys(summary).sort(), [
    'createdAt', 'description', 'id', 'imageUrl', 'memberCount', 'name', 'owner'
  ]);
  assert.equal(summary.id, 'fed1');
  assert.equal(summary.memberCount, 2);
});

test('membershipOf reads the member’s own user.federation sub-document', () => {
  assert.equal(membershipOf({ username: 'x' }), null);
  assert.equal(membershipOf({ federation: null }), null);
  assert.deepEqual(
    membershipOf({ federation: { id: 'abc', name: 'Iron Ring', role: 'owner', joinedAt: 'when' } }),
    { id: 'abc', name: 'Iron Ring', role: 'owner', joinedAt: 'when' }
  );
  assert.equal(membershipOf({ federation: { id: 'abc' } }).role, 'member', 'defaults to member');
});

test('the chatroom lists the newest messages, oldest first', () => {
  const messages = Array.from({ length: LIMITS.messagesListed + 20 }, (unused, i) => ({
    from: 'owner',
    display: 'The Owner',
    text: 'message ' + i,
    at: new Date(2026, 0, 1, 0, i)
  }));
  const listed = serializeMessages({ messages });
  assert.equal(listed.length, LIMITS.messagesListed);
  assert.equal(listed[0].text, 'message 20', 'the backlog is trimmed from the front');
  assert.equal(listed[listed.length - 1].text, 'message ' + (LIMITS.messagesListed + 19));
  assert.deepEqual(serializeMessages(null), []);
});

/* ---------------------------------------------------------------
   The action row and the page wiring
--------------------------------------------------------------- */

const FEDERATION_BUTTONS = [
  'btnFederationCreate',
  'btnFederationManage',
  'btnFederationJoin',
  'btnFederationChat'
];

test('both action rows on the desktop page carry the Federations section', () => {
  const dom = new JSDOM(PAGE);
  const { document } = dom.window;
  const rows = document.querySelectorAll('.actions');
  assert.equal(rows.length, 2);

  rows.forEach((row, index) => {
    const group = row.querySelector('.nav-group[data-nav-group="federations"]');
    assert.ok(group, `action row ${index + 1} has the Federations group`);
    const toggle = group.querySelector(':scope > .nav-group-toggle');
    assert.equal(toggle.id, 'navFederations');
    assert.equal(toggle.firstChild.textContent, 'Federations', 'the toggle label is the first text node (i18n swaps it)');

    const buttons = Array.from(group.querySelectorAll('.nav-group-menu > button')).map(button => button.id);
    assert.deepEqual(buttons, FEDERATION_BUTTONS);
    const labels = Array.from(group.querySelectorAll('.nav-group-menu > button')).map(button => button.textContent.trim());
    assert.deepEqual(labels, ['Create', 'Manage', 'Join', 'Chatroom']);
  });

  // Bound by id from federations.js, so every copy must exist.
  FEDERATION_BUTTONS.forEach(id => {
    assert.equal(document.querySelectorAll(`[id="${id}"]`).length, 2, `${id} in both rows`);
  });

  dom.window.close();
});

test('the pages load the federation client module', () => {
  assert.match(PAGE, /<script src="\/js\/federations\.js\?v=1"><\/script>/);
  assert.match(MOBILE, /<script src="\/js\/federations\.js\?v=1"><\/script>/);
});

test('the mobile page offers the same four federation buttons', () => {
  const dom = new JSDOM(MOBILE);
  FEDERATION_BUTTONS.forEach(id => {
    assert.ok(dom.window.document.getElementById(id), id + ' on the mobile page');
  });
  dom.window.close();
});

test('the client module speaks the federation API', () => {
  assert.match(CLIENT, /window\.MCFFederations/);
  assert.match(CLIENT, /openCreate/);
  assert.match(CLIENT, /openManage/);
  assert.match(CLIENT, /openJoin/);
  assert.match(CLIENT, /openChatroom/);
  assert.match(CLIENT, /MCF\.postJSON\('\/api\/federations'/, 'creates through the API');
  assert.match(CLIENT, /\/api\/upload-image/, 'uploads the federation image through the shared endpoint');
  assert.match(CLIENT, /\/messages/, 'the chatroom talks to the messages endpoint');
});


/* ---------------------------------------------------------------
   The registration popup, driven through the real client module
--------------------------------------------------------------- */

/**
 * Load the desktop page and the two scripts the feature needs (features-core
 * then federations), signed in as `boss`. The network is stubbed so the test
 * can watch exactly what the form would send.
 */
function startClient({ mine = { ok: true, federation: null }, create } = {}) {
  const dom = new JSDOM(PAGE, {
    url: 'https://male-cyber-fighters.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.localStorage.setItem('cw_session_v1', JSON.stringify({ username: 'boss', display: 'Boss' }));
  window.eval(CORE);
  window.eval(CLIENT);

  const calls = [];
  window.MCF.getJSON = url => {
    calls.push({ method: 'GET', url });
    return Promise.resolve(mine);
  };
  window.MCF.postJSON = (url, body) => {
    calls.push({ method: 'POST', url, body });
    return Promise.resolve(create ? create(body) : { ok: false, error: 'server_error' });
  };
  return { dom, window, document: window.document, calls };
}

test('Create opens the registration popup with every field the federation needs', async () => {
  const client = startClient();
  try {
    client.window.MCFFederations.openCreate();
    await sleep(20);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.ok(body, 'the popup opened');
    assert.equal(client.document.querySelector('.mcf-modal-title').textContent, 'Register a federation');

    for (const id of ['mcfFedName', 'mcfFedDescription', 'mcfFedRules', 'mcfFedRoles', 'mcfFedImage', 'mcfFedSubmit', 'mcfFedCancel', 'mcfFedAddRole']) {
      assert.ok(body.querySelector('#' + id), id + ' is in the form');
    }

    assert.equal(body.querySelectorAll('.mcf-fed-role-row').length, 1, 'one role row to start');

    // Roles can be added, up to the server's cap.
    body.querySelector('#mcfFedAddRole').click();
    body.querySelector('#mcfFedAddRole').click();
    assert.equal(body.querySelectorAll('.mcf-fed-role-row').length, 3);

    // Cancel closes it again without posting anything.
    body.querySelector('#mcfFedCancel').click();
    await sleep(220);
    assert.equal(client.document.querySelectorAll('.mcf-modal').length, 0);
    assert.ok(!client.calls.some(call => call.method === 'POST'), 'cancel never creates');
  } finally {
    client.dom.window.close();
  }
});

test('Create posts the name, description, rules, roles and uploaded image', async () => {
  let posted = null;
  const client = startClient({
    create: body => {
      posted = body;
      return {
        ok: true,
        federation: {
          id: 'fed1',
          name: body.name,
          owner: 'boss',
          description: body.description,
          rules: body.rules,
          imageUrl: body.imageUrl,
          roles: [
            { id: 'owner', name: 'Owner', builtIn: true },
            { id: 'member', name: 'Member', builtIn: true }
          ].concat(body.roles.map(role => ({
            id: String(role.name).toLowerCase(),
            name: role.name,
            description: role.description,
            builtIn: false
          }))),
          members: [{ username: 'boss', display: 'Boss', roleId: 'owner' }],
          memberCount: 1,
          isOwner: true,
          isMember: true
        }
      };
    }
  });

  try {
    client.window.MCFFederations.openCreate();
    await sleep(20);

    const body = client.document.querySelector('.mcf-modal-body');
    body.querySelector('#mcfFedName').value = 'Iron Ring Federation';
    body.querySelector('#mcfFedDescription').value = 'A heavyweight promotion for men who like it rough.';
    body.querySelector('#mcfFedRules').value = 'Titles are won by pinfall.';

    const firstRole = body.querySelectorAll('.mcf-fed-role-row')[0];
    firstRole.querySelector('[data-role-name]').value = 'Commissioner';
    firstRole.querySelector('[data-role-desc]').value = 'Books the cards';

    body.querySelector('#mcfFedSubmit').click();
    // The form fades out before its node is removed, then the new card is up.
    await sleep(260);

    assert.ok(posted, 'the form posted');
    assert.equal(posted.name, 'Iron Ring Federation');
    assert.equal(posted.description, 'A heavyweight promotion for men who like it rough.');
    assert.equal(posted.rules, 'Titles are won by pinfall.');
    assert.deepEqual(JSON.parse(JSON.stringify(posted.roles)), [{ name: 'Commissioner', description: 'Books the cards' }]);

    const post = client.calls.find(call => call.method === 'POST');
    assert.equal(post.url, '/api/federations');

    // The form gives way to the new federation's card.
    assert.equal(client.document.querySelectorAll('.mcf-modal').length, 1);
    assert.equal(client.document.querySelector('.mcf-modal-title').textContent, 'Iron Ring Federation');
    assert.match(client.document.querySelector('.mcf-modal-body').textContent, /You run this federation/);
    assert.match(client.document.querySelector('.mcf-modal-body').textContent, /Commissioner/);

    // …and the member's cached user info now names the federation.
    const cached = JSON.parse(client.window.localStorage.getItem('cw_session_v1'));
    assert.equal(cached.federation.name, 'Iron Ring Federation');
    assert.equal(cached.federation.role, 'owner');
  } finally {
    client.dom.window.close();
  }
});

test('pressing Create when the member already runs a federation explains it', async () => {
  const client = startClient({
    mine: {
      ok: true,
      federation: {
        id: 'fed1',
        name: 'Iron Ring Federation',
        owner: 'boss',
        description: 'Already here.',
        rules: '',
        roles: [],
        members: [{ username: 'boss', display: 'Boss', roleId: 'owner' }],
        memberCount: 1,
        isOwner: true,
        isMember: true
      }
    }
  });

  try {
    client.window.MCFFederations.openCreate();
    await sleep(20);

    assert.equal(client.document.querySelector('.mcf-modal-title').textContent, 'Iron Ring Federation');
    assert.ok(!client.document.querySelector('#mcfFedName'), 'the registration form never opens');
  } finally {
    client.dom.window.close();
  }
});
