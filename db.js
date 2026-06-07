'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

// Create the schema on boot. One self-referencing table handles both
// top-level guestbook notes (parent_id IS NULL) and replies (parent_id set).
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      body       TEXT NOT NULL,
      parent_id  INTEGER REFERENCES notes(id) ON DELETE CASCADE,
      is_owner   BOOLEAN NOT NULL DEFAULT FALSE,
      hidden     BOOLEAN NOT NULL DEFAULT FALSE,
      ip_hash    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS notes_parent_idx ON notes (parent_id);`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS notes_created_idx ON notes (created_at DESC);`
  );
}

module.exports = { pool, init };
