'use strict';
/**
 * backend/routes/ai.routes.js  — V3
 *
 * CHANGES FROM V2:
 *
 * HIGH FIX — AUTHENTICATION REQUIRED ON ALL AI ENDPOINTS
 *   Old: Both routes were completely unauthenticated — any anonymous caller
 *        could hit /api/ai/interpret or /api/ai/generate-questions without a token.
 *        Risk: LLM cost explosion, prompt flooding, and API key abuse.
 *        A single malicious actor could generate unbounded Gemini API calls at
 *        the operator's expense with no rate-limit attribution.
 *   New: requireAuth middleware added to BOTH routes before the controller.
 *        Anonymous requests now receive 401 before any AI code runs.
 *        Combined with the aiLimiter applied in app.js at the /api/ai prefix
 *        level, this provides two layers: authentication + rate limiting.
 *
 * PRESERVED FROM V2:
 *   - Route paths unchanged (/interpret, /generate-questions)
 *   - Controller method names unchanged (interpretResponse, generateQuestions)
 */

const express      = require('express');
const router       = express.Router();
const { requireAuth } = require('../controllers/auth.controller');
const aiController = require('../controllers/ai.controller');

// POST /api/ai/interpret
// HIGH FIX: requireAuth added — prevents unauthenticated LLM cost abuse
router.post('/interpret',
  requireAuth,
  aiController.interpretResponse,
);

// POST /api/ai/generate-questions
// HIGH FIX: requireAuth added — prevents unauthenticated LLM cost abuse
router.post('/generate-questions',
  requireAuth,
  aiController.generateQuestions,
);

module.exports = router;