'use strict';
/**
 * backend/controllers/ai.controller.js  — V3
 *
 * CHANGES FROM V2 (this version — V3):
 *
 * CRITICAL FIX #1 — VARIABLE SHADOWING / TEMPORAL DEAD ZONE CRASH
 *   Old: const model = genAI().getGenerativeModel({ model, ... })
 *        The declaration `const model = ...` referenced `model` inside its own
 *        initialiser, triggering a JavaScript Temporal Dead Zone ReferenceError.
 *        Every request to /api/ai/interpret crashed immediately.
 *   New: Module-level constant renamed to MODEL_NAME = 'gemini-2.0-flash'.
 *        The local variable uses a different name: `const geminiModel = ...`
 *        and passes `model: MODEL_NAME` explicitly. No more self-reference.
 *
 * CRITICAL FIX #2 — DATASET NULL CRASH
 *   Old: const dataset = getDataset(datasetId) assumed getDataset always throws
 *        on missing IDs. If a future implementation returns null instead,
 *        accessing dataset.columns crashed with "Cannot read property 'columns'
 *        of undefined/null".
 *   New: Explicit null-check after getDataset() with a structured 404 response.
 *
 * CRITICAL FIX #3 — AI REQUEST TIMEOUT
 *   Old: await model.generateContent(...) had no timeout — a Gemini outage or
 *        slow response kept the Node worker occupied indefinitely, eventually
 *        exhausting the connection pool.
 *   New: _callGemini() wraps generateContent in Promise.race() against a
 *        _timeoutPromise(AI_TIMEOUT_MS). Default: 30 000 ms (configurable via
 *        env AI_TIMEOUT_MS). On timeout, a structured 504 error is thrown.
 *
 * HIGH FIX #4 — INPUT SIZE LIMITS
 *   Old: userResponse and issue accepted any size — a 100 MB userResponse would
 *        build a massive prompt, spike memory, and run up the Gemini bill.
 *   New: MAX_USER_RESPONSE_CHARS (default: 2 000) and MAX_ISSUE_JSON_CHARS
 *        (default: 5 000) enforced before prompt assembly. Excess is rejected
 *        with a 400 error describing the limit.
 *
 * HIGH FIX #5 — COLUMN COUNT LIMIT IN PROMPT
 *   Old: JSON.stringify(columns) with 50 000 columns produced an enormous prompt,
 *        caused Gemini token-limit failures, and spiked memory.
 *   New: columns sliced to MAX_PROMPT_COLUMNS (default: 500) before
 *        JSON.stringify. A note is appended to the prompt when columns are
 *        truncated so the model knows the list is partial.
 *
 * MEDIUM FIX #6 — AI RESPONSE SCHEMA VALIDATION (prompt injection defence)
 *   Old: _parseJson(raw) trusted any JSON the model returned. A prompt-injected
 *        response of {"action":"deleteDatabase"} would be passed downstream.
 *   New: _validateAiAction(parsed) checks that:
 *        - action is one of the whitelisted values
 *        - column (if present) is a string, not an executable
 *        - confidence is a number 0-100
 *        - risk is "Low" | "Medium" | "High"
 *        Invalid responses throw a 422 error rather than being forwarded.
 *        For generateQuestions, each element is validated for issueIndex (number)
 *        and question (non-empty string).
 *
 * MEDIUM FIX #7 — EXPONENTIAL BACKOFF WITH JITTER (retry storm prevention)
 *   Old: await _sleep(500 * (attempt + 1)) — linear backoff. Under a Gemini
 *        outage, 100 concurrent requests each retried at 500ms / 1000ms /
 *        1500ms, producing a coordinated burst (retry storm).
 *   New: _backoffMs(attempt) = min(base * 2^attempt + jitter, MAX_BACKOFF_MS)
 *        where jitter = random(0, 500). Each client backs off at a different
 *        time, spreading retries across a wider window.
 *
 * PRESERVED FROM V2:
 *   - exports.interpretResponse  (method name unchanged)
 *   - exports.generateQuestions  (method name unchanged)
 *   - getAiService() lazy-load with fallback to inline implementation
 *   - getDataset() call to pass column context to AI
 */

const { getDataset } = require('./data.controller');

