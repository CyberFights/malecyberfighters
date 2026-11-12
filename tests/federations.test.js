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
  normalizeFederationDetails,
  normalizeRoles,
  normalizeRoleDefinition,
  normalizeMessage,
  federationNameKey,
  roleIdFromName,
  isHttpsUrl,
  federationSummary,
  roleList,
  roleIndex,
  isAdminRole,
  canManageFederation,
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
    { id: 'commissioner', name: 'Commissioner', description: 'Books the cards', admin: false },
    { id: 'champion', name: 'Champion', description: '', admin: false }
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
  assert.equal(normalizeFederation({ ...validBody(), roles: [{ name: 'Co-owner' }] }).error, 'role_duplicate');
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
  assert.deepEqual(view.roles.map(role => role.id), ['owner', 'co-owner', 'member', 'champion']);
  assert.equal(view.roles[0].builtIn, true);
  assert.equal(view.roles[1].admin, true, 'the built-in Co-owner is an admin role');
  assert.equal(view.roles[2].admin, false, 'the built-in Member is not');
  assert.equal(view.roles[3].builtIn, false);
  assert.deepEqual(BUILT_IN_ROLES.map(role => role.id), ['owner', 'co-owner', 'member']);
  assert.deepEqual(BUILT_IN_ROLES.filter(role => role.admin).map(role => role.id), ['owner', 'co-owner']);
});

test('join requests belong to the managers, and the applicant sees only their own flag', () => {
  const board = doc({
    requests: [
      {
        username: 'hopeful',
        display: 'Hopeful',
        requestedAt: new Date('2026-01-03T00:00:00Z')
      }
    ]
  });

  const ownerView = serializeFederation(board, 'owner');
  assert.equal(ownerView.requests.length, 1);
  assert.equal(ownerView.requests[0].username, 'hopeful');
  assert.equal(ownerView.requests[0].requestedAt.toISOString(), '2026-01-03T00:00:00.000Z');
  assert.equal(ownerView.requested, false, 'the owner is not waiting on themselves');

  const memberView = serializeFederation(board, 'rookie');
  assert.deepEqual(memberView.requests, [], 'a plain member never sees the waiting list');
  assert.equal(memberView.requested, false);

  const applicantView = serializeFederation(board, 'hopeful');
  assert.deepEqual(applicantView.requests, []);
  assert.equal(applicantView.requested, true, 'but they know their request is pending');
  assert.deepEqual(applicantView.members, [], 'and still cannot see the roster');

  assert.equal(serializeFederation(board, 'stranger').requested, false);
});

