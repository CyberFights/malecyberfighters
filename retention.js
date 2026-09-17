/**
 * Retention — how long the site keeps what.
 *
 * Every message collection here grows forever: the arena transcript, room
 * transcripts, the IP log written on every login and registration attempt, and
 * spent password-reset tokens. Nothing ever removed a document, so the only
 * direction was up — slower queries, a bigger backup, and an IP log that keeps
 * a member's address and user agent long after it could serve any purpose.
 *
 * What is pruned, and what deliberately is not:
 *
 *   PublicMessage / RoomMessage   chat transcripts. Kept for a window long
 *                                 enough to moderate a dispute, then dropped.
 *   IpLog                         the most sensitive collection on the site
 *                                 (IP + user agent per auth attempt), so it has
 *                                 the shortest window.
 *   PasswordReset                 spent and expired tokens; they are single-use
 *                                 and worthless after an hour.
 *   DM                            NOT pruned by default. Direct messages are
 *                                 member content, and stories are built out of
 *                                 them — silently deleting the conversation a
 *                                 published story was assembled from would
 *                                 damage something a member wrote on purpose.
 *                                 Set RETENTION_DM_DAYS to opt in.
 *
 * Deletes run in batches. One `deleteMany` over months of arena chat is a
 * single large write that holds locks and spikes replication; finding a page of
 * ids and deleting those keeps each operation small enough to interleave with
 * live traffic.
 *
 * Split out of index.js like dmDelivery.js and storyRoutes.js so the rules can
 * be exercised without a database — see tests/retention.test.js.
 */
'use strict';

/** Days of history kept, per collection. 0 means "never prune". */
const DEFAULTS = {
  publicMessageDays: 180,
  roomMessageDays: 180,
  ipLogDays: 30,
  passwordResetDays: 1,
  dmDays: 0,
  /** How often the sweep runs. */
  intervalHours: 6,
  /** Documents deleted per operation. */
  batchSize: 1000,
  /** Safety valve: never loop more than this many batches per collection. */
  maxBatches: 200
};

/**
 * Read the retention window from the environment, ignoring anything that is not
 * a non-negative number of days. An unparsable value falls back to the default
 * rather than to "delete everything".
 */
function daysFromEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function configFromEnv(env = process.env) {
  return {
    publicMessageDays: daysFromEnv(env.RETENTION_PUBLIC_DAYS, DEFAULTS.publicMessageDays),
    roomMessageDays: daysFromEnv(env.RETENTION_ROOM_DAYS, DEFAULTS.roomMessageDays),
    ipLogDays: daysFromEnv(env.RETENTION_IP_DAYS, DEFAULTS.ipLogDays),
    passwordResetDays: daysFromEnv(env.RETENTION_RESET_DAYS, DEFAULTS.passwordResetDays),
    dmDays: daysFromEnv(env.RETENTION_DM_DAYS, DEFAULTS.dmDays),
    intervalHours: Number(env.RETENTION_INTERVAL_HOURS) > 0
      ? Number(env.RETENTION_INTERVAL_HOURS)
      : DEFAULTS.intervalHours,
    batchSize: Number(env.RETENTION_BATCH) > 0
      ? Math.min(Number(env.RETENTION_BATCH), 10000)
      : DEFAULTS.batchSize,
    maxBatches: DEFAULTS.maxBatches
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {object} deps.models   the mongoose models to prune
 * @param {object} [deps.config] retention windows (see configFromEnv)
 * @param {function} [deps.now]  clock, so a test can pin "today"
 * @param {function} [deps.isConnected] whether Mongo is reachable
 * @param {function} [deps.log]
 */
function createRetentionJob({ models, config = DEFAULTS, now = () => new Date(), isConnected = () => true, log = console.log }) {
  const { PublicMessage, RoomMessage, IpLog, PasswordReset, DM } = models;

  /**
   * Delete documents older than `cutoff` in batches.
   *
   * `field` is the timestamp each collection actually uses: the message
   * collections store `time`, while IpLog and PasswordReset use `createdAt`.
   *
   * @returns {Promise<number>} how many were removed
   */
  async function pruneCollection(model, cutoff, label, field = 'time') {
    if (!model || !cutoff) return 0;

    let removed = 0;
    for (let batch = 0; batch < config.maxBatches; batch++) {
      let ids;
      try {
        const rows = await model
          .find({ [field]: { $lt: cutoff } })
          .select('_id')
          .limit(config.batchSize)
          .lean();
        ids = rows.map(row => row._id);
      } catch (err) {
        console.error(`retention: ${label} lookup failed:`, err.message || err);
        return removed;
      }

      if (!ids.length) break;

      try {
        const res = await model.deleteMany({ _id: { $in: ids } });
        removed += res?.deletedCount || 0;
      } catch (err) {
        console.error(`retention: ${label} delete failed:`, err.message || err);
        return removed;
      }

      if (ids.length < config.batchSize) break;
    }
    return removed;
  }

  /**
   * One sweep. Returns a report rather than only logging it, so a test (and the
   * admin stats endpoint) can assert on what happened.
   */
  async function runOnce() {
    if (!isConnected()) {
      return { skipped: 'database_unavailable' };
    }

    const started = Date.now();
    const at = now();
    const cutoffFor = days => (days > 0 ? new Date(at.getTime() - days * DAY_MS) : null);

    const report = {
      at: at.toISOString(),
      publicMessages: await pruneCollection(PublicMessage, cutoffFor(config.publicMessageDays), 'PublicMessage'),
      roomMessages: await pruneCollection(RoomMessage, cutoffFor(config.roomMessageDays), 'RoomMessage'),
      ipLogs: await pruneCollection(IpLog, cutoffFor(config.ipLogDays), 'IpLog', 'createdAt'),
      dms: await pruneCollection(DM, cutoffFor(config.dmDays), 'DM'),
      passwordResets: 0,
      durationMs: 0
    };

    // Reset tokens are keyed on their own expiry rather than a fixed window:
    // anything already expired, or already used and older than the grace
    // period, can go.
    if (PasswordReset && config.passwordResetDays > 0) {
      const grace = new Date(at.getTime() - config.passwordResetDays * DAY_MS);
      try {
        const res = await PasswordReset.deleteMany({
          $or: [{ expiresAt: { $lt: at } }, { used: true, createdAt: { $lt: grace } }]
        });
        report.passwordResets = res?.deletedCount || 0;
      } catch (err) {
        console.error('retention: PasswordReset delete failed:', err.message || err);
      }
    }

    report.durationMs = Date.now() - started;

    const removed =
      report.publicMessages + report.roomMessages + report.ipLogs +
      report.dms + report.passwordResets;
    if (removed > 0) {
      log(
        `retention: removed ${removed} document(s) in ${report.durationMs}ms ` +
        `(arena ${report.publicMessages}, rooms ${report.roomMessages}, ` +
        `ip-log ${report.ipLogs}, dm ${report.dms}, reset ${report.passwordResets})`
      );
    }
    return report;
  }

  let timer = null;

  /** Start the periodic sweep. Never holds the process open. */
  function start() {
    if (timer) return timer;
    const every = Math.max(1, config.intervalHours) * 60 * 60 * 1000;

    // First sweep shortly after boot rather than immediately: the site should be
    // serving members before it starts deleting.
    const firstRun = setTimeout(() => {
      runOnce().catch(err => console.error('retention: sweep failed:', err.message || err));
      timer = setInterval(() => {
        runOnce().catch(err => console.error('retention: sweep failed:', err.message || err));
      }, every);
      // An interval must not keep the process alive on its own.
      if (typeof timer.unref === 'function') timer.unref();
    }, 60 * 1000);
    if (typeof firstRun.unref === 'function') firstRun.unref();

    timer = firstRun;
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, config, DEFAULTS };
}

module.exports = { createRetentionJob, configFromEnv, daysFromEnv, DEFAULTS, DAY_MS };
