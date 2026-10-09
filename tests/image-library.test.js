const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

const noRevalidate = require('../noRevalidate');
const {
  IMAGE_CATEGORIES,
  MAX_IMAGE_SIZE,
  MAX_CAPTION_LENGTH,
  cleanCaption,
  detectRasterImageType,
  validateRasterUpload,
  createImageLibraryRouter
} = require('../imageLibrary');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

class FakeQuery {
  constructor(rows, single = false) {
    this.rows = rows;
    this.single = single;
  }

  sort(spec) {
    const fields = Object.entries(spec);
    this.rows = this.rows.slice().sort((a, b) => {
      for (const [field, direction] of fields) {
        const left = field === '_id' ? String(a[field]) : a[field];
        const right = field === '_id' ? String(b[field]) : b[field];
        if (left === right) continue;
        const order = left > right ? 1 : -1;
        return order * direction;
      }
      return 0;
    });
    return this;
  }

  skip(count) {
    this.rows = this.rows.slice(count);
    return this;
  }

  limit(count) {
    this.rows = this.rows.slice(0, count);
    return this;
  }

  lean() {
    const copy = value => value ? { ...value, createdAt: new Date(value.createdAt) } : null;
    return Promise.resolve(this.single ? copy(this.rows[0]) : this.rows.map(copy));
  }
}

function makeGalleryModel() {
  const documents = [];
  let sequence = 0;
  return {
    async create(fields) {
      sequence += 1;
      const document = {
        _id: sequence.toString(16).padStart(24, '0'),
        ...fields,
        createdAt: new Date(fields.createdAt || Date.now())
      };
      documents.push(document);
      return document;
    },
    find(filter = {}) {
      return new FakeQuery(documents.filter(doc => !filter.category || doc.category === filter.category));
    },
    findById(id) {
      return new FakeQuery(documents.filter(doc => String(doc._id) === String(id)), true);
    },
    async deleteOne(filter = {}) {
      const index = documents.findIndex(doc => String(doc._id) === String(filter._id));
      if (index < 0) return { deletedCount: 0 };
      documents.splice(index, 1);
      return { deletedCount: 1 };
    },
    _all() { return documents.slice(); }
  };
}

async function startApi() {
  const ImageLibraryImage = makeGalleryModel();
  let hostedCount = 0;
  const app = express();

  function requireUser(req, res, next) {
    const username = req.get('x-member');
    if (!username) return res.status(401).json({ ok: false, error: 'auth_required' });
    req.username = username;
    req.user = { username, role: req.get('x-role') || 'user', banned: false };
    next();
  }

  app.use('/api/image-library', createImageLibraryRouter({
    ImageLibraryImage,
    requireUser,
    uploadImageToImgBB: async file => {
      assert.ok(Buffer.isBuffer(file.buffer));
      assert.match(file.mimetype, /^image\/(png|jpeg|gif|webp)$/);
      hostedCount += 1;
      return { imageUrl: `https://i.ibb.co/gallery/image-${hostedCount}.png` };
    },
    writeLimiter: (_req, _res, next) => next(),
    noRevalidate
  }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.member) headers['x-member'] = options.member;
    if (options.role) headers['x-role'] = options.role;

    const init = { method: options.method || 'GET', headers };
    if (options.form) {
      init.body = options.form;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(base + url, init);
    return { status: response.status, headers: response.headers, json: await response.json() };
  }

  async function addImage(overrides = {}) {
    const form = new FormData();
    form.append('image', new Blob([overrides.bytes || PNG], { type: overrides.mime || 'image/png' }), 'upload.png');
    form.append('category', overrides.category || 'fighter-photos');
    form.append('caption', overrides.caption || '');
    return call('/api/image-library', {
      method: 'POST',
      member: overrides.member || 'alice',
      role: overrides.role,
      form
    });
  }

  return {
    call,
    addImage,
    model: ImageLibraryImage,
    async close() {
      await new Promise(resolve => server.close(resolve));
    }
  };
}

test('the category catalogue is stable and captions are normalized safely', () => {
  assert.deepEqual(IMAGE_CATEGORIES.map(category => category.id), [
    'fighter-photos', 'gear-attire', 'artwork', 'match-moments', 'events', 'other'
  ]);
  assert.equal(cleanCaption('  Corner\n  lights\tshine  '), 'Corner lights shine');
  assert.equal(cleanCaption(null), '');
  assert.equal(MAX_CAPTION_LENGTH, 240);
});

test('raster upload validation checks signatures and rejects active or mislabeled files', () => {
  assert.equal(detectRasterImageType(PNG), 'image/png');
  assert.deepEqual(validateRasterUpload({ buffer: PNG, size: PNG.length, mimetype: 'image/png' }), {
    ok: true,
    mimetype: 'image/png'
  });
  assert.equal(validateRasterUpload({ buffer: PNG, size: PNG.length, mimetype: 'application/octet-stream' }).ok, true);
  assert.equal(validateRasterUpload({ buffer: Buffer.from('<svg></svg>'), size: 11, mimetype: 'image/svg+xml' }).error, 'invalid_file_type');
  assert.equal(validateRasterUpload({ buffer: PNG, size: PNG.length, mimetype: 'image/jpeg' }).error, 'invalid_file_type');
  assert.equal(validateRasterUpload({ buffer: PNG, size: MAX_IMAGE_SIZE + 1, mimetype: 'image/png' }).error, 'file_too_large');
});

test('browsing requires a member session and returns categories with uncached results', async () => {
  const api = await startApi();
  try {
    const anonymous = await api.call('/api/image-library');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error, 'auth_required');

    const member = await api.call('/api/image-library', { member: 'alice' });
    assert.equal(member.status, 200);
    assert.equal(member.headers.get('cache-control').includes('no-store'), true);
    assert.deepEqual(member.json.categories.map(category => category.id), IMAGE_CATEGORIES.map(category => category.id));
    assert.deepEqual(member.json.images, []);
    assert.equal(member.json.hasMore, false);
  } finally {
    await api.close();
  }
});

