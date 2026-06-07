# Bear Blog Guestbook

A tiny, self-hosted guestbook for a [Bear Blog](https://bearblog.dev) (or any
site). Visitors leave short, plain-text notes with their name, pass a Cloudflare
Turnstile human check, and can reply to each other. As the owner you get an
admin panel to **reply** and **delete/hide** notes.

- **Backend:** Node + Express
- **Storage:** Postgres
- **Captcha:** Cloudflare Turnstile (free, privacy-friendly)
- **Hosting:** Railway (one service + a Postgres plugin)
- **Embedding:** a single `<script>` tag renders the guestbook inline on your
  blog (requires an *upgraded* Bear Blog, which allows custom JavaScript). A
  standalone page is also served at `/` if you'd rather just link to it.

---

## How it works

```
Visitor on curiously.bearblog.dev
        │  loads /embed.js  ──────────────►  Railway app (this repo)
        │  fetch() API calls (CORS)          ├─ GET  /api/notes      list
        ▼                                     ├─ POST /api/notes      create (Turnstile + rate limit)
  inline guestbook widget                     ├─ /api/admin/*         moderation (token-gated)
                                              └─ Postgres (notes table)
```

A single self-referencing `notes` table stores both top-level notes
(`parent_id IS NULL`) and replies. Threads are capped at two levels: replying to
a reply attaches to the original note. Deletes are **soft** (a `hidden` flag) so
you can restore, with a permanent purge available too.

---

## Deploy on Railway

1. **Push this repo to GitHub** (already done if you're reading this there).
2. In Railway: **New Project → Deploy from GitHub repo** → pick this repo.
3. Add Postgres: **New → Database → Add PostgreSQL**. Railway injects
   `DATABASE_URL` into your service automatically.
4. Set these **Variables** on the service (see `.env.example`):
   - `ADMIN_TOKEN` — a long random string. Generate one:
     ```
     node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
     ```
   - `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` — from Cloudflare (below).
   - `ALLOWED_ORIGINS` — `https://curiously.bearblog.dev`
   - (optional) `MAX_BODY_LENGTH` (default `280`), `MAX_NAME_LENGTH` (default `50`).
5. Railway builds with Nixpacks and runs `npm start`. The table is created
   automatically on first boot.
6. Note your public URL, e.g. `https://your-app.up.railway.app`.

The table is created automatically — no migration step needed.

---

## Set up Cloudflare Turnstile (the human check)

1. Go to the [Turnstile dashboard](https://dash.cloudflare.com/?to=/:account/turnstile)
   (free Cloudflare account).
2. **Add a site/widget.** Under hostnames add **both**:
   - `curiously.bearblog.dev` (where the widget is embedded)
   - `your-app.up.railway.app` (the standalone page)
3. Copy the **Site Key** → `TURNSTILE_SITE_KEY` and the **Secret Key** →
   `TURNSTILE_SECRET_KEY` in Railway.

> If you leave these blank, the captcha is skipped — fine for local testing,
> not recommended in production.

---

## Add it to your Bear Blog

Your blog is upgraded, so you can use custom JavaScript. Create a new **page**
called **Guest Book** and put this in the body:

```html
<div id="guestbook"></div>
<script src="https://your-app.up.railway.app/embed.js" data-target="guestbook"></script>
```

That's it — the form and notes render right on the page, styled to inherit your
theme's fonts/colors. Replace `your-app.up.railway.app` with your real Railway
domain.

**Prefer to just link out?** Skip the script and link a button to
`https://your-app.up.railway.app/`, which serves the full guestbook standalone.

---

## Moderate

Go to `https://your-app.up.railway.app/admin`, paste your `ADMIN_TOKEN`, and
click **Load**. You can:

- **Reply** to any note as the owner (shows an "owner" badge).
- **Hide** a note (soft-delete; replies hide with it) and **Restore** it later.
- **Delete** permanently.

The token is stored only in your browser's localStorage. The admin page is
`noindex`. Keep your token secret — anyone with it can moderate.

---

## Anti-spam layers

- Cloudflare Turnstile, verified server-side.
- Honeypot field (bots fill it, humans don't).
- Per-IP rate limit (5 posts/minute).
- Server-enforced length limits; plain text only, HTML-escaped on render (no XSS).
- IPs are stored only as a salted hash, never raw.

---

## Local development

```bash
cp .env.example .env       # fill in DATABASE_URL and ADMIN_TOKEN at minimum
npm install
npm run dev                # http://localhost:3000  (admin at /admin)
```

Leave the Turnstile keys blank locally to skip the captcha while testing.

## API reference

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET | `/api/config` | — | Public config for the widget (site key, limits) |
| GET | `/api/notes` | — | List visible notes + replies |
| POST | `/api/notes` | Turnstile | Create a note or reply |
| GET | `/api/admin/notes` | token | List all notes incl. hidden |
| POST | `/api/admin/notes/:id/reply` | token | Owner reply |
| DELETE | `/api/admin/notes/:id` | token | Hide (soft-delete) |
| POST | `/api/admin/notes/:id/restore` | token | Unhide |
| DELETE | `/api/admin/notes/:id/purge` | token | Permanent delete |

Admin requests send the token in the `X-Admin-Token` header.
