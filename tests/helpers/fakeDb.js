/**
 * In-memory stand-in for the two Mongoose models the DM path touches.
 *
 * Only the calls the DM code actually makes are implemented — findOne /
 * updateOne on User, create / aggregate on DM — so a test can exercise the
 * shipped delivery and unread logic without a MongoDB instance.
 */

const matches = (doc, query) => Object.keys(query).every(key => {
  const expected = query[key];
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
    if ('$ne' in expected) return doc[key] !== expected.$ne;
    if ('$gt' in expected) return doc[key] > expected.$gt;
    throw new Error(`fakeDb: unsupported query operator ${Object.keys(expected)[0]}`);
  }
  return doc[key] === expected;
});

const applyUpdate = (doc, update) => {
  if (!update.$set) throw new Error('fakeDb: only $set updates are supported');
  Object.assign(doc, update.$set);
};

/** The aggregation stages used by getUnreadDMCounts, in pipeline order. */
const runPipeline = (docs, pipeline) => {
  let rows = docs.slice();

  pipeline.forEach(stage => {
    const [operator] = Object.keys(stage);

    if (operator === '$match') {
      rows = rows.filter(doc => matches(doc, stage.$match));
      return;
    }

    if (operator === '$sort') {
      const [field, direction] = Object.entries(stage.$sort)[0];
      rows = rows.slice().sort((a, b) => (a[field] > b[field] ? direction : -direction));
      return;
    }

    if (operator === '$group') {
      const { _id, ...accumulators } = stage.$group;
      const groupField = _id.replace(/^\$/, '');
      const groups = new Map();

      rows.forEach(doc => {
        const key = doc[groupField];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(doc);
      });

      rows = [...groups.entries()].map(([key, groupDocs]) => {
        const row = { _id: key };
        Object.entries(accumulators).forEach(([name, spec]) => {
          const [op, field] = Object.entries(spec)[0];
          const values = groupDocs.map(doc => doc[String(field).replace(/^\$/, '')]);
          if (op === '$push') row[name] = values;
          else if (op === '$sum') row[name] = values.length;
          else if (op === '$max') row[name] = values.reduce((a, b) => (a > b ? a : b));
          else throw new Error(`fakeDb: unsupported accumulator ${op}`);
        });
        return row;
      });
      return;
    }

    throw new Error(`fakeDb: unsupported pipeline stage ${operator}`);
  });

  return rows;
};

const makeDb = () => {
  const users = new Map();
  const dms = [];
  let nextId = 1;

  const findUser = query => {
    if (query.username) return users.get(query.username) || null;
    if (query.discordId) return [...users.values()].find(u => u.discordId === query.discordId) || null;
    throw new Error(`fakeDb: unsupported User query ${JSON.stringify(query)}`);
  };

  const User = {
    findOne(query) {
      const lean = async () => {
        const doc = findUser(query);
        return doc ? { ...doc } : null;
      };
      return { lean, select: () => ({ lean }) };
    },
    async updateOne(query, update) {
      const doc = findUser(query);
      if (!doc) return { acknowledged: true, modifiedCount: 0 };
      applyUpdate(doc, update);
      return { acknowledged: true, modifiedCount: 1 };
    }
  };

  const DM = {
    async create(doc) {
      const saved = { _id: `dm${nextId++}`, type: 'normal', time: new Date(), ...doc };
      dms.push(saved);
      return { ...saved };
    },
    async aggregate(pipeline) {
      return runPipeline(dms, pipeline);
    }
  };

  return {
    User,
    DM,
    users,
    dms,
    addUser(doc) {
      const user = { blockedUsers: [], dmSeen: {}, socketId: null, language: 'en', ...doc };
      users.set(user.username, user);
      return user;
    },
    addDM(from, to, text, time = new Date()) {
      const saved = { _id: `dm${nextId++}`, from, to, text, originalText: text, type: 'normal', time };
      dms.push(saved);
      return saved;
    }
  };
};

module.exports = { makeDb };
