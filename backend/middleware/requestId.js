'use strict';
/**
 * backend/middleware/requestId.js
 *
 * PHASE 2 — supports "SOC2-style logging" / "Audit expansion".
 *
 * Attaches a correlation ID to every request (req.id) and echoes it back as
 * X-Request-Id. Purely additive — does not change response bodies, status
 * codes, or any existing behaviour. Mount this once, early, in app.js.
 *
 * Honors an inbound X-Request-Id (e.g. from a load balancer or API gateway)
 * when present and well-formed, so traces stay linked across hops; otherwise
 * generates a fresh UUID.
 */

const crypto = require('crypto');

const _VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;

function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = (typeof incoming === 'string' && _VALID_ID.test(incoming)) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = requestId;
