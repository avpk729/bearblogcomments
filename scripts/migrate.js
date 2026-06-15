#!/usr/bin/env node
'use strict';

/*
 * Thin wrapper around the node-pg-migrate CLI so `npm run migrate up|down|redo`
 * and `npm run migrate:make <name>` work the same locally and on Railway.
 *
 * node-pg-migrate auto-loads .env (so DATABASE_URL is picked up locally), and on
 * Railway DATABASE_URL is already in the environment. We invoke the CJS shim
 * explicitly because the migration files are CommonJS (exports.up/exports.down).
 */

require('dotenv').config();

const path = require('path');
const { spawnSync } = require('child_process');

if (!process.env.DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is not set. Add it to .env (local) or the service env (Railway).');
  process.exit(1);
}

const isWin = process.platform === 'win32';
const shim = isWin ? 'node-pg-migrate-cjs.cmd' : 'node-pg-migrate-cjs';
const bin = path.join(__dirname, '..', 'node_modules', '.bin', shim);

const result = spawnSync(bin, process.argv.slice(2), {
  stdio: 'inherit',
  shell: isWin, // needed to execute the .cmd shim on Windows
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
