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
// FIX (production-readiness): both stores were in-memory Maps only — all
// subscription data was lost on every server restart, and webhook replay
// protection reset to empty on every restart too (so a restart right after
// a webhook could let a retried delivery double-process a payment event).
// Neither problem needed a database — this project already runs Redis for
// BullMQ, so subscriptions and processed-webhook-IDs are now persisted there
// too, using the same connection and local-cache pattern already established
// in reconciliationEngine.service.js. Falls back to the original in-memory
// Maps ONLY if Redis is genuinely unreachable, so a brief Redis outage
// degrades gracefully instead of rejecting legitimate webhooks outright.

const _localSubCache = new Map();          // userId → subscription (L1 cache)
const _localEventIds = new Map();          // eventId → processedAt (fallback only)
const EVENT_ID_TTL_MS    = 24 * 60 * 60 * 1000;
const SUB_KEY_PREFIX     = 'paddle:sub:';
const EVENT_KEY_PREFIX   = 'paddle:webhook_seen:';

let _redisClient    = null;
let _redisAvailable = false;

try {
  const { CONNECTION } = require('../../queues/jobQueue');
  const IORedis = require('ioredis');
  _redisClient = new IORedis({
    ...CONNECTION,
    lazyConnect         : false,
    enableOfflineQueue  : true,
    maxRetriesPerRequest: null,
  });
  _redisClient.on('error', (err) => {
    if (!err.message.includes('ECONNREFUSED') && !err.message.includes('connect')) {
      console.error('[paddle] Redis error:', err.message);
    }
  });
  _redisClient.on('ready', () => {
    _redisAvailable = true;
    console.log('[paddle] Redis connected — subscription + webhook state now persisted.');
  });
} catch (err) {
  console.warn('[paddle] Redis not available — subscription state will NOT survive a restart:', err.message);
}

async function _getSubscription(userId) {
  if (_redisAvailable) {
    try {
      const raw = await _redisClient.get(`${SUB_KEY_PREFIX}${userId}`);
      if (raw) {
        const sub = JSON.parse(raw);
        _localSubCache.set(userId, sub);
        return sub;
      }
      return null;
    } catch (err) {
      console.warn('[paddle] Redis read failed, using local cache:', err.message);
    }
  }
  return _localSubCache.get(userId) || null;
}

async function _setSubscription(userId, sub) {
  _localSubCache.set(userId, sub);  // always keep the local cache warm
  if (_redisAvailable) {
    try {
      // No TTL — subscription state is intentionally durable, not a cache entry.
      await _redisClient.set(`${SUB_KEY_PREFIX}${userId}`, JSON.stringify(sub));
    } catch (err) {
      console.error('[paddle] CRITICAL: failed to persist subscription for', userId, ':', err.message);
    }
  }
}

async function _hasProcessedEvent(eventId) {
  if (_redisAvailable) {
    try {
      // Atomic check-and-mark: SET ... NX fails (returns null) if the key
      // already exists, closing the race a separate GET-then-SET would have
      // if two webhook deliveries for the same event arrive close together.
      const result = await _redisClient.set(
        `${EVENT_KEY_PREFIX}${eventId}`, '1', 'EX', Math.floor(EVENT_ID_TTL_MS / 1000), 'NX'
      );
      return result === null;  // null = key already existed = already processed
    } catch (err) {
      console.warn('[paddle] Redis dedup check failed, using local fallback:', err.message);
    }
  }
  // Local fallback (single-process only — not safe across multiple instances)
  if (_localEventIds.has(eventId)) return true;
  _localEventIds.set(eventId, Date.now());
  return false;
}

// Local-cache cleanup (only matters when Redis is unavailable and this Map
// is the sole store — Redis entries expire themselves via EX above)
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of _localEventIds.entries()) {
    if (now - ts > EVENT_ID_TTL_MS) _localEventIds.delete(id);
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

async function getSubscription(userId) {
  const sub = await _getSubscription(userId);
  if (!sub) {
    return { active: false, plan: null, status: 'none', trialEnds: null, renewsAt: null };
  }
  return sub;
}

async function hasActiveSubscription(userId) {
  const sub = await getSubscription(userId);
  return sub.active && (sub.status === 'active' || sub.status === 'trialing');
}

async function getPortalUrl(userId) {
  const sub = await _getSubscription(userId);
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
  const sub = await _getSubscription(userId);
  if (!sub?.paddleSubscriptionId) {
    throw Object.assign(new Error('No active subscription found'), { status: 404 });
  }

  await _paddleRequest('POST', `/v1/subscriptions/${sub.paddleSubscriptionId}/cancel`, {
    effectiveFrom: 'next_billing_period',
  });

  sub.cancelAtPeriodEnd = true;
  sub.status            = 'canceling';
  await _setSubscription(userId, sub);

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

  // ── Replay protection (now atomic + persisted across restarts/instances) ──
  if (eventId) {
    const alreadyProcessed = await _hasProcessedEvent(eventId);
    if (alreadyProcessed) {
      console.log(`[paddle] Webhook event ${eventId} already processed — skipping (replay protection).`);
      return { alreadyProcessed: true, eventId };
    }
  }

  console.log(`[paddle] Webhook: ${eventType}${eventId ? ` (${eventId})` : ''}`);

  switch (eventType) {

    case 'subscription.created':
    case 'subscription.activated': {
      const userId = data.customData?.userId || data.custom_data?.userId;
      if (!userId) { console.warn('[paddle] No userId in subscription event'); break; }

      const planId = _getPlanFromPriceId(data.items?.[0]?.price?.id);

      await _setSubscription(userId, {
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

      const existing = await _getSubscription(userId) || {};
      await _setSubscription(userId, {
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

      const existing = await _getSubscription(userId) || {};
      await _setSubscription(userId, {
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
      const existing = await _getSubscription(userId) || {};
      await _setSubscription(userId, { ...existing, status: 'past_due' });
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
  PLANS,
};