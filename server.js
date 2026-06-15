'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { init } = require('./db');
const models = require('./models');
const auth = require('./auth');
const mailer = require('./mailer');
const billing = require('./billing');

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for real client IPs.

// The Stripe webhook needs the RAW body for signature verification, so it must
// be mounted with express.raw BEFORE the global JSON parser below.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleWebhook);

app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

// ---- Config ----
const PORT = process.env.PORT || 3000;
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
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
    const key = await models.getCurrentSiteKey(site.id);
    res.json({
      site_id: site.site_id,
      turnstile_site_key: TURNSTILE_SITE_KEY,
      max_name: site.max_name_length,
      max_body: site.max_body_length,
      accepting: models.siteAccepting(site),
      // E2EE: the public key visitors seal their comments to. Null until the
      // owner has set an encryption passphrase.
      encryption_ready: !!key,
      public_key: key ? key.public_key : null,
      key_version: key ? key.version : null,
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

// Create a comment or reply (E2EE).
//
// The body arrives already SEALED in the visitor's browser to the site's public
// key — the server only stores ciphertext as 'pending'. It cannot read the
// content; the owner decrypts and publishes from their dashboard. Anti-spam
// (honeypot/Turnstile/rate limit) operates on the envelope, not the content.
const MAX_CIPHERTEXT = 8192; // base64 of a sealed {name,body} is small; cap to prevent abuse
app.post('/api/comments', postLimiter, async (req, res) => {
  try {
    const site = await loadSite(req, res);
    if (!site) return;
    if (!models.siteAccepting(site)) {
      return res.status(402).json({ error: 'This site is not currently accepting comments.' });
    }

    const { ciphertext, key_version, parent_id, website, turnstileToken } = req.body || {};

    // Honeypot: real users never fill this hidden field.
    if (website) return res.status(400).json({ error: 'Spam detected.' });

    const ip = req.ip;
    const ok = await verifyTurnstile(turnstileToken, ip, site);
    if (!ok) return res.status(400).json({ error: 'Human verification failed. Please try again.' });

    const key = await models.getCurrentSiteKey(site.id);
    if (!key) return res.status(409).json({ error: 'This site has not finished encryption setup.' });

    if (typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > MAX_CIPHERTEXT) {
      return res.status(400).json({ error: 'Invalid comment payload.' });
    }
    // Stale key (owner rotated since the page loaded): tell the client to refetch.
    if (key_version && key_version !== key.version) {
      return res.status(409).json({ error: 'Encryption key changed — please reload and try again.' });
    }

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
      status: 'pending',
      isOwner: false,
      ciphertext,
      keyVersion: key.version,
      ipHash: hashIp(ip),
    });
    res.status(201).json({ pending: true });
  } catch (err) {
    console.error('[comments] create error:', err);
    res.status(500).json({ error: 'Could not save your comment.' });
  }
});

// ===================== Auth (magic link) =====================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait and try again.' },
});

// Request a magic link. Always returns 200 so we never reveal which emails exist.
app.post('/api/auth/magic-link', authLimiter, async (req, res) => {
  try {
    const email = (req.body && req.body.email) || '';
    const owner = await auth.findOrCreateOwner(email);
    if (owner) {
      const raw = await auth.createMagicLink(owner.id);
      const base = APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
      const link = `${base}/api/auth/callback?token=${encodeURIComponent(raw)}`;
      await mailer.sendMagicLink(owner.email, link, auth.MAGIC_LINK_TTL_MIN);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] magic-link error:', err);
    res.status(500).json({ error: 'Could not send sign-in link.' });
  }
});

