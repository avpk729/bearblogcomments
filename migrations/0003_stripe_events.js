'use strict';

/*
 * Idempotency ledger for Stripe webhooks. Stripe redelivers events, so we record
 * each processed event id and skip duplicates. Survives restarts (unlike an
 * in-memory set).
 */

exports.up = (pgm) => {
  pgm.createTable('stripe_events', {
    id: { type: 'text', primaryKey: true }, // Stripe event id (evt_...)
    type: { type: 'text' },
    processed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('stripe_events');
};