test('both DM clients can answer a join request', () => {
  const desktop = read('public', 'js', 'pm.js');
  const mobile = read('public', 'js', 'mobile.js');
  for (const source of [desktop, mobile]) {
    assert.match(source, /federationJoin/, 'the DM renderer knows the type');
    assert.match(source, /fedJoinApprove/);
    assert.match(source, /fedJoinReject/);
    assert.match(source, /\/requests\//, 'and posts the decision to the request route');
  }
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
function startClient({ mine = { ok: true, federation: null }, create, auth, username = 'boss' } = {}) {
  const dom = new JSDOM(PAGE, {
    url: 'https://male-cyber-fighters.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  window.localStorage.setItem('cw_session_v1', JSON.stringify({ username, display: username.toUpperCase() }));
  window.eval(CORE);
  window.eval(CLIENT);

  const calls = [];
  window.MCF.getJSON = url => {
    calls.push({ method: 'GET', url });
    return Promise.resolve(typeof mine === 'function' ? mine(url, calls) : mine);
  };
  window.MCF.postJSON = (url, body, method) => {
    calls.push({ method: method || 'POST', url, body });
    return Promise.resolve(create ? create(body, url) : { ok: false, error: 'server_error' });
  };
  window.MCF.authFetch = (url, options) => {
    options = options || {};
    calls.push({
      method: options.method || 'GET',
      url,
      body: options.body ? JSON.parse(options.body) : undefined
    });
    const answer = typeof auth === 'function' ? auth(url, options, calls) : (auth || { ok: false, error: 'server_error' });
    return Promise.resolve({ json: () => Promise.resolve(answer) });
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
    assert.ok(body.querySelector('.mcf-fed-role-row [data-role-admin]'), 'a role can be marked as an admin role');

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
    firstRole.querySelector('[data-role-admin]').checked = true;

    body.querySelector('#mcfFedSubmit').click();
    // The form fades out before its node is removed, then the new card is up.
    await sleep(260);

    assert.ok(posted, 'the form posted');
    assert.equal(posted.name, 'Iron Ring Federation');
    assert.equal(posted.description, 'A heavyweight promotion for men who like it rough.');
    assert.equal(posted.rules, 'Titles are won by pinfall.');
    assert.deepEqual(JSON.parse(JSON.stringify(posted.roles)), [
      { name: 'Commissioner', description: 'Books the cards', admin: true }
    ]);

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

/* ---------------------------------------------------------------
   Manage: roles, permissions and presence
--------------------------------------------------------------- */

test('custom roles can be marked as admin roles', () => {
  const result = normalizeRoles([
    { name: 'Enforcer', admin: true },
    { name: 'Champion' },
    { name: 'Stringy', admin: 'true' }
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.roles.map(role => role.admin), [true, false, true]);
});

test('only the owner and admin roles can manage a federation', () => {
  const board = doc({
    roles: [
      { id: 'commissioner', name: 'Commissioner', admin: false },
      { id: 'enforcer', name: 'Enforcer', admin: true }
    ],
    members: [
      { username: 'owner', display: 'The Owner', roleId: 'owner', joinedAt: null },
      { username: 'co', display: 'Co', roleId: 'co-owner', joinedAt: null },
      { username: 'strong', display: 'Strong', roleId: 'enforcer', joinedAt: null },
      { username: 'rookie', display: 'Rookie', roleId: 'member', joinedAt: null },
      { username: 'booker', display: 'Booker', roleId: 'commissioner', joinedAt: null }
    ]
  });

  assert.equal(canManageFederation(board, 'owner'), true, 'the owner always manages');
  assert.equal(canManageFederation(board, 'co'), true, 'the built-in Co-owner manages');
  assert.equal(canManageFederation(board, 'strong'), true, 'a custom admin role manages');
  assert.equal(canManageFederation(board, 'rookie'), false, 'a plain member does not');
  assert.equal(canManageFederation(board, 'booker'), false, 'a non-admin custom role does not');
  assert.equal(canManageFederation(board, 'nobody'), false, 'a non-member does not');
  assert.equal(canManageFederation(null, 'owner'), false);

  const index = roleIndex(board);
  assert.equal(index['co-owner'].admin, true);
  assert.equal(index.member.admin, false);
  assert.equal(isAdminRole(board, 'enforcer'), true);
  assert.equal(isAdminRole(board, 'commissioner'), false);
  assert.deepEqual(roleList(board).map(role => role.id), ['owner', 'co-owner', 'member', 'commissioner', 'enforcer']);
});

test('the details form edits everything except the roles', () => {
  const result = normalizeFederationDetails({
    name: '  Iron Ring Wrestling ',
    description: 'The same federation, with a sharper name.',
    rules: 'Pinfall, submission or KO.',
    imageUrl: 'https://i.ibb.co/new/ring.png',
    roles: [{ name: 'Champion' }]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.details).sort(), ['description', 'imageUrl', 'name', 'nameKey', 'rules']);
  assert.equal(result.details.name, 'Iron Ring Wrestling');
  assert.ok(!('roles' in result.details), 'roles are managed one member at a time');

  assert.equal(normalizeFederationDetails({ name: 'No', description: 'Long enough description.' }).error, 'name_short');
  assert.equal(normalizeFederationDetails({ name: 'Valid name', description: ' ' }).error, 'description_required');
});

test('the serialised federation says who can manage and who is online', () => {
  const board = doc({
    members: [
      { username: 'owner', display: 'The Owner', roleId: 'owner', joinedAt: null },
      { username: 'co', display: 'Co', roleId: 'co-owner', joinedAt: null },
      { username: 'rookie', display: 'Rookie', roleId: 'member', joinedAt: null }
    ]
  });
  const people = [
    { username: 'co', display: 'Co', online: true, lastSeenAt: new Date('2026-01-01T00:00:00Z') },
    { username: 'rookie', display: 'Rookie', online: false, lastSeenAt: new Date('2026-01-02T10:00:00Z') }
  ];

  const asCoOwner = serializeFederation(board, 'co', people);
  assert.equal(asCoOwner.canManage, true);
  assert.equal(asCoOwner.viewerRole, 'co-owner');
  const co = asCoOwner.members.find(member => member.username === 'co');
  assert.equal(co.online, true, 'presence comes through the roster');
  assert.equal(co.lastSeenAt.toISOString(), '2026-01-01T00:00:00.000Z');

  const asMember = serializeFederation(board, 'rookie', people);
  assert.equal(asMember.canManage, false);
  assert.equal(asMember.viewerRole, 'member');
  assert.equal(asMember.members.find(member => member.username === 'rookie').online, false);

  const asOutsider = serializeFederation(board, 'stranger', people);
  assert.equal(asOutsider.canManage, false);
  assert.equal(asOutsider.viewerRole, null);
  assert.deepEqual(asOutsider.members, []);
});


/* ---------------------------------------------------------------
   Manage → Roles: one role at a time
--------------------------------------------------------------- */

test('a new role gets an id from its name and a plain “can manage” flag', () => {
  const board = doc();
  const result = normalizeRoleDefinition(
    { name: '  Ring  Announcer ', description: 'Calls the matches', admin: 'true' },
    board
  );
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.role)), {
    id: 'ring-announcer',
    name: 'Ring Announcer',
    description: 'Calls the matches',
    admin: true
  });
});

test('new roles must have a real name and cannot shadow a role that exists', () => {
  const board = doc();

  assert.equal(normalizeRoleDefinition({ name: '   ' }, board).error, 'role_name_required');
  assert.equal(normalizeRoleDefinition({ name: 'A' }, board).error, 'role_name_short');
  assert.equal(normalizeRoleDefinition({ name: 'x'.repeat(30) }, board).error, 'role_name_long');

  // Built-ins and the registration's own custom role are both taken.
  assert.equal(normalizeRoleDefinition({ name: 'Member' }, board).error, 'role_duplicate');
  assert.equal(normalizeRoleDefinition({ name: 'commissioner' }, board).error, 'role_duplicate');

  // The list is capped, like the registration form.
  const full = doc({ roles: Array.from({ length: LIMITS.roles }, (unused, index) => ({
    id: 'role-' + index,
    name: 'Role ' + index,
    description: '',
    admin: false
  })) });
  assert.equal(normalizeRoleDefinition({ name: 'One Too Many' }, full).error, 'roles_too_many');
});

test('editing a role keeps its id, and only custom roles are editable', () => {
  const board = doc();
  const custom = roleList(board).find(role => role.id === 'commissioner');

  const renamed = normalizeRoleDefinition(
    { name: 'Head Booker', description: 'Writes the cards', admin: false },
    board,
    custom.id
  );
  assert.equal(renamed.ok, true);
  assert.equal(renamed.role.id, 'commissioner', 'the id does not follow the name');
  assert.equal(renamed.role.name, 'Head Booker');

  // Renaming onto another role's name is refused…
  assert.equal(
    normalizeRoleDefinition({ name: 'Member' }, board, custom.id).error,
    'role_duplicate'
  );
  // …but keeping its own name is not a duplicate of itself.
  assert.equal(
    normalizeRoleDefinition({ name: 'Commissioner' }, board, custom.id).ok,
    true
  );

  // Built-ins are off limits, and a role that vanished is a 404.
  assert.equal(normalizeRoleDefinition({ name: 'Boss' }, board, 'owner').error, 'built_in_role');
  assert.equal(normalizeRoleDefinition({ name: 'Boss' }, board, 'ghost').error, 'role_not_found');
});

test('custom roles come back from the serializer with their admin flag', () => {
  const view = serializeFederation(doc(), 'boss');
  const custom = view.roles.find(role => role.id === 'commissioner');
  assert.equal(custom.builtIn, false);
  assert.equal(custom.admin, false);
  assert.equal(view.roles.filter(role => role.builtIn).length, BUILT_IN_ROLES.length);
});

/* ---------------------------------------------------------------
   The Manage window itself
--------------------------------------------------------------- */

const HOUR = 60 * 60 * 1000;

function federationFixture(overrides = {}) {
  return {
    id: 'fed1',
    name: 'Iron Ring Federation',
    owner: 'boss',
    description: 'A heavyweight promotion for men who like their matches long.',
    rules: 'Pinfall or submission.',
    imageUrl: '',
    roles: [
      { id: 'owner', name: 'Owner', description: '', admin: true, builtIn: true },
      { id: 'co-owner', name: 'Co-owner', description: '', admin: true, builtIn: true },
      { id: 'member', name: 'Member', description: '', admin: false, builtIn: true },
      { id: 'commissioner', name: 'Commissioner', description: 'Books the cards', admin: false, builtIn: false }
    ],
    members: [
      { username: 'boss', display: 'Boss', roleId: 'owner', online: true, lastSeenAt: new Date().toISOString() },
      {
        username: 'rookie',
        display: 'Rookie',
        roleId: 'member',
        online: false,
        lastSeenAt: new Date(Date.now() - 2 * HOUR).toISOString()
      }
    ],
    memberCount: 2,
    requests: [],
    requested: false,
    isMember: true,
    isOwner: true,
    canManage: true,
    viewerRole: 'owner',
    ...overrides
  };
}

test('Manage is refused to everyone but the owner and admins', async () => {
  const client = startClient({
    mine: { ok: true, federation: federationFixture({ canManage: false, isOwner: false, viewerRole: 'member' }) }
  });
  try {
    client.window.MCFFederations.openManage();
    await sleep(20);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.match(body.textContent, /Only the owner and the federation’s co-owners\/admins/);
    assert.equal(body.querySelectorAll('[data-fed-role]').length, 0, 'no role controls');
    assert.equal(body.querySelectorAll('[data-fed-remove]').length, 0, 'no remove buttons');
    assert.equal(body.querySelectorAll('[data-fed-tab]').length, 0, 'no manage tabs');
  } finally {
    client.dom.window.close();
  }
});

test('Manage lists the roster with last-online, role change and remove', async () => {
  const client = startClient({
    mine: { ok: true, federation: federationFixture() },
    create: () => ({
      ok: true,
      federation: federationFixture({
        members: [
          federationFixture().members[0],
          { username: 'rookie', display: 'Rookie', roleId: 'commissioner', online: false, lastSeenAt: new Date().toISOString() }
        ]
      })
    }),
    auth: () => ({
      ok: true,
      removed: 'rookie',
      selfRemoved: false,
      federation: federationFixture({ members: [federationFixture().members[0]], memberCount: 1 })
    })
  });

  try {
    client.window.MCFFederations.openManage();
    await sleep(20);

    assert.equal(client.document.querySelector('.mcf-modal-title').textContent, 'Iron Ring Federation — manage');
    const tabs = client.document.querySelectorAll('[data-fed-tab]');
    assert.deepEqual(
      Array.from(tabs).map(tab => tab.dataset.fedTab),
      ['members', 'roles', 'details'],
      'the roster, the roles and the details are three tabs'
    );
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');

    const rows = client.document.querySelectorAll('.mcf-fed-manage-row');
    assert.equal(rows.length, 2);

    // The owner row is immutable.
    const ownerRow = rows[0];
    assert.match(ownerRow.textContent, /Boss/);
    assert.match(ownerRow.textContent, /Owner/);
    assert.equal(ownerRow.querySelector('[data-fed-role]'), null);
    assert.equal(ownerRow.querySelector('[data-fed-remove]'), null);

    // The plain member row has presence and both controls.
    const memberRow = rows[1];
    assert.match(memberRow.textContent, /Rookie/);
    assert.match(memberRow.textContent, /Last online 2h ago/);
    const select = memberRow.querySelector('[data-fed-role]');
    const remove = memberRow.querySelector('[data-fed-remove]');
    assert.ok(select && remove);
    assert.deepEqual(Array.from(select.options).map(option => option.value), ['co-owner', 'member', 'commissioner']);

    // Changing the role posts the member and the new role.
    select.value = 'commissioner';
    select.dispatchEvent(new client.window.Event('change'));
    await sleep(20);
    const roleCall = client.calls.find(call => call.method === 'POST' && /\/members\/rookie\/role$/.test(call.url));
    assert.ok(roleCall, 'role change posted');
    assert.deepEqual(JSON.parse(JSON.stringify(roleCall.body)), { roleId: 'commissioner' });

    // Removing takes two taps: the first arms, the second deletes.
    const removeButton = client.document.querySelector('[data-fed-remove]');
    removeButton.click();
    assert.equal(removeButton.textContent, 'Confirm remove');
    assert.ok(!client.calls.some(call => call.method === 'DELETE'), 'one tap never removes');
    removeButton.click();
    await sleep(20);

    const deleteCall = client.calls.find(call => call.method === 'DELETE');
    assert.equal(deleteCall.url, '/api/federations/fed1/members/rookie');
    assert.equal(client.document.querySelectorAll('.mcf-fed-manage-row').length, 1, 'the roster refreshed');
  } finally {
    client.dom.window.close();
  }
});

test('the Details tab edits the federation card', async () => {
  const client = startClient({
    mine: { ok: true, federation: federationFixture() },
    auth: () => ({
      ok: true,
      federation: federationFixture({ name: 'Iron Ring Wrestling', description: 'Sharper now.' })
    })
  });

  try {
    client.window.MCFFederations.openManage();
    await sleep(20);

    client.document.querySelector('[data-fed-tab="details"]').click();

    const name = client.document.querySelector('#mcfFedDetailsName');
    const description = client.document.querySelector('#mcfFedDetailsDescription');
    const rules = client.document.querySelector('#mcfFedDetailsRules');
    const save = client.document.querySelector('#mcfFedDetailsSave');
    assert.equal(name.value, 'Iron Ring Federation');
    assert.equal(rules.value, 'Pinfall or submission.');
    assert.ok(client.document.querySelector('#mcfFedDetailsImage'), 'an image can be replaced');

    name.value = 'Iron Ring Wrestling';
    description.value = 'Sharper now.';
    save.click();
    await sleep(20);

    const patch = client.calls.find(call => call.method === 'PATCH');
    assert.equal(patch.url, '/api/federations/fed1');
    assert.equal(patch.body.name, 'Iron Ring Wrestling');
    assert.equal(patch.body.description, 'Sharper now.');
    assert.equal(patch.body.imageUrl, '');

    // The title follows the saved name.
    assert.equal(client.document.querySelector('.mcf-modal-title').textContent, 'Iron Ring Wrestling — manage');
  } finally {
    client.dom.window.close();
  }
});

test('a co-owner can leave the federation from their own row', async () => {
  const co = {
    username: 'co',
    display: 'Co',
    roleId: 'co-owner',
    online: true,
    lastSeenAt: new Date().toISOString()
  };
  const board = federationFixture({
    isOwner: false,
    viewerRole: 'co-owner',
    canManage: true,
    members: [federationFixture().members[0], co],
    memberCount: 2
  });

  const client = startClient({
    username: 'co',
    mine: { ok: true, federation: board },
    auth: () => ({ ok: true, removed: 'co', selfRemoved: true, federation: board })
  });

  try {
    client.window.MCFFederations.openManage();
    await sleep(20);

    const selfRow = client.document.querySelectorAll('.mcf-fed-manage-row')[1];
    assert.match(selfRow.textContent, /Co-owner/);
    assert.equal(selfRow.querySelector('[data-fed-role]'), null, 'no self-demotion');
    const leave = selfRow.querySelector('[data-fed-leave]');
    assert.ok(leave, 'leaving is offered on your own row');

    leave.click();
    assert.equal(leave.textContent, 'Confirm leave');
    leave.click();
    // The popup fades out before its node is removed.
    await sleep(260);

    const call = client.calls.find(entry => entry.method === 'DELETE');
    assert.equal(call.url, '/api/federations/fed1/members/co');
    assert.equal(client.document.querySelectorAll('.mcf-modal').length, 0, 'the window closes');
    const cached = JSON.parse(client.window.localStorage.getItem('cw_session_v1'));
    assert.equal(cached.federation, null, 'the cached membership is cleared');
  } finally {
    client.dom.window.close();
  }
});

/* ---------------------------------------------------------------
   Manage → the Roles tab
--------------------------------------------------------------- */

test('the Roles tab lists built-ins as read-only and custom roles as editable', async () => {
  const client = startClient({ mine: { ok: true, federation: federationFixture() } });
  try {
    client.window.MCFFederations.openManage();
    await sleep(20);
    client.document.querySelector('[data-fed-tab="roles"]').click();

    const panel = client.document.querySelector('#mcfFedManagePanel');
    assert.equal(panel.querySelectorAll('.mcf-fed-role-builtin').length, 3, 'Owner, Co-owner, Member');
    for (const builtIn of ['owner', 'co-owner', 'member']) {
      assert.equal(panel.querySelector(`[data-fed-role-edit="${builtIn}"]`), null, builtIn + ' is not editable');
      assert.equal(panel.querySelector(`[data-fed-role-delete="${builtIn}"]`), null, builtIn + ' is not deletable');
    }

    // The registration's custom role can be edited and removed.
    assert.ok(panel.querySelector('[data-fed-role-edit="commissioner"]'));
    assert.ok(panel.querySelector('[data-fed-role-delete="commissioner"]'));

    // The owner gets the "Can manage" checkbox on the add form.
    const editor = panel.querySelector('#mcfFedRoleEditor');
    assert.ok(editor, 'the add form is there');
    assert.ok(editor.querySelector('[data-fed-role-admin]'), 'the owner can hand out management rights');
    assert.equal(editor.querySelector('[data-fed-role-cancel]'), null, 'nothing to cancel when adding');
  } finally {
    client.dom.window.close();
  }
});

test('adding a role posts it and shows the saved role', async () => {
  const saved = federationFixture({
    roles: federationFixture().roles.concat([
      { id: 'ring-announcer', name: 'Ring Announcer', description: 'Calls the matches', admin: true, builtIn: false }
    ])
  });

  const client = startClient({
    mine: { ok: true, federation: federationFixture() },
    create: (body, url) => {
      assert.equal(url, '/api/federations/fed1/roles');
      return { ok: true, federation: saved };
    }
  });

  try {
    client.window.MCFFederations.openManage();
    await sleep(20);
    client.document.querySelector('[data-fed-tab="roles"]').click();

    const editor = client.document.querySelector('#mcfFedRoleEditor');
    editor.querySelector('[data-fed-role-name]').value = 'Ring Announcer';
    editor.querySelector('[data-fed-role-desc]').value = 'Calls the matches';
    editor.querySelector('[data-fed-role-admin]').checked = true;
    editor.querySelector('[data-fed-role-save]').click();
    await sleep(20);

    const post = client.calls.find(call => call.method === 'POST' && call.url === '/api/federations/fed1/roles');
    assert.ok(post, 'the role was posted');
    assert.deepEqual(
      JSON.parse(JSON.stringify(post.body)),
      { name: 'Ring Announcer', description: 'Calls the matches', admin: true }
    );

    const panel = client.document.querySelector('#mcfFedManagePanel');
    assert.match(panel.textContent, /Ring Announcer/);
    assert.ok(panel.querySelector('[data-fed-role-edit="ring-announcer"]'));
    // The panel re-rendered, so read the fresh form rather than the old node.
    const freshForm = client.document.querySelector('#mcfFedRoleEditor');
    assert.equal(freshForm.querySelector('[data-fed-role-name]').value, '', 'the form is cleared');
  } finally {
    client.dom.window.close();
  }
});

test('a role is renamed in place, keeping its id', async () => {
  const renamed = federationFixture({
    roles: federationFixture().roles.map(role =>
      role.id === 'commissioner'
        ? { ...role, name: 'Head Booker', description: 'Writes the cards' }
        : role)
  });

  const client = startClient({
    mine: { ok: true, federation: federationFixture() },
    create: (body, url) => {
      assert.equal(url, '/api/federations/fed1/roles/commissioner');
      return { ok: true, federation: renamed };
    }
  });

  try {
    client.window.MCFFederations.openManage();
    await sleep(20);
    client.document.querySelector('[data-fed-tab="roles"]').click();
    client.document.querySelector('[data-fed-role-edit="commissioner"]').click();

    const editor = client.document.querySelector('#mcfFedRoleEditor');
    assert.equal(editor.querySelector('[data-fed-role-name]').value, 'Commissioner', 'prefilled');
    assert.ok(editor.querySelector('[data-fed-role-cancel]'), 'editing can be cancelled');

    editor.querySelector('[data-fed-role-name]').value = 'Head Booker';
    editor.querySelector('[data-fed-role-desc]').value = 'Writes the cards';
    editor.querySelector('[data-fed-role-save]').click();
    await sleep(20);

    const patch = client.calls.find(call => call.method === 'PATCH');
    assert.ok(patch, 'a PATCH was sent');
    assert.equal(patch.url, '/api/federations/fed1/roles/commissioner');
    assert.deepEqual(
      JSON.parse(JSON.stringify(patch.body)),
      { name: 'Head Booker', description: 'Writes the cards', admin: false }
    );

    const panel = client.document.querySelector('#mcfFedManagePanel');
    assert.match(panel.textContent, /Head Booker/);
    assert.doesNotMatch(panel.textContent, /Commissioner/);
  } finally {
    client.dom.window.close();
  }
});

test('cancelling an edit changes nothing, and an in-use role explains itself', async () => {
  const client = startClient({
    mine: { ok: true, federation: federationFixture() },
    auth: () => ({ ok: false, error: 'role_in_use', holders: ['rookie'] })
  });

  try {
    client.window.MCFFederations.openManage();
    await sleep(20);
    client.document.querySelector('[data-fed-tab="roles"]').click();

    client.document.querySelector('[data-fed-role-edit="commissioner"]').click();
    client.document.querySelector('[data-fed-role-cancel]').click();
    assert.equal(client.calls.some(call => call.method === 'PATCH'), false, 'cancel posts nothing');
    assert.match(client.document.querySelector('#mcfFedManagePanel').textContent, /Commissioner/);

    // Delete takes two taps: the first only arms the button.
    const remove = client.document.querySelector('[data-fed-role-delete="commissioner"]');
    remove.click();
    assert.equal(remove.textContent, 'Confirm delete');
    assert.equal(client.calls.some(call => call.method === 'DELETE'), false);
    remove.click();
    await sleep(20);

    const del = client.calls.find(call => call.method === 'DELETE');
    assert.ok(del, 'the second tap deletes');
    assert.equal(del.url, '/api/federations/fed1/roles/commissioner');

    const panel = client.document.querySelector('#mcfFedManagePanel');
    assert.match(panel.textContent, /still holds that role/i, 'the refusal is explained');
  } finally {
    client.dom.window.close();
  }
});

test('a co-owner cannot edit admin roles or hand out management rights', async () => {
  const board = federationFixture({
    isOwner: false,
    viewerRole: 'co-owner',
    canManage: true,
    roles: federationFixture().roles.concat([
      { id: 'booker', name: 'Booker', description: 'Runs the cards', admin: true, builtIn: false },
      { id: 'referee', name: 'Referee', description: '', admin: false, builtIn: false }
    ])
  });

  const client = startClient({ username: 'co', mine: { ok: true, federation: board } });
  try {
    client.window.MCFFederations.openManage();
    await sleep(20);
    client.document.querySelector('[data-fed-tab="roles"]').click();

    const panel = client.document.querySelector('#mcfFedManagePanel');
    assert.equal(panel.querySelector('[data-fed-role-edit="booker"]'), null, 'an admin role is the owner’s');
    assert.equal(panel.querySelector('[data-fed-role-delete="booker"]'), null);
    assert.ok(panel.querySelector('[data-fed-role-edit="referee"]'), 'a plain role is fair game');

    const editor = panel.querySelector('#mcfFedRoleEditor');
    assert.equal(editor.querySelector('[data-fed-role-admin]'), null, 'no management checkbox');
    assert.match(editor.textContent, /Only the owner can give a role management rights/);
  } finally {
    client.dom.window.close();
  }
});

/* ---------------------------------------------------------------
   The Join popup — a roster of federations
--------------------------------------------------------------- */

function joinList() {
  return {
    ok: true,
    membership: null,
    federations: [
      {
        id: 'fed1',
        name: 'Iron Ring Federation',
        description: 'A heavyweight promotion for men who like their matches long.',
        imageUrl: 'https://cdn.example/iron.png',
        owner: 'boss',
        memberCount: 12,
        createdAt: null
      },
      {
        id: 'fed2',
        name: 'Steel Cage Club',
        description: 'Cages, ladders and nothing soft.',
        imageUrl: '',
        owner: 'axe',
        memberCount: 1,
        createdAt: null
      }
    ]
  };
}

test('Join opens a popup with every federation — image, name, description, Join', async () => {
  const client = startClient({ mine: joinList() });
  try {
    client.window.MCFFederations.openJoin();
    await sleep(20);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.equal(client.document.querySelector('.mcf-modal-title').textContent, 'Join a federation');

    const rows = body.querySelectorAll('.mcf-fed-join-row');
    assert.equal(rows.length, 2, 'one row per federation');

    const first = rows[0];
    assert.ok(first.querySelector('.mcf-fed-roster-thumb'), 'the image sits in a roster-style thumb');
    assert.equal(first.querySelector('.mcf-fed-roster-thumb').getAttribute('src'), 'https://cdn.example/iron.png');
    assert.equal(first.querySelector('.mcf-fed-roster-name').textContent, 'Iron Ring Federation');
    assert.match(first.querySelector('.mcf-fed-roster-meta').textContent, /@boss · 12 members/);
    assert.match(first.querySelector('.mcf-fed-roster-desc').textContent, /heavyweight promotion/);
    assert.equal(first.querySelector('[data-join="fed1"]').textContent, 'Join');

    // No image: the initials stand in, exactly like an empty roster avatar.
    const second = rows[1];
    assert.equal(second.querySelector('.mcf-fed-roster-thumb').textContent, 'ST');
    assert.match(second.querySelector('.mcf-fed-roster-meta').textContent, /1 member$/);
    assert.ok(second.querySelector('[data-join="fed2"]'));
  } finally {
    client.dom.window.close();
  }
});

test('pressing Join sends the owner a request instead of joining outright', async () => {
  const list = joinList();
  const client = startClient({
    mine: list,
    create: (body, url) => {
      assert.equal(url, '/api/federations/fed1/join');
      return { ok: true, requested: true, owner: 'boss', name: 'Iron Ring Federation' };
    }
  });

  try {
    client.window.MCFFederations.openJoin();
    await sleep(20);

    client.document.querySelector('[data-join="fed1"]').click();
    await sleep(20);

    const post = client.calls.find(call => call.method === 'POST');
    assert.ok(post, 'the request was posted');
    assert.equal(post.url, '/api/federations/fed1/join');

    // Nothing is joined yet: the list closes and no membership is cached.
    await sleep(250);
    const titles = Array.from(client.document.querySelectorAll('.mcf-modal-title'))
      .map(title => title.textContent);
    assert.ok(!titles.includes('Join a federation'), 'the join list closed');
    assert.ok(!titles.includes('Iron Ring Federation'), 'no federation card — not a member yet');
  } finally {
    client.dom.window.close();
  }
});

test('a federation already asked about is tagged Requested, not Join', async () => {
  const list = joinList();
  list.federations[0].requested = true;

  const client = startClient({ mine: list });
  try {
    client.window.MCFFederations.openJoin();
    await sleep(20);

    const rows = client.document.querySelectorAll('.mcf-fed-join-row');
    assert.equal(rows[0].querySelector('[data-join="fed1"]'), null, 'no button once asked');
    assert.match(rows[0].textContent, /Requested/);
    assert.ok(rows[1].querySelector('[data-join="fed2"]'), 'other federations still joinable');
  } finally {
    client.dom.window.close();
  }
});

test('already in a federation: a notice, no second join, and Yours on your own', async () => {
  const list = joinList();
  list.membership = { id: 'fed1', name: 'Iron Ring Federation', role: 'owner' };

  const client = startClient({
    mine: list,
    username: 'boss'
  });

  try {
    client.window.MCFFederations.openJoin();
    await sleep(20);

    const body = client.document.querySelector('.mcf-modal-body');
    const notice = body.querySelector('.mcf-fed-notice');
    assert.ok(notice, 'the explanation is shown');
    assert.match(notice.textContent, /already in Iron Ring Federation/);

    const rows = body.querySelectorAll('.mcf-fed-join-row');
    assert.ok(rows[0].querySelector('.mcf-fed-tag'), 'your own federation is tagged');
    assert.equal(rows[0].querySelector('[data-join]'), null, 'no Join button on your own row');

    const other = rows[1].querySelector('[data-join="fed2"]');
    assert.ok(other, 'the other federation still has a Join button');
    assert.equal(other.disabled, true, 'but it cannot be pressed while you are in one');
  } finally {
    client.dom.window.close();
  }
});

test('an empty join list points the member at Create', async () => {
  const client = startClient({
    mine: { ok: true, membership: null, federations: [] }
  });
  try {
    client.window.MCFFederations.openJoin();
    await sleep(20);

    const body = client.document.querySelector('.mcf-modal-body');
    assert.match(body.textContent, /No federations have been registered yet/);
    const create = body.querySelector('#mcfFedJoinCreate');
    assert.ok(create, 'Create is offered');

    create.click();
    await sleep(300);
    const titles = Array.from(client.document.querySelectorAll('.mcf-modal-title'))
      .map(title => title.textContent);
    assert.ok(titles.includes('Register a federation'), 'the join list hands over to Create');
    assert.ok(!titles.includes('Join a federation'), 'and the join list closes');
  } finally {
    client.dom.window.close();
  }
});


test('Manage lists join requests and approves one', async () => {
  const waiting = federationFixture({
    requests: [
      { username: 'hopeful', display: 'Hopeful', requestedAt: new Date(Date.now() - 3600 * 1000).toISOString() }
    ]
  });
  const approved = federationFixture({
    requests: [],
    members: federationFixture().members.concat([
      { username: 'hopeful', display: 'Hopeful', roleId: 'member', online: false, lastSeenAt: null }
    ]),
    memberCount: 3
  });

  const client = startClient({
    mine: { ok: true, federation: waiting },
    create: (body, url) => {
      assert.equal(url, '/api/federations/fed1/requests/hopeful/approve');
      return { ok: true, approved: 'hopeful', federation: approved };
    }
  });

  try {
    client.window.MCFFederations.openManage();
    await sleep(20);

    const panel = client.document.querySelector('#mcfFedManagePanel');
    assert.match(panel.textContent, /Join requests/);
    const row = panel.querySelector('.mcf-fed-request-row');
    assert.ok(row, 'the request has its own row');
    assert.match(row.textContent, /@hopeful/);
    assert.match(row.textContent, /asked 1h ago/);

    row.querySelector('[data-fed-approve="hopeful"]').click();
    await sleep(20);

    const post = client.calls.find(call => call.method === 'POST');
    assert.equal(post.url, '/api/federations/fed1/requests/hopeful/approve');

    const after = client.document.querySelector('#mcfFedManagePanel');
    assert.doesNotMatch(after.textContent, /Join requests/, 'the request block is gone');
    assert.match(after.textContent, /@hopeful/, 'and they are on the roster now');
    assert.equal(after.querySelectorAll('.mcf-fed-manage-row').length, 3);
  } finally {
    client.dom.window.close();
  }
});

test('Manage can reject a join request', async () => {
  const waiting = federationFixture({
    requests: [
      { username: 'hopeful', display: 'Hopeful', requestedAt: new Date().toISOString() }
    ]
  });
  const rejected = federationFixture({ requests: [] });

  const client = startClient({
    mine: { ok: true, federation: waiting },
    create: (body, url) => {
      assert.equal(url, '/api/federations/fed1/requests/hopeful/reject');
      return { ok: true, rejected: 'hopeful', federation: rejected };
    }
  });

  try {
    client.window.MCFFederations.openManage();
    await sleep(20);

    client.document.querySelector('[data-fed-reject="hopeful"]').click();
    await sleep(20);

    const post = client.calls.find(call => call.method === 'POST');
    assert.equal(post.url, '/api/federations/fed1/requests/hopeful/reject');

    const panel = client.document.querySelector('#mcfFedManagePanel');
    assert.doesNotMatch(panel.textContent, /Join requests/);
    assert.doesNotMatch(panel.textContent, /@hopeful/, 'they were never added');
    assert.equal(panel.querySelectorAll('.mcf-fed-manage-row').length, 2);
  } finally {
    client.dom.window.close();
  }
});

/* ---------------------------------------------------------------
   The federation chatroom — a movable window with online members
--------------------------------------------------------------- */

function chatroomClient(extraMine) {
  const messages = [
    { from: 'boss', display: 'Boss', text: 'Locker room talk.', at: '2026-01-01T10:00:00Z' },
    { from: 'rookie', display: 'Rookie', text: 'On my way.', at: '2026-01-01T10:01:00Z' }
  ];
  return startClient({
    mine: url => {
      if (url.indexOf('/presence') !== -1) {
        return {
          ok: true,
          total: 4,
          online: [
            { username: 'boss', display: 'Boss' },
            { username: 'rookie', display: 'Rookie' },
            { username: 'outsider', display: 'Outsider' }
          ].filter(person => person.username !== 'outsider')
        };
      }
      if (url.indexOf('/messages') !== -1) {
        return { ok: true, messages };
      }
      return Object.assign({ ok: true, federation: federationFixture() }, extraMine || {});
    }
  });
}

test('the Chatroom button opens a movable floating window, not a modal', async () => {
  const client = chatroomClient();
  try {
    client.window.MCFFederations.openChatroom();
    await sleep(30);

    const win = client.document.querySelector('.mcf-fed-chat-window');
    assert.ok(win, 'the floating chatroom opened');
    assert.equal(client.document.querySelectorAll('.mcf-modal').length, 0, 'it is not a modal');
    assert.match(win.textContent, /Iron Ring Federation/);
    assert.match(win.textContent, /Locker room talk\./);
    assert.match(win.textContent, /On my way\./);

    // Only the federation's online members are listed, never the outsider.
    const people = win.querySelectorAll('.mcf-fed-chat-member');
    assert.deepEqual(
      Array.from(people).map(row => row.querySelector('.mcf-fed-chat-member-name').textContent.trim()),
      ['Boss you', 'Rookie'],
      'the signed-in member is marked as themselves'
    );
    assert.equal(win.querySelector('#mcfFedChatOnlineCount').textContent, '2');

    // Asking again brings the same window forward instead of stacking one.
    client.window.MCFFederations.openChatroom();
    await sleep(30);
    assert.equal(client.document.querySelectorAll('.mcf-fed-chat-window').length, 1);

    // The close button takes it away.
    win.querySelector('[data-fed-chat-close]').click();
    assert.equal(client.document.querySelectorAll('.mcf-fed-chat-window').length, 0);
  } finally {
    client.dom.window.close();
  }
});

test('the chatroom window can be dragged by its header', async () => {
  const client = chatroomClient();
  try {
    client.window.MCFFederations.openChatroom();
    await sleep(30);

    const win = client.document.querySelector('.mcf-fed-chat-window');
    const head = win.querySelector('[data-fed-chat-drag]');
    const mouse = (type, x, y) => new client.window.MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y
    });

    head.dispatchEvent(mouse('mousedown', 100, 100));
    client.document.dispatchEvent(mouse('mousemove', 160, 140));
    client.document.dispatchEvent(mouse('mouseup', 160, 140));

    assert.equal(win.style.left, '60px');
    assert.equal(win.style.top, '40px');

    // It stays where it was put.
    client.document.dispatchEvent(mouse('mousemove', 300, 300));
    assert.equal(win.style.left, '60px');

    win.querySelector('[data-fed-chat-close]').click();
  } finally {
    client.dom.window.close();
  }
});

test('a message typed into the floating chatroom is posted', async () => {
  const posted = [
    { from: 'boss', display: 'Boss', text: 'Locker room talk.', at: '2026-01-01T10:00:00Z' },
    { from: 'boss', display: 'Boss', text: 'Doors at eight.', at: '2026-01-01T10:02:00Z' }
  ];

  const client = startClient({
    mine: url => {
      if (url.indexOf('/presence') !== -1) {
        return { ok: true, total: 1, online: [{ username: 'boss', display: 'Boss' }] };
      }
      if (url.indexOf('/messages') !== -1) {
        return { ok: true, messages: posted.slice(0, 1) };
      }
      return { ok: true, federation: federationFixture() };
    },
    create: (body, url) => {
      assert.equal(url, '/api/federations/fed1/messages');
      assert.equal(body.text, 'Doors at eight.');
      return { ok: true, messages: posted };
    }
  });

  try {
    client.window.MCFFederations.openChatroom();
    await sleep(30);

    const win = client.document.querySelector('.mcf-fed-chat-window');
    const input = win.querySelector('#mcfFedChatInput');
    input.value = 'Doors at eight.';
    input.dispatchEvent(new client.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(30);

    const post = client.calls.find(call => call.method === 'POST');
    assert.ok(post, 'the message was posted');
    assert.match(win.textContent, /Doors at eight\./);
    assert.equal(input.value, '');

    win.querySelector('[data-fed-chat-close]').click();
  } finally {
    client.dom.window.close();
  }
});
