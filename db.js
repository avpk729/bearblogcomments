'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

// The schema is now owned by SQL migrations (see migrations/, run via
// `npm run migrate up` as a Railway predeploy step) rather than created at
// boot. Creating tables on boot races when multiple instances start at once.
// init() just confirms the database is reachable so the healthcheck can flip
// `dbReady` true once connections work.
async function init() {
  await pool.query('SELECT 1');
}

// Thin query helper. Every comments query MUST be scoped by site_id_fk — see
// models.js for the site-scoped accessors that enforce this.
function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, init, query };
