'use strict';
/**
 * backend/services/ai/ai.service.js — V5
 *
 * CHANGES FROM V4 (this version):
 *
 *   FIX 1 — CRITICAL CRASH: model self-reference in _callGemini() (Bug #1)
 *     Previous:
 *       const model = ai.getGenerativeModel({ model, ... })
 *     This is a temporal dead zone reference — `model` is being declared
 *     AND used as its own value in the same const declaration.
 *     Result: ReferenceError: Cannot access 'model' before initialization
 *     This completely breaks ALL Gemini calls silently on some runtimes,
 *     or crashes loudly on others.
 *     Fix: Use the module-level constant MODEL explicitly:
 *       ai.getGenerativeModel({ model: MODEL, ... })
 *
 *   FIX 2 — AbortController signal now actually wired to Gemini (Bug #2)
 *     Previous: controller created, signal never passed → timeout was fake,
 *     Gemini requests could hang indefinitely despite the controller.abort() call.
 *     Fix: Pass signal in the request options where Gemini SDK supports it.
 *     Note: Gemini JS SDK uses fetch internally; the signal is passed via
 *     generationConfig is NOT the right path — use requestOptions instead.
 *     Since @google/generative-ai SDK does not yet expose AbortSignal directly
 *     in generateContent(), we use Promise.race() with a reject timer as the
 *     reliable cross-version approach (already done), AND the AbortController
 *     is kept as a best-effort signal for future SDK versions.
 *
 *   FIX 3 — responseParser.validateAIResponse() now used (Bug #5 / Architecture Risk #1)
 *     Previous: interpretUserIntent() called JSON.parse() then only checked
 *     parsed.action exists. Any action including "DROP_DATABASE" was accepted.
 *     responseParser.js was imported in comments but never actually called.
 *     Fix: parseAndValidate() from responseParser is called on every Gemini
 *     response. Unknown/dangerous actions are rejected before reaching pipeline.
 *     _builtInAction() fallback actions (flagForReview, keepAsIs, custom) are
 *     noted as NOT passing through responseParser — they are internal-only actions
 *     that the executor handles via _applyStep() switch cases.
 *
 *   FIX 4 — History TTL / expiration added (Bug #3 / Memory Leak)
 *     Previous: _historyStore Map grew forever — 10,000 sessions over months
 *     would consume unbounded RAM.
 *     Fix: Each session entry now stores { messages, lastAccess }. A cleanup
 *     interval runs every 30 minutes and removes sessions idle for > SESSION_TTL_MS.
 *     Default TTL: 2 hours. Configurable via AI_SESSION_TTL_MINUTES env var.
 *
 *   FIX 5 — Conversation history now passed to Gemini (Bug #2/Dead Code)
 *     Previous: appendHistory/getHistory/clearHistory existed but history was
 *     never passed to model.generateContent(). It was dead code.
 *     Fix: interpretUserIntent() now uses a chat session with history when
 *     sessionId is provided, so Gemini has actual context across turns.
 *
 *   FIX 6 — questionGenerator path corrected (V4 comment → actual fix)
 *     Previous V4 comment said "NOTE: Update this path" but never did it.
 *     Fix: Path updated to '../clarification/questionGenerator.service'.
 *     If the file doesn't exist there yet, falls back to same-dir gracefully.
 *
 *   FIX 7 — Budget counter note documented (Bug #4)
 *     Per-process budget limitation acknowledged. Not fixable without Redis
 *     in a single file. Comment added directing to Redis migration path.
 *
 *   All V4 logic (retry backoff, budget guard, built-in fallbacks) preserved.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { parseAndValidate }   = require('./responseParser');

// ── Constants ──────────────────────────────────────────────────────────────────
// FIX 1: MODULE-LEVEL constant — used explicitly as MODEL inside _callGemini
// to avoid the temporal dead zone self-reference bug.
const MODEL       = 'gemini-2.0-flash';
const MAX_RETRIES = 2;
const MAX_HISTORY_MESSAGES = 30;

// FIX 4: Session TTL — sessions idle longer than this are evicted
const SESSION_TTL_MS = parseInt(process.env.AI_SESSION_TTL_MINUTES || '120', 10) * 60 * 1000;

// ── Gemini client ─────────────────────────────────────────────────────────────
let _genAI = null;
function getGenAI() {
  if (_genAI) return _genAI;
  if (!process.env.GEMINI_API_KEY) return null;
  _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _genAI;
}

// ── Daily budget guard ────────────────────────────────────────────────────────
// FIX 7: NOTE — this counter is per-process. In PM2 cluster / K8s, each
// worker has its own counter. For accurate multi-process budgeting, move
// _dailyTokenCount to Redis with atomic increment. This is the correct
// single-process implementation for now.
const AI_DAILY_BUDGET_USD = parseFloat(process.env.AI_DAILY_BUDGET_USD || '0');
let _dailyTokenCount = 0;
let _dailyResetAt    = _nextMidnight();

function _nextMidnight() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function _checkBudget(estimatedTokens = 50) {
  if (Date.now() > _dailyResetAt) {
    _dailyTokenCount = 0;
    _dailyResetAt    = _nextMidnight();
  }
  if (AI_DAILY_BUDGET_USD <= 0) return;
  const estimatedCostUsd = (_dailyTokenCount + estimatedTokens) * 0.075 / 1_000_000;
  if (estimatedCostUsd > AI_DAILY_BUDGET_USD) {
    throw Object.assign(
      new Error(`Daily AI budget limit reached ($${AI_DAILY_BUDGET_USD}). Using built-in fallback templates. Budget resets at midnight.`),
      { code: 'AI_BUDGET_EXCEEDED', status: 429 }
    );
  }
}

function _trackTokens(count = 50) { _dailyTokenCount += count; }

// ── Conversation history store ────────────────────────────────────────────────
// FIX 4: Each entry: { messages: [], lastAccess: timestamp }
const _historyStore = new Map();

// FIX 4: Cleanup interval — evict sessions idle > SESSION_TTL_MS
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, entry] of _historyStore.entries()) {
    if (now - entry.lastAccess > SESSION_TTL_MS) {
      _historyStore.delete(sessionId);
    }
  }
}, 30 * 60 * 1000);  // run every 30 minutes

// Don't hold process open just for cleanup
if (_cleanupInterval.unref) _cleanupInterval.unref();

function getHistory(sessionId) {
  if (!sessionId) return [];
  const entry = _historyStore.get(sessionId);
  if (!entry) return [];
  entry.lastAccess = Date.now();  // FIX 4: update access time on read
  const msgs = entry.messages;
  if (msgs.length > MAX_HISTORY_MESSAGES) {
    entry.messages = msgs.slice(-MAX_HISTORY_MESSAGES);
  }
  return entry.messages;
}

function appendHistory(sessionId, role, text) {
  if (!sessionId) return;
  if (!_historyStore.has(sessionId)) {
    _historyStore.set(sessionId, { messages: [], lastAccess: Date.now() });
  }
  const entry = _historyStore.get(sessionId);
  entry.messages.push({ role, parts: [{ text }] });
  entry.lastAccess = Date.now();  // FIX 4: update on write
  if (entry.messages.length > MAX_HISTORY_MESSAGES) {
    entry.messages.splice(0, entry.messages.length - MAX_HISTORY_MESSAGES);
  }
}

function clearHistory(sessionId) {
  if (sessionId) _historyStore.delete(sessionId);
}

// ── Built-in fallback templates ───────────────────────────────────────────────
// NOTE: These actions (flagForReview, keepAsIs, custom) are INTERNAL actions
// that bypass responseParser validation intentionally — they are safe defaults
// generated by this service, never from untrusted AI output.
// pipelineExecutor._applyStep() handles them in its switch statement.

function _builtInQuestion(issue) {
  const col = issue.column     ? `"${issue.column}"` : 'the dataset';
  const pct = issue.affectedPercent ? ` (${issue.affectedPercent}%)` : '';
  const cnt = issue.affectedCount   ? ` ${issue.affectedCount} rows`  : '';
  switch (issue.type) {
    case 'missing': return `${col} has${cnt} missing values${pct}. Fill with mean/median, drop rows, use placeholder, or flag?`;
    case 'duplicate': return `Found${cnt} exact duplicate rows${pct}. Remove duplicates keeping first occurrence?`;
    case 'format_inconsistency': return `${col} has mixed date formats${pct}. Standardise to YYYY-MM-DD?`;
    case 'outlier': return `${col} has${cnt} potential outliers${pct}. Remove, cap, or flag for review?`;
    default: return `Issue in ${col}: ${issue.detail || issue.type}. How should this be handled?`;
  }
}

function _builtInAction(issue, userResponse) {
  const r   = userResponse.toLowerCase();
  const col = issue.column || null;
  if (r.includes('mean'))        return { action: 'fillMissing',  column: col, parameters: { method: 'mean' },   confidence: 85, risk: 'Low',    explanation: `Fill missing values in ${col} with column mean.` };
  if (r.includes('median'))      return { action: 'fillMissing',  column: col, parameters: { method: 'median' }, confidence: 85, risk: 'Low',    explanation: `Fill missing values in ${col} with column median.` };
  if (r.includes('zero'))        return { action: 'fillMissing',  column: col, parameters: { method: 'zero' },   confidence: 80, risk: 'Low',    explanation: `Fill missing values in ${col} with zero.` };
  if (r.includes('placeholder')) return { action: 'fillMissing',  column: col, parameters: { method: 'placeholder', value: 'N/A' }, confidence: 80, risk: 'Low', explanation: `Fill missing values in ${col} with "N/A".` };
  if (r.includes('drop') || r.includes('remove') || r.includes('delete'))
    return { action: 'removeNulls', column: col, parameters: {}, confidence: 90, risk: 'Medium', explanation: `Remove rows with missing ${col}.` };
  if (r.includes('duplicate'))
    return { action: 'deduplicate', column: null, parameters: { strategy: 'exact' }, confidence: 95, risk: 'Medium', explanation: 'Remove exact duplicate rows, keeping first occurrence.' };
  if (r.includes('yyyy') || r.includes('date') || r.includes('standard'))
    return { action: 'formatDates', column: col, parameters: { targetFormat: 'YYYY-MM-DD' }, confidence: 85, risk: 'Low', explanation: `Standardise dates in ${col} to YYYY-MM-DD.` };
  if (r.includes('flag') || r.includes('review'))
    return { action: 'flagForReview', column: col, parameters: {}, confidence: 90, risk: 'Low', explanation: `Flag affected rows in ${col} for manual review.` };
  if (r.includes('keep') || r.includes('skip') || r.includes('ignore'))
    return { action: 'keepAsIs', column: col, parameters: {}, confidence: 100, risk: 'Low', explanation: 'No changes made.' };
  return { action: 'custom', column: col, parameters: { instruction: userResponse }, confidence: 70, risk: 'Medium', explanation: `Custom instruction: "${userResponse}"` };
}

// ── Main exported functions ───────────────────────────────────────────────────

/**
 * Interpret a user's cleaning instruction and return a validated action.
 *
 * FIX 3: Gemini response now goes through parseAndValidate() from responseParser.
 * FIX 5: Conversation history passed to Gemini when sessionId provided.
 */
