'use strict';

/*
 * Site-scoped data access. Every comment query in the app goes through here so
 * that tenant isolation is enforced in ONE place: no function returns or mutates
 * a comment without a site_id_fk predicate. server.js never queries `comments`
 * directly.
 */

const crypto = require('crypto');
const { pool } = require('./db');

const GUESTBOOK = 'guestbook';
const POST = 'post';

// ── Thread keys ─────────────────────────────────────────────────────────────
// The client never sends a raw thread key; the server derives it so that URL
// variants (www., trailing slash, query/fragment) collapse to one thread, and
// so a malicious client can't forge another site's thread namespace.

function normalizeUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    // Not a full URL — treat the raw string as an opaque path key.
    return String(rawUrl || '').trim().toLowerCase().replace(/\/+$/, '');
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return host + path; // drop protocol, port, query, and fragment
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Derive the thread key for a request.
 *   - guestbook mode → one fixed thread per site
 *   - post mode      → keyed on the normalized page URL
 *   - override       → owner-pinned stable key (survives slug changes)
 */
function deriveThreadKey({ siteId, mode, pageUrl, override }) {
  if (override) return sha256('override:' + siteId + ':' + String(override).trim());
  if (mode === GUESTBOOK) return 'guestbook:' + siteId;
  if (mode === POST) {
    if (!pageUrl) throw new Error('page_url is required for post mode');
    return sha256('post:' + siteId + ':' + normalizeUrl(pageUrl));
  }
  throw new Error('unknown mode: ' + mode);
}

// ── Sites ─────────────────────────────────────────────────────────────────

// Public, unguessable site identifier that appears in the embed snippet.
function generateSiteId() {
  return crypto.randomBytes(16).toString('base64url');
}

async function getSiteByPublicId(siteId) {
  if (!siteId) return null;
  const { rows } = await pool.query('SELECT * FROM sites WHERE site_id = $1', [siteId]);
  return rows[0] || null;
}

async function createSite(ownerId, name, domains) {
  const siteId = generateSiteId();
  const { rows } = await pool.query(
    `INSERT INTO sites (owner_id, site_id, name, domains)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [ownerId, siteId, name, domains || []]
  );
  return rows[0];
}

async function listSitesForOwner(ownerId) {
  const { rows } = await pool.query(
    `SELECT * FROM sites WHERE owner_id = $1 ORDER BY created_at ASC`,
    [ownerId]
  );
  return rows;
}

// Fetch a site only if it belongs to this owner (per-tenant authorization).
async function getOwnedSite(ownerId, siteId) {
  const { rows } = await pool.query(
    `SELECT * FROM sites WHERE site_id = $1 AND owner_id = $2`,
    [siteId, ownerId]
  );
  return rows[0] || null;
}

async function updateSite(ownerId, siteId, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = $${i++}`);
    vals.push(val);
  }
  if (!sets.length) return getOwnedSite(ownerId, siteId);
  vals.push(siteId, ownerId);
  const { rows } = await pool.query(
    `UPDATE sites SET ${sets.join(', ')}
      WHERE site_id = $${i++} AND owner_id = $${i}
      RETURNING *`,
    vals
  );
  return rows[0] || null;
}

// A site is "accepting" new comments when its plan is active or lifetime.
// past_due gets a grace period (still accepts); unpaid/canceled do not.
function siteAccepting(site) {
  if (!site) return false;
  return ['active', 'lifetime', 'past_due'].includes(site.plan_status);
}

// ── Comments (all scoped by site_id_fk) ─────────────────────────────────────

async function listPublishedThread(siteFk, threadKey) {
  const { rows } = await pool.query(
    `SELECT id, name, body, parent_id, is_owner, created_at
       FROM comments
      WHERE site_id_fk = $1 AND thread_key = $2 AND status = 'published'
      ORDER BY created_at ASC`,
    [siteFk, threadKey]
  );
  return rows;
}

/**
 * Resolve a parent comment, clamping threads to 2 levels (a reply to a reply
 * attaches to the top-level note) and ensuring the parent belongs to this site
 * and thread. Returns the effective parent id, or null.
 */
async function resolveParent(siteFk, threadKey, parentId) {
  if (!parentId) return null;
  const { rows } = await pool.query(
    `SELECT id, parent_id FROM comments
      WHERE id = $1 AND site_id_fk = $2 AND thread_key = $3`,
    [parentId, siteFk, threadKey]
  );
  if (!rows.length) throw new Error('parent not found');
  return rows[0].parent_id || rows[0].id;
}

async function insertComment(c) {
  const { rows } = await pool.query(
    `INSERT INTO comments
       (site_id_fk, thread_key, parent_id, status, is_owner,
        ciphertext, key_version, name, body, ip_hash, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      c.siteFk, c.threadKey, c.parentId || null, c.status, !!c.isOwner,
      c.ciphertext || null, c.keyVersion || null, c.name || null, c.body || null,
      c.ipHash || null, c.publishedAt || null,
    ]
  );
  return rows[0];
}

// Pending + rejected ciphertext rows for the owner's moderation queue. Never
// includes plaintext (pending rows have none). Scoped to one site.
async function listPendingForSite(siteFk) {
  const { rows } = await pool.query(
    `SELECT id, thread_key, parent_id, status, ciphertext, key_version, created_at
       FROM comments
      WHERE site_id_fk = $1 AND status IN ('pending','rejected')
      ORDER BY created_at ASC`,
    [siteFk]
  );
  return rows;
}

// Publish a pending comment: store decrypted plaintext, drop the ciphertext.
async function publishComment(siteFk, id, name, body) {
  const { rowCount } = await pool.query(
    `UPDATE comments
        SET status = 'published', name = $3, body = $4,
            ciphertext = NULL, published_at = now()
      WHERE id = $1 AND site_id_fk = $2 AND status = 'pending'`,
    [id, siteFk, name, body]
  );
  return rowCount > 0;
}

async function rejectComment(siteFk, id) {
  const { rowCount } = await pool.query(
    `UPDATE comments SET status = 'rejected', ciphertext = NULL
      WHERE id = $1 AND site_id_fk = $2 AND status = 'pending'`,
    [id, siteFk]
  );
  return rowCount > 0;
}

async function deleteComment(siteFk, id) {
  // Cascade handles replies via the self-referencing FK.
  const { rowCount } = await pool.query(
    `DELETE FROM comments WHERE id = $1 AND site_id_fk = $2`,
    [id, siteFk]
  );
  return rowCount > 0;
}

module.exports = {
  GUESTBOOK, POST,
  normalizeUrl, deriveThreadKey,
  generateSiteId, getSiteByPublicId, siteAccepting,
  createSite, listSitesForOwner, getOwnedSite, updateSite,
  listPublishedThread, resolveParent, insertComment,
  listPendingForSite, publishComment, rejectComment, deleteComment,
};
