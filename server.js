'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const { pool, init } = require('./db');

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for real client IPs.
app.use(express.json({ limit: '16kb' }));

// ---- Config ----
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const MAX_NAME_LENGTH = parseInt(process.env.MAX_NAME_LENGTH || '50', 10);
const MAX_BODY_LENGTH = parseInt(process.env.MAX_BODY_LENGTH || '280', 10);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!ADMIN_TOKEN) {
  console.warn('[guestbook] WARNING: ADMIN_TOKEN is not set. Moderation is disabled until you set it.');
}
if (!TURNSTILE_SECRET_KEY) {
  console.warn('[guestbook] WARNING: TURNSTILE_SECRET_KEY is not set. Captcha verification is DISABLED (dev mode).');
}

// ---- CORS (so the embed script on your blog can talk to this API) ----
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) {
    res.set('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- Helpers ----
function hashIp(ip) {
  // Store a salted hash, never the raw IP, so we can rate-limit/dedupe
  // without holding personal data.
  return crypto
    .createHash('sha256')
    .update((ip || '') + '|' + (ADMIN_TOKEN || 'salt'))
    .digest('hex')
    .slice(0, 32);
}

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET_KEY) return true; // dev mode: no captcha configured
  if (!token) return false;
  try {
    const resp = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: ip || '',
        }),
      }
    );
    const data = await resp.json();
    return data.success === true;
  } catch (err) {
    console.error('[guestbook] Turnstile verify failed:', err);
    return false;
  }
}

// Plain text only: collapse excessive blank lines, trim, enforce length.
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function requireAdmin(req, res, next) {
  const token = req.get('X-Admin-Token') || '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Shape DB rows into a 2-level tree: top-level notes, each with replies.
function buildTree(rows) {
  const byId = new Map();
  const roots = [];
  for (const r of rows) {
    byId.set(r.id, { ...r, replies: [] });
  }
  for (const r of rows) {
    const node = byId.get(r.id);
    if (r.parent_id && byId.has(r.parent_id)) {
      byId.get(r.parent_id).replies.push(node);
    } else {
      roots.push(node);
    }
  }
  // Newest notes first; replies oldest first (conversation order).
  roots.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  for (const root of roots) {
    root.replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  return roots;
}

// ---- Rate limiting on writes ----
const postLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // max 5 submissions per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please wait a minute and try again.' },
});

// ===================== Public API =====================

// Public config the embed script needs (safe to expose).
app.get('/api/config', (req, res) => {
  res.json({
    siteKey: TURNSTILE_SITE_KEY,
    maxName: MAX_NAME_LENGTH,
    maxBody: MAX_BODY_LENGTH,
  });
});

// List visible notes + replies.
app.get('/api/notes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, body, parent_id, is_owner, created_at
         FROM notes
        WHERE hidden = FALSE
        ORDER BY created_at ASC`
    );
    res.json({ notes: buildTree(rows) });
  } catch (err) {
    console.error('[guestbook] list error:', err);
    res.status(500).json({ error: 'Could not load the guestbook.' });
  }
});

// Create a note or a reply (visitor).
app.post('/api/notes', postLimiter, async (req, res) => {
  try {
    const { name, body, parent_id, website, turnstileToken } = req.body || {};

    // Honeypot: real users never fill this hidden field.
    if (website) return res.status(400).json({ error: 'Spam detected.' });

    const ip = req.ip;
    const ok = await verifyTurnstile(turnstileToken, ip);
    if (!ok) return res.status(400).json({ error: 'Human verification failed. Please try again.' });

    const cleanName = cleanText(name, MAX_NAME_LENGTH) || 'Anonymous';
    const cleanBody = cleanText(body, MAX_BODY_LENGTH);
    if (!cleanBody) return res.status(400).json({ error: 'Your note is empty.' });

    // Resolve the parent so threads never go deeper than 2 levels:
    // a reply to a reply attaches to the original top-level note.
    let resolvedParent = null;
    if (parent_id) {
      const { rows } = await pool.query(
        `SELECT id, parent_id FROM notes WHERE id = $1 AND hidden = FALSE`,
        [parent_id]
      );
      if (!rows.length) return res.status(400).json({ error: 'That note no longer exists.' });
      resolvedParent = rows[0].parent_id || rows[0].id;
    }

    const { rows } = await pool.query(
      `INSERT INTO notes (name, body, parent_id, is_owner, ip_hash)
       VALUES ($1, $2, $3, FALSE, $4)
       RETURNING id, name, body, parent_id, is_owner, created_at`,
      [cleanName, cleanBody, resolvedParent, hashIp(ip)]
    );
    res.status(201).json({ note: rows[0] });
  } catch (err) {
    console.error('[guestbook] create error:', err);
    res.status(500).json({ error: 'Could not save your note.' });
  }
});

// ===================== Admin / Moderation API =====================

// List everything, including hidden notes, for the moderation panel.
app.get('/api/admin/notes', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, body, parent_id, is_owner, hidden, created_at
         FROM notes
        ORDER BY created_at ASC`
    );
    res.json({ notes: buildTree(rows) });
  } catch (err) {
    console.error('[guestbook] admin list error:', err);
    res.status(500).json({ error: 'Could not load notes.' });
  }
});

// Owner reply (flagged is_owner = true).
app.post('/api/admin/notes/:id/reply', requireAdmin, async (req, res) => {
  try {
    const parentId = parseInt(req.params.id, 10);
    const cleanBody = cleanText((req.body || {}).body, MAX_BODY_LENGTH);
    if (!cleanBody) return res.status(400).json({ error: 'Reply is empty.' });

    const { rows: parents } = await pool.query(
      `SELECT id, parent_id FROM notes WHERE id = $1`,
      [parentId]
    );
    if (!parents.length) return res.status(404).json({ error: 'Note not found.' });
    const resolvedParent = parents[0].parent_id || parents[0].id;

    const ownerName = cleanText((req.body || {}).name, MAX_NAME_LENGTH) || 'Owner';
    const { rows } = await pool.query(
      `INSERT INTO notes (name, body, parent_id, is_owner)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, name, body, parent_id, is_owner, created_at`,
      [ownerName, cleanBody, resolvedParent]
    );
    res.status(201).json({ note: rows[0] });
  } catch (err) {
    console.error('[guestbook] admin reply error:', err);
    res.status(500).json({ error: 'Could not post reply.' });
  }
});

// Soft-delete (hide). Hiding a top-level note also hides its replies.
app.delete('/api/admin/notes/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(
      `UPDATE notes SET hidden = TRUE WHERE id = $1 OR parent_id = $1`,
      [id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[guestbook] admin delete error:', err);
    res.status(500).json({ error: 'Could not delete note.' });
  }
});

// Restore a hidden note.
app.post('/api/admin/notes/:id/restore', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(`UPDATE notes SET hidden = FALSE WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[guestbook] admin restore error:', err);
    res.status(500).json({ error: 'Could not restore note.' });
  }
});

// Permanently delete.
app.delete('/api/admin/notes/:id/purge', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(`DELETE FROM notes WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[guestbook] admin purge error:', err);
    res.status(500).json({ error: 'Could not purge note.' });
  }
});

// ---- Static files (standalone page, admin page, embed script) ----
app.use(express.static(path.join(__dirname, 'public')));

// Clean URL for the moderation panel.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[guestbook] listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[guestbook] failed to initialize database:', err);
    process.exit(1);
  });