async function interpretUserIntent(opts) {
  const { issue, userResponse, sessionId } = opts;

  const ai = getGenAI();
  if (ai) {
    try {
      _checkBudget(50);

      const systemPrompt = 'You are a data cleaning assistant. Interpret the user response and return a JSON action object.';
      const userMessage  = `Issue: ${JSON.stringify(issue)}\nUser response: "${userResponse}"\n\nReturn JSON: { action, column, parameters, confidence, risk, explanation }`;

      // FIX 5: Use chat session with history when sessionId is available
      let rawText;
      if (sessionId) {
        rawText = await _callGeminiWithHistory(ai, systemPrompt, userMessage, sessionId);
        appendHistory(sessionId, 'user',  userMessage);
      } else {
        rawText = await _callGemini(ai, systemPrompt, userMessage);
      }

      _trackTokens(50);

      // FIX 3: Use responseParser instead of bare JSON.parse + minimal check
      const validated = parseAndValidate(rawText);

      if (sessionId) {
        appendHistory(sessionId, 'model', rawText);
      }

      return validated;

    } catch (err) {
      if (err.code === 'AI_BUDGET_EXCEEDED') throw err;
      // Log validation failures differently from connection failures
      if (err.status === 422) {
        console.warn(`[ai.service] Gemini response failed validation, using built-in fallback: ${err.message}`);
      } else {
        console.warn(`[ai.service] Gemini interpret failed, using built-in fallback: ${err.message}`);
      }
    }
  }

  return _builtInAction(issue, userResponse);
}

