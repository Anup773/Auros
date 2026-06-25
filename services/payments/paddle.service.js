'use strict';
/**
 * backend/services/payments/paddle.service.js
 *
 * CHANGES FROM V1:
 *   - WEBHOOK REPLAY PROTECTION: processed webhook IDs stored in memory
 *     Before: same webhook could be processed twice if Paddle retried
 *     After:  event IDs tracked, duplicates rejected with 200 (Paddle expects 200)
 *
 *   - TIMESTAMP VALIDATION: reject webhooks with timestamps > 5 minutes old
 *     Prevents replay attacks using captured webhook payloads
 *
 *   - SUBSCRIPTION STORE: In production replace Map with DB
 *     Added comment markers showing exactly where DB calls would go
 *
 *   - All existing logic preserved exactly
 */

const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const PADDLE_ENV     = process.env.PADDLE_ENVIRONMENT || 'sandbox';
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;

const API_BASE = PADDLE_ENV === 'production'
  ? 'https://api.paddle.com'
  : 'https://sandbox-api.paddle.com';

// ── Plans ─────────────────────────────────────────────────────────────────────
const PLANS = {
  starter: {
    id           : 'starter',
    name         : 'Starter',
    description  : 'For small teams — up to 500 invoices/month',
    price        : 19,
    currency     : 'USD',
    interval     : 'month',
    paddlePriceId: process.env.PADDLE_PRICE_STARTER || 'pri_starter_placeholder',
    features     : [
      'Up to 500 invoices/month',
      'CSV, XLSX, XML uploads',
      'AI reconciliation',
      'Voice commands',
      'Email support',
    ],
  },
  growth: {
    id           : 'growth',
    name         : 'Growth',
    description  : 'For growing teams — up to 5,000 invoices/month',
    price        : 49,
    currency     : 'USD',
    interval     : 'month',
    paddlePriceId: process.env.PADDLE_PRICE_GROWTH || 'pri_growth_placeholder',
    features     : [
      'Up to 5,000 invoices/month',
      'All Starter features',
      'PDF & image OCR',
      'WhatsApp approvals',
      'Audit trails',
      'Priority support',
    ],
  },
  enterprise: {
    id           : 'enterprise',
    name         : 'Enterprise',
    description  : 'Unlimited — custom pricing',
    price        : null,
    currency     : 'USD',
    interval     : 'month',
    paddlePriceId: null,
    features     : [
      'Unlimited invoices',
      'All Growth features',
      'Custom integrations',
      'Dedicated support',
      'SLA guarantee',
      'On-premise option',
    ],
  },
};

// ── Stores ────────────────────────────────────────────────────────────────────
// TODO production: replace both Maps with DB queries

// userId → subscription object
const subscriptionStore = new Map();

// Processed webhook event IDs — for replay protection
// TTL: 24 hours (Paddle retries within this window)
// TODO production: use Redis SET with 24h TTL
const _processedEventIds = new Map(); // eventId → processedAt timestamp
const EVENT_ID_TTL_MS    = 24 * 60 * 60 * 1000;

// Auto-cleanup old event IDs every hour
setInterval(() => {
  const now     = Date.now();
  let   removed = 0;
  for (const [id, ts] of _processedEventIds.entries()) {
    if (now - ts > EVENT_ID_TTL_MS) {
      _processedEventIds.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[paddle] Cleaned ${removed} old webhook event ID(s).`);
  }
}, 60 * 60 * 1000);

// Max age for webhook timestamps (5 minutes)
const WEBHOOK_MAX_AGE_SEC = 5 * 60;

// ── API helpers ───────────────────────────────────────────────────────────────

function _getApiKey() {
  if (!PADDLE_API_KEY) {
    throw Object.assign(
      new Error('PADDLE_API_KEY not set. Add it to your .env file.'),
      { status: 503, code: 'PADDLE_NOT_CONFIGURED' }
    );
  }
  return PADDLE_API_KEY;
}

async function _paddleRequest(method, endpoint, body = null) {
  const apiKey = _getApiKey();
  const url    = `${API_BASE}${endpoint}`;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type' : 'application/json',
    },
  };

  if (body) options.body = JSON.stringify(body);

  const res  = await fetch(url, options);
  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.detail || data?.error?.type || `Paddle API error ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, paddleError: data?.error });
  }

  return data;
}

// ── Public API ────────────────────────────────────────────────────────────────

