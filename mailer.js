// mailer.js
// Email sending abstraction. Supports two backends so outgoing email never
// blocks the app:
//
//   1. SMTP (default) — uses nodemailer against any SMTP server. This is the
//      path for a Google Workspace / Microsoft 365 / Zoho / etc. mailbox that
//      backs an @male-cyber-fighters.com address (Squarespace itself does NOT
//      host mailboxes — it only hosts the website and DNS).
//
//   2. A transactional email provider (Resend / SendGrid / Postmark) via their
//      HTTP API. Recommended for transactional mail (welcome, password reset,
//      admin alerts): higher deliverability, no personal-mailbox send caps,
//      and bounce/complaint tracking. No SMTP/nodemailer needed on this path.
//
// Configuration is read from environment variables (see .env.example).
//   EMAIL_PROVIDER  smtp | resend | sendgrid | postmark   (default: smtp)
//
// SMTP path:
//   SMTP_HOST   e.g. smtp.gmail.com, smtp.zoho.com, smtp.office365.com
//   SMTP_PORT   e.g. 587 (STARTTLS) or 465 (SSL/TLS)
//   SMTP_SECURE true only if you use port 465
//   SMTP_USER   the FULL sending mailbox, e.g. administrator@male-cyber-fighters.com
//               (Google Workspace/Gmail SMTP requires the full address, not just
//                the local part)
//   SMTP_PASS   an App Password, not your normal password (enable 2FA first)
//
// Provider paths:
//   RESEND_API_KEY        for EMAIL_PROVIDER=resend    (https://resend.com)
//   SENDGRID_API_KEY      for EMAIL_PROVIDER=sendgrid  (https://sendgrid.com)
//   POSTMARK_SERVER_TOKEN for EMAIL_PROVIDER=postmark  (https://postmarkapp.com)
//
// Shared:
//   MAIL_FROM   the "from" address shown to recipients
//
// sendMail() never throws — it resolves with { ok, messageId?, error? }, or
// { ok:false, skipped:true } when the chosen provider isn't configured.

const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

const EMAIL_PROVIDER = String(process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();

const MAIL_FROM = process.env.MAIL_FROM || 'administrator@male-cyber-fighters.com';

// --- Provider configuration ------------------------------------------------

const SMTP_HOST = process.env.SMTP_HOST || null;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;

const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || null;
const POSTMARK_SERVER_TOKEN = process.env.POSTMARK_SERVER_TOKEN || null;

let transporter = null;

let configured = false;
switch (EMAIL_PROVIDER) {
  case 'resend':
    configured = Boolean(RESEND_API_KEY && MAIL_FROM);
    break;
  case 'sendgrid':
    configured = Boolean(SENDGRID_API_KEY && MAIL_FROM);
    break;
  case 'postmark':
    configured = Boolean(POSTMARK_SERVER_TOKEN && MAIL_FROM);
    break;
  case 'smtp':
  default:
    if (EMAIL_PROVIDER !== 'smtp') {
      console.warn(`[mailer] Unknown EMAIL_PROVIDER "${EMAIL_PROVIDER}". Falling back to SMTP.`);
    }
    configured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
    if (configured) {
      transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE, // true for 465, false for 587/STARTTLS
        auth: { user: SMTP_USER, pass: SMTP_PASS }
      });
    }
    break;
}

if (!configured) {
  console.warn(
    `[mailer] Email provider "${EMAIL_PROVIDER}" is not configured. Outgoing email is disabled. ` +
    'See .env.example for how to enable it.'
  );
}

// --- Helpers ---------------------------------------------------------------

/**
 * Escape a value for safe inclusion in HTML output.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Read a JSON body from a fetch Response, tolerating empty bodies. */
async function readJson(res) {
  try {
    return await res.json();
  } catch (_e) {
    return null;
  }
}

// --- Provider senders ------------------------------------------------------

/** Send via Google Workspace / any SMTP server through nodemailer. */
async function sendViaSmtp({ to, subject, text, html }) {
  const info = await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html });
  return { ok: true, messageId: info.messageId };
}

/** Send via Resend HTTP API (https://resend.com/docs/api-reference/emails). */
async function sendViaResend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, text })
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body)}`);
  return { ok: true, messageId: body && body.id ? body.id : `resend-${res.status}` };
}

/** Send via Twilio SendGrid HTTP API (https://docs.sendgrid.com/api-reference). */
async function sendViaSendGrid({ to, subject, text, html }) {
  const content = [{ type: 'text/plain', value: text || '' }];
  if (html) content.push({ type: 'text/html', value: html });
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: MAIL_FROM },
      subject,
      content
    })
  });
  if (!res.ok) {
    const body = await readJson(res);
    throw new Error(`SendGrid ${res.status}: ${JSON.stringify(body)}`);
  }
  return { ok: true, messageId: `sendgrid-${res.status}` };
}

/** Send via Postmark HTTP API (https://postmarkapp.com/developer/api). */
async function sendViaPostmark({ to, subject, text, html }) {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ From: MAIL_FROM, To: to, Subject: subject, TextBody: text, HtmlBody: html })
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(`Postmark ${res.status}: ${JSON.stringify(body)}`);
  return { ok: true, messageId: body && body.MessageID ? body.MessageID : `postmark-${res.status}` };
}

/**
 * Send an email. Resolves with { ok: true, messageId } on success,
 * { ok: false, skipped: true } when the provider is not configured, or
 * { ok: false, error } on failure. Never throws.
 */
async function sendMail({ to, subject, text, html }) {
  if (!configured) return { ok: false, skipped: true };
  if (!to) return { ok: false, error: 'missing_to' };

  try {
    switch (EMAIL_PROVIDER) {
      case 'resend':
        return await sendViaResend({ to, subject, text, html });
      case 'sendgrid':
        return await sendViaSendGrid({ to, subject, text, html });
      case 'postmark':
        return await sendViaPostmark({ to, subject, text, html });
      case 'smtp':
      default:
        return await sendViaSmtp({ to, subject, text, html });
    }
  } catch (err) {
    console.error(`[mailer] send failed (${EMAIL_PROVIDER}):`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendMail,
  mailerConfigured: configured,
  emailProvider: EMAIL_PROVIDER,
  MAIL_FROM,
  escapeHtml
};
