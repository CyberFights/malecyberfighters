/**
 * Tests for the retention sweep (retention.js).
 *
 * The job is injected with models, a clock and a connection probe, so these
 * exercise the actual pruning rules — which collection, which timestamp field,
 * how far back, how many at a time — without a database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRetentionJob,
  configFromEnv,
  daysFromEnv,
  DEFAULTS,
  DAY_MS
} = require('../retention');

/**
 * A stand-in for a mongoose model over an in-memory array. Records the queries
 * it was asked to run so a test can assert on the shape of the prune, not just
 * on how many documents disappeared.
 */
function fakeModel(rows = []) {
  const calls = { find: [], deleteMany: [] };

  return {
    calls,
    rows,
    find(filter) {
      calls.find.push(filter);
      const field = Object.keys(filter)[0];
      const cutoff = filter[field] && filter[field].$lt;
      let matched = rows.filter(row => (cutoff ? row[field] < cutoff : true));

      const query = {
        _limit: null,
        limit(n) { this._limit = n; return this; },
        select() { return this; },
        async lean() {
          if (this._limit) matched = matched.slice(0, this._limit);
          return matched.map(row => ({ _id: row._id }));
        }
      };
      // The real chain is find(...).select(...).limit(...).lean(); allow the
      // select-first order too so the stub is not order-sensitive.
      query.select = function () { return this; };
      return query;
    },
    async deleteMany(filter) {
      calls.deleteMany.push(filter);
      const ids = new Set((filter._id && filter._id.$in) || []);
      const before = rows.length;
      if (ids.size) {
        // A batch delete removes exactly the ids it was handed.
        for (let i = rows.length - 1; i >= 0; i--) {
          if (ids.has(rows[i]._id)) rows.splice(i, 1);
        }
      } else if (filter.$or) {
        // PasswordReset: expired, or used and past the grace period.
        for (let i = rows.length - 1; i >= 0; i--) {
          const row = rows[i];
          const expired = filter.$or[0].expiresAt.$lt;
          const usedOld = filter.$or[1];
          if (row.expiresAt < expired || (row.used && row.createdAt < usedOld.createdAt.$lt)) {
            rows.splice(i, 1);
          }
        }
      }
      return { deletedCount: before - rows.length };
    }
  };
}

const daysAgo = (now, days) => new Date(now.getTime() - days * DAY_MS);

/** 200-day-old and 1-day-old rows, so a 180-day window has something to cut. */
function transcript(now, count = 1) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({ _id: `old-${i}`, time: daysAgo(now, 200) });
    rows.push({ _id: `new-${i}`, time: daysAgo(now, 1) });
  }
  return rows;
}

test('the documented defaults are what an unconfigured deploy gets', () => {
  const config = configFromEnv({});
  assert.equal(config.publicMessageDays, 180);
  assert.equal(config.roomMessageDays, 180);
  assert.equal(config.ipLogDays, 30);
  assert.equal(config.passwordResetDays, 1);
  // Member content is opt-in: nothing deletes DMs unless an operator says so.
  assert.equal(config.dmDays, 0);
  assert.equal(config.intervalHours, DEFAULTS.intervalHours);
});

test('a window can be set per collection from the environment', () => {
  const config = configFromEnv({
    RETENTION_PUBLIC_DAYS: '30',
    RETENTION_ROOM_DAYS: '60',
    RETENTION_IP_DAYS: '7',
    RETENTION_RESET_DAYS: '0',
    RETENTION_DM_DAYS: '365',
    RETENTION_INTERVAL_HOURS: '1',
    RETENTION_BATCH: '250'
  });
  assert.equal(config.publicMessageDays, 30);
  assert.equal(config.roomMessageDays, 60);
  assert.equal(config.ipLogDays, 7);
  assert.equal(config.passwordResetDays, 0);
  assert.equal(config.dmDays, 365);
  assert.equal(config.intervalHours, 1);
  assert.equal(config.batchSize, 250);
});

test('an absurd batch size is capped', () => {
  // A typo like RETENTION_BATCH=1000000 would put us back to one giant write.
  assert.equal(configFromEnv({ RETENTION_BATCH: '1000000' }).batchSize, 10000);
  assert.equal(configFromEnv({ RETENTION_BATCH: 'no' }).batchSize, DEFAULTS.batchSize);
});