test('members upload a verified image into a category with server-owned attribution', async () => {
  const api = await startApi();
  try {
    const form = new FormData();
    form.append('image', new Blob([PNG], { type: 'image/png' }), 'fighter.png');
    form.append('category', 'artwork');
    form.append('caption', '  A   great\nposter  ');
    form.append('uploadedBy', 'someone-else');

    const response = await api.call('/api/image-library', { method: 'POST', member: 'alice', form });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    assert.equal(response.json.ok, true);
    assert.equal(response.json.image.category, 'artwork');
    assert.equal(response.json.image.caption, 'A great poster');
    assert.equal(response.json.image.uploadedBy, 'alice');
    assert.equal(response.json.image.canDelete, true);
    assert.equal(response.json.image.imageUrl, 'https://i.ibb.co/gallery/image-1.png');
    assert.equal(api.model._all().length, 1);
  } finally {
    await api.close();
  }
});

test('invalid categories and unsupported file contents are rejected before hosting', async () => {
  const api = await startApi();
  try {
    const invalidCategory = await api.addImage({ category: 'not-a-category' });
    assert.equal(invalidCategory.status, 400);
    assert.equal(invalidCategory.json.error, 'invalid_category');

    const invalidImage = await api.addImage({ bytes: Buffer.from('<svg><script>alert(1)</script></svg>'), mime: 'image/svg+xml' });
    assert.equal(invalidImage.status, 400);
    assert.equal(invalidImage.json.error, 'invalid_file_type');
    assert.equal(api.model._all().length, 0);
  } finally {
    await api.close();
  }
});

test('category filters and bounded page sizes paginate newest entries', async () => {
  const api = await startApi();
  try {
    await api.addImage({ category: 'fighter-photos', caption: 'one' });
    await api.addImage({ category: 'artwork', caption: 'two' });
    await api.addImage({ category: 'fighter-photos', caption: 'three' });

    const firstPage = await api.call('/api/image-library?category=fighter-photos&page=1&limit=1', { member: 'alice' });
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.json.images.length, 1);
    assert.equal(firstPage.json.images[0].caption, 'three');
    assert.equal(firstPage.json.hasMore, true);
    assert.equal(firstPage.json.limit, 1);

    const secondPage = await api.call('/api/image-library?category=fighter-photos&page=2&limit=1', { member: 'alice' });
    assert.equal(secondPage.json.images.length, 1);
    assert.equal(secondPage.json.images[0].caption, 'one');
    assert.equal(secondPage.json.hasMore, false);

    const all = await api.call('/api/image-library?category=all&limit=500', { member: 'alice' });
    assert.equal(all.json.images.length, 3);
    assert.equal(all.json.limit, 48, 'the server caps the requested page size');

    const invalid = await api.call('/api/image-library?category=made-up', { member: 'alice' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error, 'invalid_category');
  } finally {
    await api.close();
  }
});

test('only an image owner or staff member can remove a library entry', async () => {
  const api = await startApi();
  try {
    const first = await api.addImage({ member: 'alice', category: 'events' });
    const second = await api.addImage({ member: 'bob', category: 'events' });
    const id = first.json.image._id;

    const aliceView = await api.call('/api/image-library?category=events', { member: 'alice' });
    assert.deepEqual(aliceView.json.images.map(image => image.canDelete), [false, true]);

    const blocked = await api.call(`/api/image-library/${second.json.image._id}`, { method: 'DELETE', member: 'alice' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error, 'not_owner');

    const removed = await api.call(`/api/image-library/${id}`, { method: 'DELETE', member: 'alice' });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.ok, true);

    const staffRemoval = await api.call(`/api/image-library/${second.json.image._id}`, {
      method: 'DELETE',
      member: 'mod',
      role: 'moderator'
    });
    assert.equal(staffRemoval.status, 200);
    assert.equal(api.model._all().length, 0);

    const badId = await api.call('/api/image-library/not-an-id', { method: 'DELETE', member: 'alice' });
    assert.equal(badId.status, 400);
    assert.equal(badId.json.error, 'invalid_id');
  } finally {
    await api.close();
  }
});

test('the standalone page is wired to its assets and is linked from the app menus', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'image-library.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'public', 'js', 'image-library.js'), 'utf8');
  const desktop = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const mobile = fs.readFileSync(path.join(root, 'public', 'mobile.html'), 'utf8');

  assert.match(client, /\/api\/image-library/);
  assert.match(html, /\/js\/image-library\.js/);
  assert.match(html, /\/css\/image-library\.css/);
  assert.equal((desktop.match(/href="\/image-library\.html"/g) || []).length, 2);
  assert.match(mobile, /href="\/image-library\.html"/);
});