// ── Constants ─────────────────────────────────────────────────────────────────
// FIX #1: Renamed from MODEL to MODEL_NAME — prevents variable shadowing in _callGemini
const MODEL_NAME    = 'gemini-2.0-flash';
const MAX_TOKENS    = 1_024;
const MAX_RETRIES   = 2;

// FIX #3: Request timeout
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '30000', 10);

// FIX #4: Input size limits
const MAX_USER_RESPONSE_CHARS = parseInt(process.env.MAX_USER_RESPONSE_CHARS || '2000',  10);
const MAX_ISSUE_JSON_CHARS    = parseInt(process.env.MAX_ISSUE_JSON_CHARS    || '5000',  10);
const MAX_ISSUES_PER_REQUEST  = parseInt(process.env.MAX_ISSUES_PER_REQUEST  || '100',   10);

// FIX #5: Column count limit in prompt
const MAX_PROMPT_COLUMNS = parseInt(process.env.MAX_PROMPT_COLUMNS || '500', 10);

// FIX #7: Backoff config
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS  = 10_000;

// FIX #6: Whitelisted AI action values
const ALLOWED_AI_ACTIONS = new Set([
  'removeNulls', 'fillMissing', 'deduplicate', 'formatDates',
  'flagForReview', 'keepAsIs', 'custom',
]);

// ── Lazy-load AI service ──────────────────────────────────────────────────────
function getAiService() {
  try {
    return require('../services/ai/ai.service');
  } catch (_) {
    return null;
  }
}

// ── Inline Gemini client ──────────────────────────────────────────────────────
const { GoogleGenerativeAI } = require('@google/generative-ai');

