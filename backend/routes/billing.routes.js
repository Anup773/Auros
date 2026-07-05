'use strict';
/**
 * backend/routes/billing.routes.js
 *
 * Paddle billing endpoints.
 *
 * Routes:
 *   GET  /api/billing/plans        — list available plans (public)
 *   POST /api/billing/checkout     — create checkout session
 *   GET  /api/billing/subscription — get current user subscription
 *   GET  /api/billing/portal       — get customer portal URL
 *   POST /api/billing/cancel       — cancel subscription
 *   POST /api/billing/webhook      — Paddle webhook (NO auth — verified by signature)
 */

const express    = require('express');
const router     = express.Router();
const { requireAuth } = require('../controllers/auth.controller');
const paddle     = require('../services/payments/paddle.service');

// ── GET /api/billing/plans ────────────────────────────────────────────────────
// Public — no auth needed to see pricing
router.get('/plans', (req, res) => {
  res.json({ plans: paddle.getPlans() });
});

// ── POST /api/billing/checkout ────────────────────────────────────────────────
router.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    const { planId } = req.body;
    if (!planId) {
      return res.status(400).json({ error: 'planId is required', code: 'MISSING_FIELD' });
    }

    const returnUrl  = process.env.FRONTEND_URL || 'http://localhost:3000';
    const { checkoutUrl, transactionId } = await paddle.createCheckout(
      planId,
      req.user.id,
      req.user.email,
      `${returnUrl}/dashboard?tab=billing`,
    );

    res.json({ checkoutUrl, transactionId });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/billing/subscription ─────────────────────────────────────────────
router.get('/subscription', requireAuth, async (req, res, next) => {
  try {
    const sub = await paddle.getSubscription(req.user.id);
    res.json({ subscription: sub });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/billing/portal ───────────────────────────────────────────────────
router.get('/portal', requireAuth, async (req, res, next) => {
  try {
    const portalUrl = await paddle.getPortalUrl(req.user.id);
    res.json({ portalUrl });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/billing/cancel ──────────────────────────────────────────────────
router.post('/cancel', requireAuth, async (req, res, next) => {
  try {
    const result = await paddle.cancelSubscription(req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/billing/webhook ─────────────────────────────────────────────────
// CRITICAL: No auth middleware — Paddle calls this directly.
// Verified by HMAC signature instead.
// Must receive raw body — use express.raw() middleware for this route.
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),  // raw body for signature verification
  async (req, res) => {
    const signature = req.headers['paddle-signature'];
    const rawBody   = req.body.toString('utf8');

    // ── SECURITY: Verify signature before processing ───────────────────────
    const isValid = paddle.verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      console.warn('[billing] Webhook signature verification FAILED — rejected');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON in webhook body' });
    }

    // Always respond 200 quickly — process async
    res.status(200).json({ received: true });

    // Process event after responding (non-blocking)
    paddle.processWebhookEvent(event).catch(err => {
      console.error('[billing] Webhook processing error:', err.message);
    });
  }
);

module.exports = router;