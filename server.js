'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const { init } = require('./db');
const models = require('./models');

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for real client IPs.

// NOTE: the Stripe webhook (added in the billing phase) must be mounted with
// express.raw BEFORE this global JSON parser, or signature verification breaks.
app.use(express.json({ limit: '32kb' }));

// ---- Config ----
const PORT = process.env.PORT || 3000;
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const IP_HASH_SALT = process.env.IP_HASH_SALT || process.env.SESSION_SECRET || 'dev-salt';

if (!TURNSTILE_SECRET_KEY) {
  console.warn('[comments] WARNING: TURNSTILE_SECRET_KEY not set. Captcha verification is DISABLED (dev mode).');
}

// ---- CORS ----
// Published comments are public and embeds live on arbitrary customer domains,
// so reads/writes allow any origin. CORS is NOT the security boundary for
// writes — site-exists + paid + Turnstile + rate limit are. No credentials are
// used cross-origin (the owner dashboard is same-origin).
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- Helpers ----
function hashIp(ip) {
  return crypto.createHash('sha256').update((ip || '') + '|' + IP_HASH_SALT).digest('hex').slice(0, 32);
}

async function verifyTurnstile(token, ip, site) {
  if (!TURNSTILE_SECRET_KEY) return true; // dev mode: no captcha configured
  if (!token) return false;
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token, remoteip: ip || '' }),
    });
    const data = await resp.json();
    if (data.success !== true) return false;
    // One Turnstile widget serves every customer domain (hostname validation is
    // disabled in Cloudflare), so enforce the hostname here against the site's
    // registered domains. Empty domains[] = accept any (owner hasn't locked down).
    const domains = (site && site.domains) || [];
    if (domains.length && data.hostname && !domains.includes(data.hostname)) return false;
    return true;
  } catch (err) {
    console.error('[comments] Turnstile verify failed:', err);
    return false;
  }
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

// Shape flat rows into a 2-level tree: top-level notes, each with replies.
function buildTree(rows) {
  const byId = new Map();
  const roots = [];
  for (const r of rows) byId.set(r.id, { ...r, replies: [] });
  for (const r of rows) {
    const node = byId.get(r.id);
    if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).replies.push(node);
    else roots.push(node);
  }
  roots.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // newest first
  for (const root of roots) root.replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return roots;
}

// Resolve the site for a request from its public site_id (query or body).
async function loadSite(req, res) {
  const siteId = (req.query.site_id || (req.body && req.body.site_id) || '').toString();
  const site = await models.getSiteByPublicId(siteId);
  if (!site) {
    res.status(404).json({ error: 'Unknown site.' });
    return null;
  }
  return site;
}

// Derive the thread key from request params (mode/page_url/thread_key override).
function threadKeyFromReq(site, src) {
  return models.deriveThreadKey({
    siteId: site.site_id,
    mode: src.mode || models.GUESTBOOK,
    pageUrl: src.page_url,
    override: src.thread_key,
  });
}

// ---- Rate limiting on writes ----
const postLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please wait a minute and try again.' },
});

// ===================== Public API =====================

// Public config the embed needs (safe to expose). public_key/key_version are
// added in the E2EE phase.
app.get('/api/config', async (req, res) => {
  try {
    const site = await loadSite(req, res);
    if (!site) return;
    res.json({
      site_id: site.site_id,
      turnstile_site_key: TURNSTILE_SITE_KEY,
      max_name: site.max_name_length,
      max_body: site.max_body_length,
      accepting: models.siteAccepting(site),
    });
  } catch (err) {
    console.error('[comments] config error:', err);
    res.status(500).json({ error: 'Could not load config.' });
  }
});

// List published comments for a thread.
app.get('/api/comments', async (req, res) => {
  try {
    const site = await loadSite(req, res);
    if (!site) return;
    let threadKey;
    try {
      threadKey = threadKeyFromReq(site, req.query);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const rows = await models.listPublishedThread(site.id, threadKey);
    res.json({ comments: buildTree(rows) });
  } catch (err) {
    console.error('[comments] list error:', err);
    res.status(500).json({ error: 'Could not load comments.' });
  }
});

// Create a comment or reply.
//
// PHASE 1 BEHAVIOR: stores the comment as published plaintext immediately, to
// verify multi-tenant routing without crypto. The E2EE phase changes this to
// store ciphertext as 'pending' for owner moderation.
app.post('/api/comments', postLimiter, async (req, res) => {
  try {
    const site = await loadSite(req, res);
    if (!site) return;
    if (!models.siteAccepting(site)) {
      return res.status(402).json({ error: 'This site is not currently accepting comments.' });
    }

    const { name, body, parent_id, website, turnstileToken } = req.body || {};

    // Honeypot: real users never fill this hidden field.
    if (website) return res.status(400).json({ error: 'Spam detected.' });

    const ip = req.ip;
    const ok = await verifyTurnstile(turnstileToken, ip, site);
    if (!ok) return res.status(400).json({ error: 'Human verification failed. Please try again.' });

    const cleanName = cleanText(name, site.max_name_length) || 'Anonymous';
    const cleanBody = cleanText(body, site.max_body_length);
    if (!cleanBody) return res.status(400).json({ error: 'Your comment is empty.' });

    let threadKey, resolvedParent;
    try {
      threadKey = threadKeyFromReq(site, req.body);
      resolvedParent = await models.resolveParent(site.id, threadKey, parent_id);
    } catch (e) {
      return res.status(400).json({ error: e.message === 'parent not found' ? 'That comment no longer exists.' : e.message });
    }

    await models.insertComment({
      siteFk: site.id,
      threadKey,
      parentId: resolvedParent,
      status: 'published', // Phase 1 only — becomes 'pending' + ciphertext in the E2EE phase
      isOwner: false,
      name: cleanName,
      body: cleanBody,
      ipHash: hashIp(ip),
      publishedAt: new Date(),
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[comments] create error:', err);
    res.status(500).json({ error: 'Could not save your comment.' });
  }
});

// ---- Static files (standalone page, dashboard, embed script) ----
app.use(express.static(path.join(__dirname, 'public')));

// Liveness check. Stays up while the DB is still connecting so the platform
// healthcheck passes and we can read startup logs.
let dbReady = false;
app.get('/healthz', (req, res) => res.json({ ok: true, db: dbReady }));

app.listen(PORT, () => {
  console.log(`[comments] listening on port ${PORT}`);
  if (!process.env.DATABASE_URL) {
    console.warn('[comments] WARNING: DATABASE_URL is not set.');
  }
});

// Connect to Postgres in the background, retrying instead of crashing.
async function connectWithRetry(attempt = 1) {
  try {
    await init();
    dbReady = true;
    console.log('[comments] database ready');
  } catch (err) {
    const delay = Math.min(30000, 2000 * 2 ** (attempt - 1));
    console.error(`[comments] database init failed (attempt ${attempt}): ${err.message}. Retrying in ${delay}ms`);
    setTimeout(() => connectWithRetry(attempt + 1), delay);
  }
}
connectWithRetry();

module.exports = app;
