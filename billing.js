'use strict';

/*
 * Stripe billing. Three plans: monthly ($5) and yearly ($60) as subscriptions,
 * and lifetime ($150) as a one-time payment (Checkout mode=payment).
 *
 * Access is granted by the webhook (the single source of truth), not by the
 * checkout redirect — so a user can't self-grant by hitting the success URL.
 */

const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRICES = {
  monthly: process.env.STRIPE_PRICE_MONTHLY || '',
  yearly: process.env.STRIPE_PRICE_YEARLY || '',
  lifetime: process.env.STRIPE_PRICE_LIFETIME || '',
};

// Instantiating with a placeholder key is fine for webhook signature checks
// (constructEvent makes no API call). API calls still require a real key.
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

function billingConfigured() {
  return !!stripe;
}

function priceFor(planKind) {
  return PRICES[planKind] || '';
}

// Ensure the owner has a Stripe customer; returns the customer id. Persists it
// via the provided saver (so we don't create duplicates next time).
async function ensureCustomer(owner, saveCustomerId) {
  if (owner.stripe_customer_id) return owner.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: owner.email,
    metadata: { owner_id: String(owner.id) },
  });
  await saveCustomerId(customer.id);
  return customer.id;
}

async function createCheckout({ owner, site, planKind, customerId, baseUrl }) {
  const price = priceFor(planKind);
  if (!price) throw new Error('No Stripe price configured for ' + planKind);
  const isLifetime = planKind === 'lifetime';
  const session = await stripe.checkout.sessions.create({
    mode: isLifetime ? 'payment' : 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: site.site_id,
    // Stamp the site on the object the webhook will read.
    metadata: { site_id: site.site_id, plan_kind: planKind },
    ...(isLifetime
      ? { payment_intent_data: { metadata: { site_id: site.site_id, plan_kind: planKind } } }
      : { subscription_data: { metadata: { site_id: site.site_id, plan_kind: planKind } } }),
    success_url: baseUrl + '/dashboard?billing=success',
    cancel_url: baseUrl + '/dashboard?billing=cancelled',
  });
  return session.url;
}

async function createPortal({ customerId, baseUrl }) {
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: baseUrl + '/dashboard',
  });
  return session.url;
}

function constructEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}

// Pull current_period_end (unix secs) off a subscription object, if present.
function periodEndFromSub(sub) {
  return sub && sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
}

module.exports = {
  stripe, PRICES, billingConfigured, priceFor,
  ensureCustomer, createCheckout, createPortal, constructEvent, periodEndFromSub,
};
