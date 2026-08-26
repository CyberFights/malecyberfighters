// mailer.js
// Simple SMTP mailer wrapper. Reads configuration from environment variables
// (see .env.example) and exposes a best-effort sendMail() that never throws,
// so outgoing email is optional — if SMTP isn't configured, calls are skipped.
//
// To make the website send from administrator@male-cyber-fighters.com, set:
//   SMTP_HOST   e.g. smtp.gmail.com, smtp.zoho.com, smtp.office365.com
//   SMTP_PORT   e.g. 587 (STARTTLS) or 465 (SSL/TLS)
//   SMTP_SECURE true only if you use port 465
//   SMTP_USER   the mailbox between @ and .com (e.g. administrator)
//   SMTP_PASS   an app password (not your normal account password)
//   MAIL_FROM   the "from" address shown to recipients (defaults to SMTP_USER)

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? `${SMTP_USER}@male-cyber-fighters.com` : 'administrator@male-cyber-fighters.com');

const configured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

let transporter = null;
if (configured) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE, // true for 465, false for 587/STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
} else {
  console.warn(
    '[mailer] SMTP not configured (SMTP_HOST, SMTP_USER, SMTP_PASS missing). Outgoing email is disabled. ' +
    'See .env.example for how to enable it.'
  );
}

/**
 * Escape a value for safe inclusion in HTML output.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send an email. Resolves with { ok: true, messageId } on success,
 * { ok: false, skipped: true } when SMTP is not configured, or
 * { ok: false, error } on failure. Never throws.
 */
async function sendMail({ to, subject, text, html }) {
  if (!configured || !transporter) return { ok: false, skipped: true };
  if (!to) return { ok: false, error: 'missing_to' };

  try {
    const info = await transporter.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      text,
      html
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendMail, mailerConfigured: configured, MAIL_FROM, escapeHtml };
