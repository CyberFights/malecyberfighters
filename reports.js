/**
 * Reports — the "Report" button that reaches the people who can act.
 *
 * The site already had a support form (a DM to the administrator's mailbox)
 * and an in-app assistant, but a moderator needs the *message* in front of
 * them, not a description of it. A report captures:
 *
 *   • who is reporting and who (or what) was reported;
 *   • where it happened — the arena, a room, a DM — and the message id plus a
 *     snippet. Chat history is pruned on a retention window and a snippet is
 *     the only durable evidence, so the text is copied onto the report at
 *     filing time (truncated; the full row stays in the log until the sweep);
 *   • a reason from a closed catalogue, for triage.
 *
 * Reports land in two places: an admin queue (listable / resolvable via the
 * existing x-admin-key endpoints) and — when DISCORD_SUPPORT_URL is
 * configured — the same support webhook the assistance popup documents.
 *
 * Split out of index.js like the other route modules — see tests/reports.test.js.
 */
'use strict';

const REASONS = [
  { id: 'harassment', label: 'Harassment / bullying' },
  { id: 'hate', label: 'Hate speech or slurs' },
  { id: 'spam', label: 'Spam or flooding' },
  { id: 'explicit', label: 'Explicit content in the wrong place' },
  { id: 'impersonation', label: 'Impersonating staff or a member' },
  { id: 'minor', label: 'Suspected minor (18+ site)' },
  { id: 'other', label: 'Something else' }
];

const REPORT_LIMITS = {
  details: 2000,
  snippet: 300
};

const isAllowedReason = reason =>
  typeof reason === 'string' && REASONS.some(r => r.id === reason);

const clean = value => String(value == null ? '' : value)
  .replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

/**
 * Validate an incoming report.
 *
 * @returns {{ ok: boolean, report?: object, error?: string }}
 */
function validateReport(payload) {
  const body = payload || {};

  if (!isAllowedReason(body.reason)) {
    return { ok: false, error: 'invalid_reason' };
  }

  const targetUser = clean(body.targetUser).slice(0, 64);
  // A user report needs a user; an app-issue report ("the upload button is
  // broken") does not.
  if (!targetUser && body.kind !== 'issue') {
    return { ok: false, error: 'missing_target' };
  }

  const scope = ['public', 'room', 'dm', 'profile', 'forum', 'other'].includes(body.scope)
    ? body.scope
    : 'other';

  return {
    ok: true,
    report: {
      kind: body.kind === 'issue' ? 'issue' : 'user',
      targetUser: targetUser || null,
      reason: body.reason,
      scope,
      room: clean(body.room).slice(0, 120) || null,
      messageId: body.messageId ? String(body.messageId).slice(0, 64) : null,
      // The snippet is evidence: it must survive the message's own retention
      // window, so it is copied onto the report now.
      snippet: clean(body.snippet).slice(0, REPORT_LIMITS.snippet) || null,
      details: clean(body.details).slice(0, REPORT_LIMITS.details)
    }
  };
}

/** One line for the Discord support webhook / admin email. */
function summarizeForDispatch(report) {
  const parts = [
    `Report #${String(report._id).slice(-6)}`,
    `by ${report.reporter}`,
    report.targetUser ? `about @${report.targetUser}` : 'app issue',
    `(${report.reason}${report.room ? ` in ${report.room}` : ''})`
  ];
  return parts.join(' ');
}

function serializeReport(report) {
  if (!report) return null;
  return {
    _id: String(report._id),
    reporter: report.reporter,
    kind: report.kind || 'user',
    targetUser: report.targetUser || null,
    reason: report.reason,
    scope: report.scope || 'other',
    room: report.room || null,
    messageId: report.messageId || null,
    snippet: report.snippet || null,
    details: report.details || '',
    status: report.status || 'open',
    resolution: report.resolution || '',
    createdAt: report.createdAt || null,
    resolvedAt: report.resolvedAt || null
  };
}

function createReportsRouter({ Report, requireUser, requireAdmin, dispatchReport }) {
  const express = require('express');
  const router = express.Router();

  // ---------- file ----------
  router.post('/', requireUser, async (req, res) => {
    const validated = validateReport(req.body);
    if (!validated.ok) {
      return res.status(400).json({ ok: false, error: validated.error });
    }

    try {
      const report = await Report.create({
        ...validated.report,
        reporter: req.username,
        status: 'open'
      });

      // The webhook / email dispatch must never fail the filing itself —
      // the queue row is already saved and is the source of truth.
      if (dispatchReport) {
        try {
          await dispatchReport(report);
        } catch (err) {
          console.error('report dispatch error:', err?.message || err);
        }
      }

      return res.status(201).json({ ok: true, report: serializeReport(report) });
    } catch (err) {
      console.error('report create error:', err?.message || err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  // ---------- admin queue ----------
  router.get('/admin/list', requireAdmin, async (req, res) => {
    const status = ['open', 'resolved', 'dismissed'].includes(req.query.status)
      ? req.query.status
      : null;

    try {
      const filter = status ? { status } : {};
      const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(200).lean();
      res.json({ ok: true, reports: reports.map(serializeReport) });
    } catch (err) {
      console.error('report list error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  router.post('/admin/:id/resolve', requireAdmin, async (req, res) => {
    const status = req.body?.status === 'dismissed' ? 'dismissed' : 'resolved';

    try {
      const report = await Report.findById(req.params.id);
      if (!report) return res.status(404).json({ ok: false, error: 'not_found' });

      report.status = status;
      report.resolution = clean(req.body?.note).slice(0, 500);
      report.resolvedAt = new Date();
      await report.save();

      res.json({ ok: true, report: serializeReport(report) });
    } catch (err) {
      console.error('report resolve error:', err?.message || err);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  return { router };
}

module.exports = {
  REASONS,
  REPORT_LIMITS,
  isAllowedReason,
  validateReport,
  summarizeForDispatch,
  serializeReport,
  createReportsRouter
};
