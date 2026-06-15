'use strict';

/*
 * One-time backfill of the legacy single-tenant `notes` table into the new
 * multi-tenant `comments` table, under an auto-created operator site.
 *
 * Opt-in and safe:
 *   - No-op unless OPERATOR_EMAIL is set (so fresh installs / CI skip it).
 *   - No-op if the legacy `notes` table doesn't exist.
 *   - Idempotent: skips if that operator email already owns a site.
 *
 * The legacy guestbook was a single global thread, so everything maps to one
 * guestbook thread on the operator's new site. 2-level reply threads are
 * preserved via a temporary legacy_note_id column. Hidden notes import as
 * 'rejected' (kept, not public); the rest import as 'published'.
 *
 * The legacy `notes` table is left untouched — drop it in a later migration
 * once the backfill is verified in production.
 */

const crypto = require('crypto');

exports.up = (pgm) => {
  const email = process.env.OPERATOR_EMAIL;
  if (!email) {
    // Nothing to do without an operator identity. Local/CI installs land here.
    pgm.sql('SELECT 1;');
    return;
  }

  const siteId = crypto.randomBytes(16).toString('base64url');
  const siteName = process.env.OPERATOR_SITE_NAME || 'My Blog';
  // Escape single quotes for safe inlining into the SQL string.
  const e = (s) => String(s).replace(/'/g, "''");

  pgm.sql(`
    DO $backfill$
    DECLARE
      v_owner_id   bigint;
      v_site_fk    bigint;
      v_thread_key text := 'guestbook:${e(siteId)}';
    BEGIN
      -- Legacy table must exist.
      IF to_regclass('public.notes') IS NULL THEN
        RAISE NOTICE 'backfill: no legacy notes table; skipping.';
        RETURN;
      END IF;

      -- Idempotency: if this operator already has a site, assume done.
      IF EXISTS (SELECT 1 FROM owners WHERE email = '${e(email)}') THEN
        RAISE NOTICE 'backfill: operator already exists; skipping.';
        RETURN;
      END IF;

      INSERT INTO owners (email) VALUES ('${e(email)}') RETURNING id INTO v_owner_id;

      INSERT INTO sites (owner_id, site_id, name, plan_status, plan_kind)
        VALUES (v_owner_id, '${e(siteId)}', '${e(siteName)}', 'lifetime', 'lifetime')
        RETURNING id INTO v_site_fk;

      -- Temporary column to map old note ids -> new comment ids for threading.
      ALTER TABLE comments ADD COLUMN legacy_note_id bigint;

      INSERT INTO comments
        (site_id_fk, thread_key, parent_id, status, is_owner, name, body, ip_hash,
         created_at, published_at, legacy_note_id)
        SELECT
          v_site_fk,
          v_thread_key,
          NULL,
          CASE WHEN n.hidden THEN 'rejected' ELSE 'published' END,
          n.is_owner,
          n.name,
          n.body,
          n.ip_hash,
          n.created_at,
          CASE WHEN n.hidden THEN NULL ELSE n.created_at END,
          n.id
        FROM notes n;

      -- Re-point replies at their parent's NEW id (2-level threads only).
      UPDATE comments c
        SET parent_id = p.id
        FROM notes n
        JOIN comments p ON p.legacy_note_id = n.parent_id
        WHERE c.legacy_note_id = n.id
          AND n.parent_id IS NOT NULL;

      ALTER TABLE comments DROP COLUMN legacy_note_id;

      RAISE NOTICE 'backfill: imported legacy notes into site %', '${e(siteId)}';
    END
    $backfill$;
  `);
};

exports.down = () => {
  // Irreversible data migration: leave imported rows in place.
};