test('nonsense in the environment falls back rather than deleting everything', () => {
  // A typo must never turn into "prune from the epoch".
  assert.equal(daysFromEnv('soon', 180), 180);
  assert.equal(daysFromEnv('-5', 180), 180);
  assert.equal(daysFromEnv('', 180), 180);
  assert.equal(daysFromEnv(undefined, 180), 180);
  assert.equal(daysFromEnv('45', 180), 45);
  // An explicit zero is a real instruction: never prune.
  assert.equal(daysFromEnv('0', 180), 0);

  const config = configFromEnv({ RETENTION_PUBLIC_DAYS: 'everything' });
  assert.equal(config.publicMessageDays, DEFAULTS.publicMessageDays);
});

test('a sweep drops messages older than the window and keeps the rest', async () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const publicMessages = fakeModel(transcript(now, 3));
  const roomMessages = fakeModel(transcript(now, 2));

  const job = createRetentionJob({
    models: { PublicMessage: publicMessages, RoomMessage: roomMessages },
    now: () => now
  });

  const report = await job.runOnce();

  assert.equal(report.publicMessages, 3);
  assert.equal(report.roomMessages, 2);
  // Everything newer than the window is still there.
  assert.deepEqual(publicMessages.rows.map(r => r._id), ['new-0', 'new-1', 'new-2']);
  assert.deepEqual(roomMessages.rows.map(r => r._id), ['new-0', 'new-1']);

  // The cutoff is the window measured back from the pinned clock.
  const cutoff = publicMessages.calls.find[0].time.$lt;
  assert.equal(cutoff.toISOString(), daysAgo(now, 180).toISOString());
});

test('the IP log is pruned on createdAt, the field it actually stores', async () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const ipLog = fakeModel([
    { _id: 'ip-old', createdAt: daysAgo(now, 90) },
    { _id: 'ip-recent', createdAt: daysAgo(now, 2) }
  ]);

  const job = createRetentionJob({ models: { IpLog: ipLog }, now: () => now });
  const report = await job.runOnce();

  assert.equal(report.ipLogs, 1);
  assert.deepEqual(ipLog.rows.map(r => r._id), ['ip-recent']);
  // Asking for `time` on this collection would match nothing and quietly keep
  // the most sensitive data on the site forever.
  assert.ok(ipLog.calls.find[0].createdAt, 'pruned by createdAt');
  assert.equal(ipLog.calls.find[0].time, undefined);
  assert.equal(ipLog.calls.find[0].createdAt.$lt.toISOString(), daysAgo(now, 30).toISOString());
});

test('direct messages are left alone unless an operator opts in', async () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const dm = fakeModel([{ _id: 'dm-1', time: daysAgo(now, 900) }]);

  const byDefault = createRetentionJob({ models: { DM: dm }, now: () => now });
  const report = await byDefault.runOnce();

  assert.equal(report.dms, 0);
  assert.equal(dm.calls.find.length, 0, 'never even queried');
  assert.equal(dm.rows.length, 1);

  // The same data, with the opt-in set.
  const optedIn = createRetentionJob({
    models: { DM: dm },
    config: { ...DEFAULTS, dmDays: 365 },
    now: () => now
  });
  const second = await optedIn.runOnce();
  assert.equal(second.dms, 1);
  assert.equal(dm.rows.length, 0);
});

test('a big backlog is deleted in batches, not in one write', async () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({ _id: `m-${i}`, time: daysAgo(now, 400) });
  const publicMessages = fakeModel(rows);

  const job = createRetentionJob({
    models: { PublicMessage: publicMessages },
    config: { ...DEFAULTS, batchSize: 2 },
    now: () => now
  });

  const report = await job.runOnce();

  assert.equal(report.publicMessages, 5);
  assert.equal(publicMessages.rows.length, 0);
  // 5 documents at 2 per batch: three lookups, three deletes.
  assert.equal(publicMessages.calls.find.length, 3);
  assert.equal(publicMessages.calls.deleteMany.length, 3);
  assert.deepEqual(publicMessages.calls.deleteMany[0]._id.$in, ['m-0', 'm-1']);
});

