'use strict';

/*
 * Email sender for magic-link logins. If SMTP isn't configured (dev), the link
 * is printed to the server console instead of sent — so you can log in locally
 * without an email provider.
 */

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Bear Blog Comments <noreply@example.com>';

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (!SMTP_HOST) return null;
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return transport;
}

function smtpConfigured() {
  return !!SMTP_HOST;
}

async function sendMagicLink(email, link, ttlMinutes) {
  const subject = 'Your sign-in link';
  const text =
    `Click to sign in to your comments dashboard:\n\n${link}\n\n` +
    `This link expires in ${ttlMinutes} minutes and can be used once. ` +
    `If you didn't request it, ignore this email.`;

  const t = getTransport();
  if (!t) {
    // Dev fallback: surface the link in the logs.
    console.log('\n[mailer] (dev) magic link for ' + email + ':\n  ' + link + '\n');
    return { sent: false, dev: true };
  }
  await t.sendMail({ from: MAIL_FROM, to: email, subject, text });
  return { sent: true };
}

module.exports = { sendMagicLink, smtpConfigured };