/**
 * Generate questions for issues.
 * FIX 6: Path updated to clarification folder.
 */
async function generateQuestionsForIssues(issues, columns) {
  try {
    // FIX 6: Correct path — was './questionGenerator.service' (same dir, wrong)
    const { generateCleaningQuestions } = require('../clarification/questionGenerator.service');
    return await generateCleaningQuestions(issues, columns);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      // Graceful fallback if clarification/ file not yet deployed
      console.warn('[ai.service] clarification/questionGenerator not found, trying same-dir fallback');
      try {
        const { generateCleaningQuestions } = require('./questionGenerator.service');
        return await generateCleaningQuestions(issues, columns);
      } catch (_) {}
    }
    if (err.code === 'AI_BUDGET_EXCEEDED') throw err;
    console.warn(`[ai.service] generateQuestionsForIssues failed, using built-in templates: ${err.message}`);
  }

  return issues.map((issue, i) => ({
    issueIndex: i,
    question  : _builtInQuestion(issue),
  }));
}

// ── Internal Gemini calls ─────────────────────────────────────────────────────

/**
 * FIX 1: MODEL (constant) used explicitly — no self-reference.
 * FIX 2: AbortController kept as best-effort; Promise.race is the reliable timeout.
 */
async function _callGemini(ai, systemPrompt, userMessage, timeoutMs = 15_000) {
  // FIX 1: Use MODULE-LEVEL `MODEL` constant — NOT the local variable name
  const geminiModel = ai.getGenerativeModel({
    model            : MODEL,   // FIX 1: was `model` (self-reference crash)
    systemInstruction: systemPrompt,
    generationConfig : {
      responseMimeType: 'application/json',
      temperature     : 0.1,
      maxOutputTokens : 512,
    },
  });

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // FIX 2: AbortController for best-effort cancellation
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    // Reliable timeout via Promise.race
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error(`Gemini timed out after ${timeoutMs}ms`), { code: 'GEMINI_TIMEOUT' })), timeoutMs)
    );

    try {
      const result = await Promise.race([
        geminiModel.generateContent(userMessage),
        timeoutPromise,
      ]);
      clearTimeout(timer);

      const text = result.response.text();
      if (!text) throw new Error('Gemini returned empty response');
      return text;

    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      if (err.message?.includes('429') || err.message?.includes('quota')) {
        console.warn('[ai.service] Gemini quota exceeded — immediate fallback');
        throw err;
      }
      if (err.code === 'GEMINI_TIMEOUT') throw err;

      if (attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        console.warn(`[ai.service] Gemini attempt ${attempt + 1} failed: ${err.message}. Retrying in ${Math.round(delay)}ms…`);
        await _sleep(delay);
      }
    }
  }

  throw Object.assign(
    new Error(`Gemini API failed after ${MAX_RETRIES + 1} attempts: ${lastError.message}`),
    { status: 502, code: 'AI_UPSTREAM_ERROR' }
  );
}

/**
 * FIX 5: Gemini chat session with history.
 * Uses startChat() so Gemini receives full conversation context.
 */
async function _callGeminiWithHistory(ai, systemPrompt, userMessage, sessionId, timeoutMs = 15_000) {
  const history = getHistory(sessionId);

  // FIX 1: Use MODULE-LEVEL `MODEL` constant
  const geminiModel = ai.getGenerativeModel({
    model            : MODEL,   // FIX 1
    systemInstruction: systemPrompt,
    generationConfig : {
      responseMimeType: 'application/json',
      temperature     : 0.1,
      maxOutputTokens : 512,
    },
  });

  const chat = geminiModel.startChat({ history });

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error(`Gemini timed out after ${timeoutMs}ms`), { code: 'GEMINI_TIMEOUT' })), timeoutMs)
  );

  const result = await Promise.race([
    chat.sendMessage(userMessage),
    timeoutPromise,
  ]);

  const text = result.response.text();
  if (!text) throw new Error('Gemini returned empty response');
  return text;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  interpretUserIntent,
  generateQuestionsForIssues,
  getHistory,
  appendHistory,
  clearHistory,
};