test('the batch loop stops at the safety valve', async () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  // A model that always reports a full batch would loop forever without it.
  const endless = {
    finds: 0,
    find() {
      this.finds += 1;
      return {
        select: () => ({ limit: () => ({ lean: async () => [{ _id: 'x' }, { _id: 'y' }] }) })
      };
    },
    async deleteMany() { return { deletedCount: 2 }; }
  };

  const job = createRetentionJob({
    models: { PublicMessage: endless },
    config: { ...DEFAULTS, batchSize: 2, maxBatches: 4 },
    now: () => now
  });

  const report = await job.runOnce();
  assert.equal(endless.finds, 4);
  assert.equal(report.publicMessages, 8);
});

test('spent and expired reset tokens go; live ones stay', async () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const passwordReset = fakeModel([
    { _id: 'expired', expiresAt: daysAgo(now, 1), used: false, createdAt: daysAgo(now, 1) },
    { _id: 'used-long-ago', expiresAt: daysAgo(now, -2), used: true, createdAt: daysAgo(now, 5) },
    { _id: 'live', expiresAt: new Date(now.getTime() + 30 * 60 * 1000), used: false, createdAt: now }
  ]);

  const job = createRetentionJob({ models: { PasswordReset: passwordReset }, now: () => now });
  const report = await job.runOnce();

  assert.equal(report.passwordResets, 2);
  assert.deepEqual(passwordReset.rows.map(r => r._id), ['live']);
});

test('reset tokens are kept when the window is set to zero', async () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const passwordReset = fakeModel([
    { _id: 'expired', expiresAt: daysAgo(now, 1), used: false, createdAt: daysAgo(now, 1) }
  ]);

  const job = createRetentionJob({
    models: { PasswordReset: passwordReset },
    config: { ...DEFAULTS, passwordResetDays: 0 },
    now: () => now
  });
  const report = await job.runOnce();

  assert.equal(report.passwordResets, 0);
  assert.equal(passwordReset.calls.deleteMany.length, 0);
});

test('a sweep does nothing while the database is unreachable', async () => {
  const publicMessages = fakeModel([{ _id: 'm', time: new Date(0) }]);
  const job = createRetentionJob({
    models: { PublicMessage: publicMessages },
    isConnected: () => false
  });

  const report = await job.runOnce();
  assert.deepEqual(report, { skipped: 'database_unavailable' });
  assert.equal(publicMessages.calls.find.length, 0);
});

test('a failing collection does not abort the rest of the sweep', async () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const broken = {
    find() { throw new Error('cursor exploded'); },
    async deleteMany() { return { deletedCount: 0 }; }
  };
  const roomMessages = fakeModel(transcript(now, 1));

  const job = createRetentionJob({
    models: { PublicMessage: broken, RoomMessage: roomMessages },
    now: () => now,
    log: () => {}
  });

  const report = await job.runOnce();
  assert.equal(report.publicMessages, 0);
  assert.equal(report.roomMessages, 1, 'the healthy collection was still pruned');
});

test('the report totals what was removed, and only logs when something was', async () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const logged = [];

  const quiet = createRetentionJob({
    models: { PublicMessage: fakeModel(transcript(now, 0)) },
    now: () => now,
    log: line => logged.push(line)
  });
  await quiet.runOnce();
  assert.equal(logged.length, 0, 'a clean sweep is silent');

  const busy = createRetentionJob({
    models: { PublicMessage: fakeModel(transcript(now, 2)) },
    now: () => now,
    log: line => logged.push(line)
  });
  const report = await busy.runOnce();

  assert.equal(logged.length, 1);
  assert.match(logged[0], /removed 2 document\(s\)/);
  assert.match(logged[0], /arena 2/);
  assert.equal(report.at, now.toISOString());
  assert.equal(typeof report.durationMs, 'number');
});

test('start is idempotent and stop retires the timer', () => {
  const job = createRetentionJob({ models: {} });

  const first = job.start();
  assert.ok(first, 'a timer was scheduled');
  assert.equal(job.start(), first, 'starting twice does not schedule a second sweep');

  job.stop();
  const again = job.start();
  assert.ok(again);
  assert.notEqual(again, first, 'a stopped job can be started again');
  job.stop();
  // Stopping twice is a no-op rather than an exception.
  job.stop();
});
