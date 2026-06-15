# Bear Blog Comments

Private, **end-to-end-encrypted** comments and guestbooks for [Bear Blog](https://bearblog.dev)
(or any site). One hosted service serves many blogs. Visitors' comments are
encrypted in their browser to the blog owner's key and held for the owner to
review; the operator cannot read anything that hasn't been approved.

- **Backend:** Node + Express
- **Storage:** Postgres (schema via `node-pg-migrate`)
- **Crypto:** libsodium sealed boxes; owner key derived from a passphrase (Argon2id → X25519), in-browser only
- **Captcha:** Cloudflare Turnstile · **Billing:** Stripe · **Hosting:** Railway
- **Embed:** one `<script>` tag — per-post comments or a per-blog guestbook (requires an *upgraded* Bear Blog that allows custom JavaScript)

---

## How it works

```
Visitor on a blog post
   │ loads /embed.js ───────────────►  this service (Railway)
   │ encrypts {name, body} to the         ├─ GET  /api/config?site_id   public key + limits
   │ site's PUBLIC key, sends ciphertext  ├─ GET  /api/comments         published comments for a thread
   ▼                                       ├─ POST /api/comments         sealed, stored "pending"
 inline widget (published comments)        ├─ /api/sites/* (owner)       keys + moderation queue
                                           ├─ /api/billing/* + webhook   Stripe
                                           └─ Postgres (sites, comments, …)

Owner dashboard (/dashboard)
   │ magic-link sign-in (cookie session)
   │ enters passphrase → derives keypair in-browser → decrypts pending → approves
   ▼ approved comment becomes public plaintext
```

A comment is **moderate-before-publish**: it stays encrypted and invisible until
the owner approves it, at which point it's published as public plaintext.

### What the privacy guarantee means (read this)

This is **zero-access at rest**: the operator's database only ever stores
ciphertext for un-approved comments, so a database breach — or the operator
themselves — cannot read anything you haven't published. It is **not** a defense
against a malicious operator serving tampered JavaScript (the standard caveat for
all browser-delivered E2EE), and **published comments are public plaintext** by
nature. Lose your passphrase and un-approved comments are unrecoverable unless you
saved the optional recovery code.

---

## Deploy on Railway

1. Push this repo to GitHub; in Railway, **Deploy from GitHub repo**.
2. Add **PostgreSQL** (`DATABASE_URL` is injected automatically).
3. Set the variables from `.env.example` — at minimum `APP_BASE_URL`,
   `SESSION_SECRET`, `IP_HASH_SALT`, and (for real email) `SMTP_*`.
4. Migrations run automatically on deploy (`preDeployCommand` → `npm run migrate up`).
5. For captcha set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`; for billing set
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the three `STRIPE_PRICE_*` ids.

> Without Stripe keys, no site can become "active", so comments stay disabled.
> Without Turnstile keys, the captcha is skipped (fine for testing only).

### Stripe setup

- Create three Prices: monthly ($5, recurring), yearly ($60, recurring), lifetime
  ($150, one-time) → put their ids in `STRIPE_PRICE_MONTHLY/YEARLY/LIFETIME`.
- Add a webhook endpoint `https://YOUR-APP/api/stripe/webhook` for
  `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted` → copy its signing secret to `STRIPE_WEBHOOK_SECRET`.

### Cloudflare Turnstile (many domains)

One widget serves all customer blogs: **disable hostname validation** in the
Turnstile dashboard. The server validates the returned hostname against each
site's registered `domains` instead.

---

## Using it on your blog

1. Sign in at `https://YOUR-APP/dashboard` (magic link), create a site, set an
   encryption passphrase (save the recovery code!), and subscribe.
2. Paste the snippet from the dashboard. **Per-post comments** (post template):

   ```html
   <div id="comments"></div>
   <script src="https://YOUR-APP/embed.js"
           data-site-id="YOUR_SITE_ID" data-mode="post" data-target="comments"></script>
   ```

   **Per-blog guestbook** (a page):

   ```html
   <div id="guestbook"></div>
   <script src="https://YOUR-APP/embed.js"
           data-site-id="YOUR_SITE_ID" data-mode="guestbook" data-target="guestbook"></script>
   ```

   `data-mode="post"` threads by page URL; `data-thread-key="..."` pins a stable
   key if you later rename a post's slug.

3. Moderate at `/dashboard`: enter your passphrase to decrypt the queue, then
   **Approve / Reject / Delete**, or reply as the owner.

---

## Anti-spam & privacy

- Cloudflare Turnstile (verified server-side, hostname-checked), honeypot field,
  per-IP rate limit (5/min). These operate on the encrypted envelope.
- Pending backlog is bounded (`MAX_PENDING_PER_SITE`) and stale un-moderated
  comments auto-expire (`PENDING_TTL_DAYS`) — we can't read ciphertext to triage.
- IP addresses are stored only as a salted hash, never raw.

---

## Local development

```bash
cp .env.example .env          # set DATABASE_URL; leave Turnstile/Stripe blank for dev
npm install
npm run migrate up
npm run dev                   # http://localhost:3000  (dashboard at /dashboard)
```

In dev, magic-link URLs are printed to the server console, and the captcha is
skipped. The pinned libsodium build in `public/vendor/` is copied from the
`libsodium-*-sumo` npm packages; regenerate it from `node_modules` if you bump
the dependency.

## API reference

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET | `/api/config?site_id` | — | Public config: site public key, limits, accepting flag |
| GET | `/api/comments?site_id&mode&page_url` | — | Published comments for a thread |
| POST | `/api/comments` | Turnstile | Submit a sealed comment (stored pending) |
| POST | `/api/auth/magic-link` | — | Email a sign-in link |
| GET | `/api/auth/callback?token` | — | Consume link, set session |
| GET | `/api/me` | session | Owner + their sites |
| POST | `/api/sites` · PATCH `/api/sites/:id` | session | Create / update a site |
| GET/POST | `/api/sites/:id/key` | session | Get / set (rotate) the encryption key material |
| GET | `/api/sites/:id/pending` | session | Pending ciphertext for moderation |
| POST | `/api/sites/:id/comments/:cid/publish\|reject\|reply` | session | Moderate |
| DELETE | `/api/sites/:id/comments/:cid` | session | Delete |
| POST | `/api/billing/checkout` · `/api/billing/portal` | session | Stripe |
| POST | `/api/stripe/webhook` | signature | Stripe events (source of truth for access) |