let _genAI = null;
function genAI() {
  if (!_genAI) {
    if (!process.env.GEMINI_API_KEY) {
      throw Object.assign(
        new Error('GEMINI_API_KEY is not set. Add it to your .env file.'),
        { status: 503, code: 'AI_NOT_CONFIGURED' }
      );
    }
    _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return _genAI;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/ai/interpret
exports.interpretResponse = async (req, res, next) => {
  try {
    const { datasetId, issue, userResponse } = req.body;

    if (!datasetId || !issue || !userResponse) {
      return res.status(400).json({
        error: 'Missing required fields: datasetId, issue, userResponse',
        code : 'MISSING_FIELDS',
      });
    }

    // FIX #4: Input size limits
    if (typeof userResponse === 'string' && userResponse.length > MAX_USER_RESPONSE_CHARS) {
      return res.status(400).json({
        error: `userResponse too long (${userResponse.length} chars). Maximum: ${MAX_USER_RESPONSE_CHARS}.`,
        code : 'INPUT_TOO_LONG',
      });
    }
    const issueJson = typeof issue === 'string' ? issue : JSON.stringify(issue);
    if (issueJson.length > MAX_ISSUE_JSON_CHARS) {
      return res.status(400).json({
        error: `issue too large (${issueJson.length} chars). Maximum: ${MAX_ISSUE_JSON_CHARS}.`,
        code : 'INPUT_TOO_LONG',
      });
    }

    // FIX #2: Explicit null-check — getDataset may return null in future implementations
    const dataset = getDataset(datasetId);
    if (!dataset) {
      return res.status(404).json({ error: 'Dataset not found', code: 'DATASET_NOT_FOUND' });
    }

    const aiService = getAiService();
    let action;

    if (aiService && typeof aiService.interpretUserIntent === 'function') {
      action = await aiService.interpretUserIntent({
        issue,
        userResponse,
        columns : dataset.columns,
        rowCount: dataset.rows ? dataset.rows.length : 0,
      });
    } else {
      action = await _interpretInline(issue, userResponse, dataset.columns);
    }

    res.json({ action });
  } catch (err) {
    next(err);
  }
};

// POST /api/ai/generate-questions
exports.generateQuestions = async (req, res, next) => {
  try {
    const { datasetId, issues } = req.body;

    if (!datasetId || !Array.isArray(issues)) {
      return res.status(400).json({
        error: 'Missing required fields: datasetId, issues[]',
        code : 'MISSING_FIELDS',
      });
    }

    // FIX #4: Limit number of issues per request
    if (issues.length > MAX_ISSUES_PER_REQUEST) {
      return res.status(400).json({
        error: `Too many issues (${issues.length}). Maximum per request: ${MAX_ISSUES_PER_REQUEST}.`,
        code : 'TOO_MANY_ISSUES',
      });
    }

    // FIX #2: Explicit null-check
    const dataset = getDataset(datasetId);
    if (!dataset) {
      return res.status(404).json({ error: 'Dataset not found', code: 'DATASET_NOT_FOUND' });
    }

    const aiService = getAiService();
    let questions;

    if (aiService && typeof aiService.generateQuestionsForIssues === 'function') {
      questions = await aiService.generateQuestionsForIssues(issues, dataset.columns);
    } else {
      questions = await _generateQuestionsInline(issues, dataset.columns);
    }

    res.json({ questions });
  } catch (err) {
    next(err);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// INLINE GEMINI IMPLEMENTATIONS
// ══════════════════════════════════════════════════════════════════════════════

async function _interpretInline(issue, userResponse, columns) {
  // FIX #5: Slice columns to avoid token-limit failures and memory spikes
  const columnsSafe   = Array.isArray(columns) ? columns.slice(0, MAX_PROMPT_COLUMNS) : [];
  const colsTruncated = Array.isArray(columns) && columns.length > MAX_PROMPT_COLUMNS;

  const systemPrompt = `You are a data cleaning assistant. Interpret the user's instruction and return a structured JSON action.
RULES:
- Return ONLY valid JSON. No markdown. No extra text. No code fences.
- Never invent column names. Use only names from the columns list.
- confidence: 0-100 integer. risk: "Low"|"Medium"|"High".
- action MUST be one of: removeNulls|fillMissing|deduplicate|formatDates|flagForReview|keepAsIs|custom.
- Do NOT include executable code, system paths, or commands in any field.
Return: { "action":"", "column":"", "parameters":{}, "confidence":0, "risk":"Low", "explanation":"" }`;

  const userPrompt = [
    `Columns: ${JSON.stringify(columnsSafe)}`,
    colsTruncated ? `(Note: column list truncated to ${MAX_PROMPT_COLUMNS} of ${columns.length} total)` : '',
    `Issue: ${JSON.stringify(issue)}`,
    `User instruction: "${userResponse}"`,
    'Return the JSON action.',
  ].filter(Boolean).join('\n');

  const raw    = await _callGemini(systemPrompt, userPrompt);
  const parsed = _parseJson(raw);

  // FIX #6: Validate AI response schema before forwarding downstream
  _validateAiAction(parsed, columnsSafe);
  return parsed;
}

async function _generateQuestionsInline(issues, columns) {
  // FIX #5: Slice columns
  const columnsSafe   = Array.isArray(columns) ? columns.slice(0, MAX_PROMPT_COLUMNS) : [];
  const colsTruncated = Array.isArray(columns) && columns.length > MAX_PROMPT_COLUMNS;

  const systemPrompt = `You are a data cleaning assistant. Generate one clear question per data issue.
RULES:
- Return ONLY a JSON array. No markdown. No extra text.
- Each element: { "issueIndex": number, "question": "string" }
- Plain English, friendly, specific to each issue.
- Do NOT include executable code or system commands in any field.`;

  const userPrompt = [
    `Columns: ${JSON.stringify(columnsSafe)}`,
    colsTruncated ? `(Note: column list truncated to ${MAX_PROMPT_COLUMNS})` : '',
    `Generate questions for these ${issues.length} issue(s):`,
    JSON.stringify(issues, null, 2),
    'Return the JSON array.',
  ].filter(Boolean).join('\n');

  const raw    = await _callGemini(systemPrompt, userPrompt);
  const parsed = _parseJson(raw);
  const result = Array.isArray(parsed) ? parsed : (parsed.questions || []);

  // FIX #6: Validate each generated question
  _validateAiQuestions(result);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// GEMINI CALL (FIX #1 / FIX #3 / FIX #7)
// ══════════════════════════════════════════════════════════════════════════════

async function _callGemini(systemPrompt, userPrompt) {
  // FIX #1: renamed local variable to `geminiModel` — no shadowing of MODULE constant
  const geminiModel = genAI().getGenerativeModel({
    model            : MODEL_NAME,   // FIX #1: explicit property name, references renamed constant
    systemInstruction: systemPrompt,
    generationConfig : {
      responseMimeType: 'application/json',
      temperature     : 0.1,
      maxOutputTokens : MAX_TOKENS,
    },
  });

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // FIX #3: Wrap in Promise.race with a timeout
      const text = await Promise.race([
        geminiModel.generateContent(userPrompt).then(r => {
          const t = r.response.text();
          if (!t) throw new Error('Gemini returned empty response');
          return t;
        }),
        _timeoutPromise(AI_TIMEOUT_MS),
      ]);
      return text;
    } catch (err) {
      lastErr = err;
      // Don't retry on timeout — the remote end is already overwhelmed
      if (err.code === 'AI_TIMEOUT') break;
      if (attempt < MAX_RETRIES) {
        // FIX #7: Exponential backoff with jitter to prevent retry storm
        await _sleep(_backoffMs(attempt));
      }
    }
  }

  const isTimeout = lastErr?.code === 'AI_TIMEOUT';
  throw Object.assign(
    new Error(
      isTimeout
        ? `Gemini request timed out after ${AI_TIMEOUT_MS}ms. Please try again.`
        : `Gemini API failed after ${MAX_RETRIES + 1} attempts: ${lastErr.message}`
    ),
    { status: isTimeout ? 504 : 502, code: isTimeout ? 'AI_TIMEOUT' : 'AI_UPSTREAM_ERROR' }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEMA VALIDATION (FIX #6)
// ══════════════════════════════════════════════════════════════════════════════

function _validateAiAction(parsed, allowedColumns) {
  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(new Error('AI returned non-object response'), { status: 422, code: 'AI_INVALID_SCHEMA' });
  }

  // Whitelist check on action
  if (!ALLOWED_AI_ACTIONS.has(parsed.action)) {
    throw Object.assign(
      new Error(
        `AI returned disallowed action "${parsed.action}". ` +
        `Allowed: ${[...ALLOWED_AI_ACTIONS].join(', ')}.`
      ),
      { status: 422, code: 'AI_INVALID_ACTION' }
    );
  }

  // Column must be a plain string (not executable)
  if (parsed.column !== undefined && parsed.column !== null) {
    if (typeof parsed.column !== 'string') {
      throw Object.assign(new Error('AI returned non-string column'), { status: 422, code: 'AI_INVALID_SCHEMA' });
    }
    // Reject if column contains characters that suggest code injection
    if (/[;`$(){}[\]<>]/.test(parsed.column)) {
      throw Object.assign(new Error('AI returned suspicious column value'), { status: 422, code: 'AI_INVALID_SCHEMA' });
    }
  }

  // confidence must be a number 0-100
  if (parsed.confidence !== undefined) {
    const c = Number(parsed.confidence);
    if (isNaN(c) || c < 0 || c > 100) {
      parsed.confidence = 50;  // sanitise rather than reject — non-critical field
    }
  }

  // risk must be one of the allowed values
  if (!['Low', 'Medium', 'High'].includes(parsed.risk)) {
    parsed.risk = 'Medium';  // sanitise
  }

  // parameters must be a plain object (not array / function / string)
  if (parsed.parameters !== undefined && (
    typeof parsed.parameters !== 'object' ||
    Array.isArray(parsed.parameters) ||
    parsed.parameters === null
  )) {
    parsed.parameters = {};  // sanitise
  }
}

function _validateAiQuestions(questions) {
  if (!Array.isArray(questions)) {
    throw Object.assign(new Error('AI returned non-array for questions'), { status: 422, code: 'AI_INVALID_SCHEMA' });
  }
  for (const q of questions) {
    if (typeof q.issueIndex !== 'number' || isNaN(q.issueIndex)) {
      throw Object.assign(new Error('AI question missing numeric issueIndex'), { status: 422, code: 'AI_INVALID_SCHEMA' });
    }
    if (typeof q.question !== 'string' || !q.question.trim()) {
      throw Object.assign(new Error('AI question missing non-empty question string'), { status: 422, code: 'AI_INVALID_SCHEMA' });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function _parseJson(text) {
  try {
    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    throw Object.assign(
      new Error(`AI returned invalid JSON: ${e.message}`),
      { status: 422, code: 'AI_INVALID_JSON' }
    );
  }
}

function _timeoutPromise(ms) {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(Object.assign(new Error(`AI request timed out after ${ms}ms`), { code: 'AI_TIMEOUT' })),
      ms
    )
  );
}

/**
 * FIX #7: Exponential backoff with random jitter.
 * Prevents the retry storm where all in-flight requests retry at the same time.
 */
function _backoffMs(attempt) {
  const base   = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(base + jitter, MAX_BACKOFF_MS);
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