function getPlans() {
  return Object.values(PLANS).map(plan => ({
    id          : plan.id,
    name        : plan.name,
    description : plan.description,
    price       : plan.price,
    currency    : plan.currency,
    interval    : plan.interval,
    features    : plan.features,
    isEnterprise: plan.price === null,
  }));
}

async function createCheckout(planId, userId, userEmail, returnUrl) {
  const plan = PLANS[planId];
  if (!plan) throw Object.assign(new Error(`Unknown plan: ${planId}`), { status: 400 });
  if (!plan.paddlePriceId || plan.paddlePriceId.includes('placeholder')) {
    throw Object.assign(
      new Error('Paddle price IDs not configured. Set PADDLE_PRICE_STARTER and PADDLE_PRICE_GROWTH in .env'),
      { status: 503, code: 'PADDLE_PRICES_NOT_SET' }
    );
  }

  const checkoutData = {
    items     : [{ priceId: plan.paddlePriceId, quantity: 1 }],
    customData: { userId, planId, source: 'auros_dashboard' },
    customer  : { email: userEmail },
    successUrl: `${returnUrl}?checkout=success&plan=${planId}`,
  };

  const response = await _paddleRequest('POST', '/v1/transactions', checkoutData);

  return {
    checkoutUrl  : response.data?.checkout?.url || `https://checkout.paddle.com/checkout/custom?_product=${plan.paddlePriceId}`,
    transactionId: response.data?.id,
  };
}

function getSubscription(userId) {
  const sub = subscriptionStore.get(userId);
  if (!sub) {
    return { active: false, plan: null, status: 'none', trialEnds: null, renewsAt: null };
  }
  return sub;
}

function hasActiveSubscription(userId) {
  const sub = getSubscription(userId);
  return sub.active && (sub.status === 'active' || sub.status === 'trialing');
}

async function getPortalUrl(userId) {
  const sub = subscriptionStore.get(userId);
  if (!sub?.paddleCustomerId) {
    throw Object.assign(new Error('No active subscription found'), { status: 404, code: 'NO_SUBSCRIPTION' });
  }

  const response  = await _paddleRequest('POST', `/v1/customers/${sub.paddleCustomerId}/auth-token`);
  const token     = response.data?.token;
  const portalBase = PADDLE_ENV === 'production'
    ? 'https://customer.paddle.com'
    : 'https://sandbox-customer.paddle.com';

  return `${portalBase}?token=${token}`;
}

async function cancelSubscription(userId) {
  const sub = subscriptionStore.get(userId);
  if (!sub?.paddleSubscriptionId) {
    throw Object.assign(new Error('No active subscription found'), { status: 404 });
  }

  await _paddleRequest('POST', `/v1/subscriptions/${sub.paddleSubscriptionId}/cancel`, {
    effectiveFrom: 'next_billing_period',
  });

  sub.cancelAtPeriodEnd = true;
  sub.status            = 'canceling';
  subscriptionStore.set(userId, sub);

  return { success: true, message: 'Subscription will cancel at end of billing period.' };
}

// ── Webhook Processing ────────────────────────────────────────────────────────

/**
 * Verify Paddle webhook signature.
 * CRITICAL: Without this, anyone can fake subscription events.
 *
 * CHANGE FROM V1: Added timestamp staleness check.
 * Rejects webhooks with timestamps older than WEBHOOK_MAX_AGE_SEC (5 min).
 * Prevents replay attacks using captured webhook payloads.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) {
    console.error('[paddle] PADDLE_WEBHOOK_SECRET not set — webhook verification disabled!');
    return process.env.NODE_ENV !== 'production';
  }

  if (!signatureHeader) return false;

  // Paddle signature format: ts=timestamp;h1=hash
  const parts = {};
  signatureHeader.split(';').forEach(part => {
    const [key, val] = part.split('=');
    parts[key] = val;
  });

  if (!parts.ts || !parts.h1) return false;

  // ── NEW: Timestamp staleness check ────────────────────────────────────────
  const webhookTimestamp = parseInt(parts.ts, 10);
  const nowSeconds       = Math.floor(Date.now() / 1000);
  const ageSec           = nowSeconds - webhookTimestamp;

  if (ageSec > WEBHOOK_MAX_AGE_SEC) {
    console.warn(
      `[paddle] Webhook timestamp too old: ${ageSec}s ago (max: ${WEBHOOK_MAX_AGE_SEC}s). ` +
      'Possible replay attack — rejected.'
    );
    return false;
  }

  if (ageSec < -30) {
    // Timestamp is in the future (clock skew > 30s) — suspicious
    console.warn(`[paddle] Webhook timestamp is ${-ageSec}s in the future — suspicious. Rejected.`);
    return false;
  }

  // Build signed payload: timestamp:body
  const signedPayload = `${parts.ts}:${rawBody}`;

  // Compute HMAC
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(parts.h1,  'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Process a verified Paddle webhook event.
 *
 * CHANGE FROM V1: Replay protection added.
 * If eventId was already processed, returns { alreadyProcessed: true }
 * without re-applying the event.
 */
