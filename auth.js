'use strict';

/*
 * Passwordless auth: owners log in by magic link. A short-lived single-use link
 * token proves email ownership; consuming it mints a long-lived session stored
 * in an httpOnly cookie.
 *
 * Only salted hashes of tokens are stored (peppered with SESSION_SECRET), so a
 * database leak alone can't be used to forge a link or session. This identity
 * is SEPARATE from the per-site encryption passphrase — having a session lets
 * you manage sites and see ciphertext, but not decrypt it.
 */

const crypto = require('crypto');
const { pool } = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';
const COOKIE_NAME = 'sid';
const MAGIC_LINK_TTL_MIN = 15;
const SESSION_TTL_DAYS = 30;
const COOKIE_SECURE = (process.env.APP_BASE_URL || '').startsWith('https://');

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw + '|' + SESSION_SECRET).digest('hex');
}

async function findOrCreateOwner(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return null;
  const { rows } = await pool.query(
    `INSERT INTO owners (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [clean]
  );
  return rows[0];
}

// Issue a magic link; returns the raw token to embed in the emailed URL.
async function createMagicLink(ownerId) {
  const raw = randomToken();
  const expires = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000);
  await pool.query(
    `INSERT INTO magic_links (owner_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [ownerId, hashToken(raw), expires]
  );
  return raw;
}

// Consume a magic link atomically (single-use). Returns the owner id or null.
async function consumeMagicLink(raw) {
  if (!raw) return null;
  const { rows } = await pool.query(
    `UPDATE magic_links
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING owner_id`,
    [hashToken(raw)]
  );
  return rows.length ? rows[0].owner_id : null;
}

async function createSession(ownerId) {
  const raw = randomToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO sessions (owner_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [ownerId, hashToken(raw), expires]
  );
  await pool.query(`UPDATE owners SET last_login_at = now() WHERE id = $1`, [ownerId]);
  return raw;
}

async function getSessionOwner(raw) {
  if (!raw) return null;
  const { rows } = await pool.query(
    `SELECT o.id, o.email, o.stripe_customer_id
       FROM sessions s JOIN owners o ON o.id = s.owner_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(raw)]
  );
  return rows[0] || null;
}

async function destroySession(raw) {
  if (!raw) return;
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(raw)]);
}

function setSessionCookie(res, raw) {
  res.cookie(COOKIE_NAME, raw, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// Express middleware: require a valid session, attach req.owner.
async function requireOwner(req, res, next) {
  try {
    const raw = req.cookies && req.cookies[COOKIE_NAME];
    const owner = await getSessionOwner(raw);
    if (!owner) return res.status(401).json({ error: 'Not signed in.' });
    req.owner = owner;
    next();
  } catch (err) {
    console.error('[auth] requireOwner error:', err);
    res.status(500).json({ error: 'Auth check failed.' });
  }
}

module.exports = {
  COOKIE_NAME, MAGIC_LINK_TTL_MIN,
  findOrCreateOwner, createMagicLink, consumeMagicLink,
  createSession, getSessionOwner, destroySession,
  setSessionCookie, clearSessionCookie, requireOwner,
};
