'use strict';

/*
 * Initial multi-tenant schema for the E2EE comments service.
 *
 * Owners log in by magic link (sessions). Each owner has one or more sites; a
 * site carries a public, unguessable site_id that appears in the embed snippet.
 * Comments are scoped to (site_id_fk, thread_key) and stored as ciphertext until
 * the owner decrypts and publishes them. site_keys keeps a version history so a
 * passphrase can be rotated without losing old pending ciphertext.
 */

exports.up = (pgm) => {
  pgm.createExtension('citext', { ifNotExists: true });

  const id = { type: 'bigserial', primaryKey: true };
  const createdAt = { type: 'timestamptz', notNull: true, default: pgm.func('now()') };

  pgm.createTable('owners', {
    id,
    email: { type: 'citext', notNull: true, unique: true },
    stripe_customer_id: { type: 'text' },
    created_at: createdAt,
    last_login_at: { type: 'timestamptz' },
  });

  pgm.createTable('magic_links', {
    id,
    owner_id: { type: 'bigint', notNull: true, references: 'owners', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: createdAt,
  });
  pgm.createIndex('magic_links', 'token_hash');

  pgm.createTable('sessions', {
    id,
    owner_id: { type: 'bigint', notNull: true, references: 'owners', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: createdAt,
  });
  pgm.createIndex('sessions', 'token_hash');

  pgm.createTable('sites', {
    id,
    owner_id: { type: 'bigint', notNull: true, references: 'owners', onDelete: 'CASCADE' },
    site_id: { type: 'text', notNull: true, unique: true }, // PUBLIC, unguessable
    name: { type: 'text', notNull: true },
    domains: { type: 'text[]', notNull: true, default: '{}' },
    plan_status: { type: 'text', notNull: true, default: 'unpaid' }, // unpaid|active|past_due|lifetime|canceled
    plan_kind: { type: 'text' }, // monthly|yearly|lifetime
    current_period_end: { type: 'timestamptz' },
    stripe_subscription_id: { type: 'text' },
    max_body_length: { type: 'integer', notNull: true, default: 280 },
    max_name_length: { type: 'integer', notNull: true, default: 50 },
    created_at: createdAt,
  });
  pgm.createIndex('sites', 'owner_id');

  pgm.createTable('site_keys', {
    id,
    site_id_fk: { type: 'bigint', notNull: true, references: 'sites', onDelete: 'CASCADE' },
    version: { type: 'integer', notNull: true },
    public_key: { type: 'text', notNull: true }, // base64 X25519 public key
    salt: { type: 'text', notNull: true }, // base64 Argon2 salt
    kdf_algo: { type: 'text', notNull: true, default: 'argon2id13' },
    kdf_opslimit: { type: 'integer', notNull: true },
    kdf_memlimit: { type: 'bigint', notNull: true },
    created_at: createdAt,
    retired_at: { type: 'timestamptz' }, // null = current key
  });
  pgm.addConstraint('site_keys', 'site_keys_site_version_unique', {
    unique: ['site_id_fk', 'version'],
  });

  pgm.createTable('comments', {
    id,
    site_id_fk: { type: 'bigint', notNull: true, references: 'sites', onDelete: 'CASCADE' },
    thread_key: { type: 'text', notNull: true },
    parent_id: { type: 'bigint', references: 'comments', onDelete: 'CASCADE' },
    status: { type: 'text', notNull: true, default: 'pending' }, // pending|published|rejected
    is_owner: { type: 'boolean', notNull: true, default: false },
    ciphertext: { type: 'text' }, // base64 sealed {name,body}; nulled once published
    key_version: { type: 'integer' },
    name: { type: 'text' }, // filled at approval (plaintext)
    body: { type: 'text' },
    ip_hash: { type: 'text' },
    created_at: createdAt,
    published_at: { type: 'timestamptz' },
  });
  pgm.createIndex('comments', ['site_id_fk', 'thread_key', 'status', 'created_at']);
  pgm.createIndex('comments', ['site_id_fk', 'status']);
  pgm.createIndex('comments', 'parent_id');
};

exports.down = (pgm) => {
  pgm.dropTable('comments');
  pgm.dropTable('site_keys');
  pgm.dropTable('sites');
  pgm.dropTable('sessions');
  pgm.dropTable('magic_links');
  pgm.dropTable('owners');
  // Leave the citext extension in place; other objects may rely on it.
};