async function processWebhookEvent(event) {
  const eventType = event.eventType || event.event_type;
  const eventId   = event.eventId   || event.event_id || event.data?.id;
  const data      = event.data;

  // ── NEW: Replay protection ────────────────────────────────────────────────
  if (eventId) {
    if (_processedEventIds.has(eventId)) {
      console.log(`[paddle] Webhook event ${eventId} already processed — skipping (replay protection).`);
      return { alreadyProcessed: true, eventId };
    }
    // Mark as processed immediately before doing any work
    // This prevents race conditions if Paddle sends the same event twice quickly
    _processedEventIds.set(eventId, Date.now());
  }

  console.log(`[paddle] Webhook: ${eventType}${eventId ? ` (${eventId})` : ''}`);

  switch (eventType) {

    case 'subscription.created':
    case 'subscription.activated': {
      const userId = data.customData?.userId || data.custom_data?.userId;
      if (!userId) { console.warn('[paddle] No userId in subscription event'); break; }

      const planId = _getPlanFromPriceId(data.items?.[0]?.price?.id);

      // TODO production: DB.upsert('subscriptions', { userId, ... })
      subscriptionStore.set(userId, {
        active               : true,
        plan                 : planId,
        status               : data.status,
        paddleSubscriptionId : data.id,
        paddleCustomerId     : data.customerId || data.customer_id,
        currentPeriodStart   : data.currentBillingPeriod?.startsAt,
        currentPeriodEnd     : data.currentBillingPeriod?.endsAt,
        renewsAt             : data.nextBilledAt || data.next_billed_at,
        cancelAtPeriodEnd    : false,
        createdAt            : data.createdAt || new Date().toISOString(),
        userId,
      });

      console.log(`[paddle] Subscription activated for user ${userId}, plan: ${planId}`);
      break;
    }

    case 'subscription.updated': {
      const userId = data.customData?.userId || data.custom_data?.userId;
      if (!userId) break;

      const existing = subscriptionStore.get(userId) || {};
      // TODO production: DB.update('subscriptions', { userId }, { status, renewsAt, plan })
      subscriptionStore.set(userId, {
        ...existing,
        status  : data.status,
        renewsAt: data.nextBilledAt || data.next_billed_at,
        plan    : _getPlanFromPriceId(data.items?.[0]?.price?.id) || existing.plan,
      });
      break;
    }

    case 'subscription.canceled': {
      const userId = data.customData?.userId || data.custom_data?.userId;
      if (!userId) break;

      const existing = subscriptionStore.get(userId) || {};
      // TODO production: DB.update('subscriptions', { userId }, { active: false, status: 'canceled' })
      subscriptionStore.set(userId, {
        ...existing,
        active     : false,
        status     : 'canceled',
        canceledAt : data.canceledAt || new Date().toISOString(),
      });
      console.log(`[paddle] Subscription canceled for user ${userId}`);
      break;
    }

    case 'subscription.past_due': {
      const userId = data.customData?.userId || data.custom_data?.userId;
      if (!userId) break;
      const existing = subscriptionStore.get(userId) || {};
      subscriptionStore.set(userId, { ...existing, status: 'past_due' });
      break;
    }

    case 'transaction.completed': {
      console.log(`[paddle] Payment completed: ${data.id}, amount: ${data.details?.totals?.grandTotal}`);
      break;
    }

    default:
      console.log(`[paddle] Unhandled event type: ${eventType}`);
  }

  return { processed: true, eventType, eventId };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _getPlanFromPriceId(priceId) {
  if (!priceId) return null;
  for (const [planId, plan] of Object.entries(PLANS)) {
    if (plan.paddlePriceId === priceId) return planId;
  }
  return null;
}

module.exports = {
  getPlans,
  createCheckout,
  getSubscription,
  hasActiveSubscription,
  getPortalUrl,
  cancelSubscription,
  verifyWebhookSignature,
  processWebhookEvent,
  subscriptionStore,
  PLANS,
};
