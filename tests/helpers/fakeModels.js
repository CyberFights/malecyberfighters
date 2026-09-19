/**
 * A very small in-memory stand-in for the Mongoose models the story routes
 * touch, with just enough of the query surface to exercise them: equality,
 * $or / $and, $ne, $gte / $lte, regular expressions, sort / skip / limit,
 * lean and save. Anything beyond that throws, so a test can never silently
 * pass because a query was ignored.
 */

let nextId = 0;

/** A 24-hex id, the shape mongoose.isValidObjectId accepts. */
function makeId() {
  nextId += 1;
  return nextId.toString(16).padStart(24, '0');
}

const isPlainObject = value =>
  value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp);

function matches(doc, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(clause => matches(doc, clause));
    if (key === '$and') return expected.every(clause => matches(doc, clause));

    const actual = key in doc ? doc[key] : key.split('.').reduce((node, part) =>
      (node && typeof node === 'object') ? node[part] : undefined, doc);

    if (expected instanceof RegExp) return expected.test(String(actual == null ? '' : actual));

    if (isPlainObject(expected)) {
      // A field can carry several operators at once (the story window is
      // { $gte, $lte }), so every one of them has to hold.
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === '$ne') return String(actual) !== String(operand);
        if (operator === '$in') return operand.some(value => String(actual) === String(value));
        if (operator === '$gte') return actual != null && new Date(actual) >= new Date(operand);
        if (operator === '$lte') return actual != null && new Date(actual) <= new Date(operand);
        throw new Error(`fakeModels: unsupported query operator "${operator}" on "${key}"`);
      });
    }

    return String(actual) === String(expected);
  });
}

/** Read a (possibly dotted) path off a document, the way matches() does. */
function readPath(doc, path) {
  return path.split('.').reduce((node, part) =>
    (node && typeof node === 'object') ? node[part] : undefined, doc);
}

function sortDocs(docs, spec) {
  const [field, direction] = Object.entries(spec)[0];
  return docs.slice().sort((a, b) => {
    const left = readPath(a, field) == null ? 0 : readPath(a, field);
    const right = readPath(b, field) == null ? 0 : readPath(b, field);
    if (left === right) return 0;
    return (left > right ? 1 : -1) * (direction < 0 ? -1 : 1);
  });
}

/** Thenable query: await it directly, or chain .lean() on the end. */
class Query {
  constructor(docs, single = false) {
    this.docs = docs;
    this.single = single;
  }

  sort(spec) { this.docs = sortDocs(this.docs, spec); return this; }
  skip(n) { this.docs = this.docs.slice(n); return this; }
  limit(n) { this.docs = this.docs.slice(0, n); return this; }
  select() { return this; }

  lean() {
    const value = this.single ? this.docs[0] || null : this.docs;
    return Promise.resolve(value ? JSON.parse(JSON.stringify(value)) : value);
  }

  then(resolve, reject) {
    const value = this.single ? this.docs[0] || null : this.docs;
    return Promise.resolve(value).then(resolve, reject);
  }
}

class Collection {
  constructor(name) {
    this.name = name;
    this.docs = [];
  }

  _doc(fields) {
    const doc = { _id: makeId(), ...fields };
    Object.defineProperty(doc, 'save', {
      enumerable: false,
      value: async () => {
        const index = this.docs.findIndex(d => String(d._id) === String(doc._id));
        if (index >= 0) this.docs[index] = doc;
        else this.docs.push(doc);
        return doc;
      }
    });
    return doc;
  }

  async create(fields) {
    const doc = this._doc(fields);
    this.docs.push(doc);
    return doc;
  }

  find(query = {}) {
    return new Query(this.docs.filter(doc => matches(doc, query)));
  }

  findOne(query = {}) {
    return new Query(this.docs.filter(doc => matches(doc, query)), true);
  }

  findById(id) {
    return new Query(this.docs.filter(doc => String(doc._id) === String(id)), true);
  }

  countDocuments(query = {}) {
    return Promise.resolve(this.docs.filter(doc => matches(doc, query)).length);
  }

  async deleteOne(query) {
    const before = this.docs.length;
    this.docs = this.docs.filter(doc => !matches(doc, query));
    return { deletedCount: before - this.docs.length };
  }

  async updateOne(query, update = {}) {
    const doc = this.docs.find(d => matches(d, query));
    if (!doc) return { matchedCount: 0 };

    const setPath = (path, value) => {
      const parts = path.split('.');
      let node = doc;
      while (parts.length > 1) {
        const part = parts.shift();
        if (!node[part] || typeof node[part] !== 'object') node[part] = {};
        node = node[part];
      }
      node[parts[0]] = value;
    };

    if (update.$set) {
      for (const [path, value] of Object.entries(update.$set)) setPath(path, value);
    }
    if (update.$inc) {
      // $inc over a dotted path needs the current value, so read through the
      // same walker matches() uses.
      for (const [path, amount] of Object.entries(update.$inc)) {
        const current = Number(path.split('.').reduce((node, part) =>
          (node && typeof node === 'object') ? node[part] : undefined, doc)) || 0;
        setPath(path, current + Number(amount));
      }
    }
    if (update.$push) {
      for (const [path, value] of Object.entries(update.$push)) {
        const current = path.split('.').reduce((node, part) =>
          (node && typeof node === 'object') ? node[part] : undefined, doc);
        if (!Array.isArray(current)) setPath(path, [value]);
        else current.push(value);
      }
    }
    return { matchedCount: 1 };
  }

  all() {
    return this.docs.slice();
  }
}

/** Story / User / DM collections plus the calls the routes make on each. */
function makeModels() {
  const stories = new Collection('stories');
  const users = new Collection('users');
  const dms = new Collection('dms');

  const Story = {
    create: fields => stories.create(fields),
    find: query => stories.find(query),
    findOne: query => stories.findOne(query),
    findById: id => stories.findById(id),
    countDocuments: query => stories.countDocuments(query),
    deleteOne: query => stories.deleteOne(query),
    _all: () => stories.all()
  };

  const User = {
    findOne: query => users.findOne(query),
    find: query => users.find(query),
    updateOne: (query, update) => users.updateOne(query, update),
    countDocuments: query => users.countDocuments(query),
    _all: () => users.all(),
    _add: fields => users.create(fields)
  };

  const DM = {
    create: fields => dms.create(fields),
    find: query => dms.find(query),
    _all: () => dms.all()
  };

  return { Story, User, DM, stories, users, dms, makeId };
}

module.exports = { makeModels, makeId, matches };