// Consume a magic link (top-level navigation from the email), set the session
// cookie, and redirect to the dashboard.
app.get('/api/auth/callback', async (req, res) => {
  try {
    const ownerId = await auth.consumeMagicLink(req.query.token);
    if (!ownerId) return res.redirect('/dashboard?error=link');
    const raw = await auth.createSession(ownerId);
    auth.setSessionCookie(res, raw);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[auth] callback error:', err);
    res.redirect('/dashboard?error=server');
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    await auth.destroySession(req.cookies && req.cookies[auth.COOKIE_NAME]);
  } catch (err) {
    console.error('[auth] logout error:', err);
  }
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// Current owner + their sites.
app.get('/api/me', auth.requireOwner, async (req, res) => {
  try {
    const sites = await models.listSitesForOwner(req.owner.id);
    res.json({ owner: { email: req.owner.email }, sites });
  } catch (err) {
    console.error('[auth] me error:', err);
    res.status(500).json({ error: 'Could not load account.' });
  }
});

// ===================== Owner: sites =====================

function cleanDomains(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)
    .slice(0, 20);
}

app.post('/api/sites', auth.requireOwner, async (req, res) => {
  try {
    const name = cleanText((req.body && req.body.name) || '', 100) || 'My site';
    const domains = cleanDomains(req.body && req.body.domains);
    const site = await models.createSite(req.owner.id, name, domains);
    res.status(201).json({ site });
  } catch (err) {
    console.error('[sites] create error:', err);
    res.status(500).json({ error: 'Could not create site.' });
  }
});

app.patch('/api/sites/:siteId', auth.requireOwner, async (req, res) => {
  try {
    const fields = {};
    if (req.body && typeof req.body.name === 'string') fields.name = cleanText(req.body.name, 100) || 'My site';
    if (req.body && Array.isArray(req.body.domains)) fields.domains = cleanDomains(req.body.domains);
    if (req.body && Number.isInteger(req.body.max_body_length)) fields.max_body_length = Math.min(Math.max(req.body.max_body_length, 1), 5000);
    if (req.body && Number.isInteger(req.body.max_name_length)) fields.max_name_length = Math.min(Math.max(req.body.max_name_length, 1), 200);
    const site = await models.updateSite(req.owner.id, req.params.siteId, fields);
    if (!site) return res.status(404).json({ error: 'Site not found.' });
    res.json({ site });
  } catch (err) {
    console.error('[sites] update error:', err);
    res.status(500).json({ error: 'Could not update site.' });
  }
});

// ===================== Owner: encryption keys + moderation =====================

// Middleware: load a site owned by the session owner, or 404. Runs after
// requireOwner. Attaches req.site.
async function requireOwnedSite(req, res, next) {
  try {
    const site = await models.getOwnedSite(req.owner.id, req.params.siteId);
    if (!site) return res.status(404).json({ error: 'Site not found.' });
    req.site = site;
    next();
  } catch (err) {
    console.error('[sites] ownership check error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
}

// Get the current site key (salt + KDF params + public key) so the owner's
// browser can re-derive the keypair. Contains NO private material.
app.get('/api/sites/:siteId/key', auth.requireOwner, requireOwnedSite, async (req, res) => {
  try {
    const key = await models.getCurrentSiteKey(req.site.id);
    if (!key) return res.status(404).json({ error: 'No key set.' });
    res.json({ key });
  } catch (err) {
    console.error('[keys] get error:', err);
    res.status(500).json({ error: 'Could not load key.' });
  }
});

// Set the first key or rotate. The browser uploads only the PUBLIC key, salt,
// and KDF params — never the passphrase or private key.
app.post('/api/sites/:siteId/key', auth.requireOwner, requireOwnedSite, async (req, res) => {
  try {
    const { public_key, salt, kdf_opslimit, kdf_memlimit, kdf_algo } = req.body || {};
    if (typeof public_key !== 'string' || public_key.length < 20 || public_key.length > 100 ||
        typeof salt !== 'string' || salt.length < 10 || salt.length > 100 ||
        !Number.isInteger(kdf_opslimit) || !Number.isInteger(kdf_memlimit)) {
      return res.status(400).json({ error: 'Invalid key material.' });
    }
    const key = await models.createSiteKey(req.site.id, {
      publicKey: public_key, salt, kdfOps: kdf_opslimit, kdfMem: kdf_memlimit, kdfAlgo: kdf_algo,
    });
    res.status(201).json({ key });
  } catch (err) {
    console.error('[keys] set error:', err);
    res.status(500).json({ error: 'Could not save key.' });
  }
});

// Pending (and rejected) ciphertext rows for the moderation queue. The owner's
// browser decrypts these locally.
app.get('/api/sites/:siteId/pending', auth.requireOwner, requireOwnedSite, async (req, res) => {
  try {
    const rows = await models.listPendingForSite(req.site.id);
    res.json({ pending: rows });
  } catch (err) {
    console.error('[mod] pending error:', err);
    res.status(500).json({ error: 'Could not load pending comments.' });
  }
});

// Publish a pending comment: the owner sends the decrypted plaintext, which then
// becomes public. Ciphertext is dropped.
app.post('/api/sites/:siteId/comments/:id/publish', auth.requireOwner, requireOwnedSite, async (req, res) => {
  try {
    const name = cleanText((req.body && req.body.name) || '', req.site.max_name_length) || 'Anonymous';
    const body = cleanText((req.body && req.body.body) || '', req.site.max_body_length);
    if (!body) return res.status(400).json({ error: 'Decrypted comment is empty.' });
    const ok = await models.publishComment(req.site.id, parseInt(req.params.id, 10), name, body);
    if (!ok) return res.status(404).json({ error: 'Pending comment not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mod] publish error:', err);
    res.status(500).json({ error: 'Could not publish.' });
  }
});

app.post('/api/sites/:siteId/comments/:id/reject', auth.requireOwner, requireOwnedSite, async (req, res) => {
  try {
    const ok = await models.rejectComment(req.site.id, parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Pending comment not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mod] reject error:', err);
    res.status(500).json({ error: 'Could not reject.' });
  }
});

app.delete('/api/sites/:siteId/comments/:id', auth.requireOwner, requireOwnedSite, async (req, res) => {
  try {
    const ok = await models.deleteComment(req.site.id, parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Comment not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[mod] delete error:', err);
    res.status(500).json({ error: 'Could not delete.' });
  }
});

// Owner reply: published plaintext directly (the owner is the moderator), tagged
// as the owner. Attaches to the target comment's thread, clamped to 2 levels.
app.post('/api/sites/:siteId/comments/:id/reply', auth.requireOwner, requireOwnedSite, async (req, res) => {
  try {
    const parent = await models.getCommentById(req.site.id, parseInt(req.params.id, 10));
    if (!parent) return res.status(404).json({ error: 'Comment not found.' });
    const name = cleanText((req.body && req.body.name) || '', req.site.max_name_length) || 'Owner';
    const body = cleanText((req.body && req.body.body) || '', req.site.max_body_length);
    if (!body) return res.status(400).json({ error: 'Reply is empty.' });
    await models.insertComment({
      siteFk: req.site.id,
      threadKey: parent.thread_key,
      parentId: parent.parent_id || parent.id, // clamp to top-level
      status: 'published',
      isOwner: true,
      name,
      body,
      publishedAt: new Date(),
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[mod] reply error:', err);
    res.status(500).json({ error: 'Could not reply.' });
  }
});

// ===================== Billing (Stripe) =====================

function billingBaseUrl(req) {
  return APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

app.post('/api/billing/checkout', auth.requireOwner, async (req, res) => {
  if (!billing.billingConfigured()) return res.status(400).json({ error: 'Billing is not configured.' });
  const { site_id, plan_kind } = req.body || {};
  if (!['monthly', 'yearly', 'lifetime'].includes(plan_kind)) return res.status(400).json({ error: 'Invalid plan.' });
  if (!billing.priceFor(plan_kind)) return res.status(400).json({ error: 'That plan is not available yet.' });
  const site = await models.getOwnedSite(req.owner.id, site_id);
  if (!site) return res.status(404).json({ error: 'Site not found.' });
  try {
    const owner = await models.getOwnerById(req.owner.id);
    const customerId = await billing.ensureCustomer(owner, (cid) => models.setOwnerStripeCustomer(owner.id, cid));
    const url = await billing.createCheckout({ owner, site, planKind: plan_kind, customerId, baseUrl: billingBaseUrl(req) });
    res.json({ url });
  } catch (e) {
    console.error('[billing] checkout error:', e);
    res.status(502).json({ error: 'Could not start checkout.' });
  }
});

app.post('/api/billing/portal', auth.requireOwner, async (req, res) => {
  if (!billing.billingConfigured()) return res.status(400).json({ error: 'Billing is not configured.' });
  try {
    const owner = await models.getOwnerById(req.owner.id);
    if (!owner.stripe_customer_id) return res.status(400).json({ error: 'No billing account yet — subscribe first.' });
    const url = await billing.createPortal({ customerId: owner.stripe_customer_id, baseUrl: billingBaseUrl(req) });
    res.json({ url });
  } catch (e) {
    console.error('[billing] portal error:', e);
    res.status(502).json({ error: 'Could not open billing portal.' });
  }
});

// Webhook handler (mounted earlier with express.raw). Stripe is the source of
// truth for access — the checkout redirect never grants it.
async function handleWebhook(req, res) {
  if (!billing.billingConfigured()) return res.status(400).send('billing not configured');
  let event;
  try {
    event = billing.constructEvent(req.body, req.headers['stripe-signature']);
  } catch (e) {
    console.error('[stripe] signature verification failed:', e.message);
    return res.status(400).send('bad signature');
  }
  try {
    const fresh = await models.markStripeEvent(event.id, event.type);
    if (!fresh) return res.json({ received: true, duplicate: true }); // already handled
    await applyStripeEvent(event);
  } catch (e) {
    console.error('[stripe] handler error:', e);
    return res.status(500).send('handler error');
  }
  res.json({ received: true });
}

async function applyStripeEvent(event) {
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    const siteId = obj.client_reference_id || (obj.metadata && obj.metadata.site_id);
    if (!siteId) return;
    if (obj.mode === 'payment') {
      await models.setSitePlanByPublicId(siteId, { plan_status: 'lifetime', plan_kind: 'lifetime', current_period_end: null });
    } else if (obj.mode === 'subscription') {
      let periodEnd = null;
      const subId = obj.subscription;
      if (subId && billing.stripe) {
        try { periodEnd = billing.periodEndFromSub(await billing.stripe.subscriptions.retrieve(subId)); } catch {}
      }
      await models.setSitePlanByPublicId(siteId, {
        plan_status: 'active',
        plan_kind: (obj.metadata && obj.metadata.plan_kind) || null,
        current_period_end: periodEnd,
        stripe_subscription_id: subId || null,
      });
    }
  } else if (event.type === 'customer.subscription.updated') {
    const siteId = obj.metadata && obj.metadata.site_id;
    if (!siteId) return;
    const status = (obj.status === 'active' || obj.status === 'trialing') ? 'active'
      : (obj.status === 'past_due' || obj.status === 'unpaid') ? 'past_due' : 'canceled';
    await models.setSitePlanByPublicId(siteId, { plan_status: status, current_period_end: billing.periodEndFromSub(obj) });
  } else if (event.type === 'customer.subscription.deleted') {
    const siteId = obj.metadata && obj.metadata.site_id;
    if (siteId) await models.setSitePlanByPublicId(siteId, { plan_status: 'canceled' });
  }
}

// ---- Static files (standalone page, dashboard, embed script) ----
app.use(express.static(path.join(__dirname, 'public')));

// Clean URL for the owner dashboard.
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

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
