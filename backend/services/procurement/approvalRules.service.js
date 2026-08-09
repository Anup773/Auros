'use strict';
/**
 * backend/services/procurement/approvalRules.service.js
 *
 * PHASE 3 — "Criteria-based auto-approval".
 *
 * Context: the reconciliation engine already has a volume-based way to cut
 * through a large approval queue (the copilot command parser — "approve
 * items 1 to 50", "approve the remaining" — in python/data_engine.py). This
 * is the complementary criteria-based half: rules that auto-resolve an
 * approval item the moment it's created, before a human ever sees it,
 * based on dollar/percentage/vendor criteria a finance user configures.
 *
 * Deliberately plain, deterministic logic — no AI call. The criteria here
 * (a dollar threshold, a percentage variance, a vendor on a list) are exact
 * comparisons; a rule engine needs to give the same answer for the same
 * input every time and be trivially explainable ("$340 < $500 threshold"),
 * which is what a few lines of comparison code gives you for free and an
 * LLM call does not.
 *
 * SAFETY DEFAULTS — deliberately not configurable via a rule's appliesTo:
 *   - 'duplicate_invoice' can NEVER be auto-approved by any rule. Two
 *     invoices sharing a number is exactly the situation you do not want
 *     silently waved through — it's the one that risks paying twice.
 *   - 'no_po_match' can only be matched by a vendor_in rule, never by
 *     amount_under or variance_under_pct — there's no PO amount to compare
 *     against, so a dollar or percentage rule has nothing to be "under" or
 *     "within" of. A trusted-vendor rule still makes sense here (e.g. a
 *     recurring utility bill with no formal PO).
 *
 * Storage: same pattern as apiKey.service.js / auth.controller.js — JSON on
 * disk, async writes serialized through a queue so concurrent saves can't
 * race and corrupt the file.
 */

const path = require('path');
const fs   = require('fs');
const fsp  = fs.promises;
const crypto = require('crypto');

const DATA_DIR  = path.join(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'approvalRules.json');

const CONDITION_TYPES = ['amount_under', 'variance_under_pct', 'vendor_in'];

// Ambiguity types a rule is allowed to apply to, per condition type. See the
// SAFETY DEFAULTS note above for why this isn't just "any rule, any type".
const ALLOWED_TARGETS = {
  amount_under       : ['amount_mismatch', 'quantity_mismatch', 'contract_price_variance', 'tax_discrepancy'],
  variance_under_pct : ['amount_mismatch', 'quantity_mismatch', 'contract_price_variance', 'tax_discrepancy'],
  vendor_in          : ['amount_mismatch', 'quantity_mismatch', 'contract_price_variance', 'tax_discrepancy', 'no_po_match'],
};
// 'duplicate_invoice' intentionally appears in neither list above.

let _rules = [];
let _loaded = false;
let _saveQueue = Promise.resolve();

async function _load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      _rules = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[approvalRules] Failed to load rules, starting empty:', err.message);
    _rules = [];
  }
  _loaded = true;
}

function _save() {
  _saveQueue = _saveQueue.then(_doSave, _doSave);
  return _saveQueue;
}

async function _doSave() {
  try {
    if (!fs.existsSync(DATA_DIR)) await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmpFile = DATA_FILE + '.tmp';
    await fsp.writeFile(tmpFile, JSON.stringify(_rules, null, 2), 'utf8');
    await fsp.rename(tmpFile, DATA_FILE);
  } catch (err) {
    console.error('[approvalRules] Failed to save rules:', err.message);
  }
}

async function _ensureLoaded() {
  if (!_loaded) await _load();
}

function _validateCondition(condition) {
  if (!condition || !CONDITION_TYPES.includes(condition.type)) {
    throw Object.assign(new Error(`condition.type must be one of: ${CONDITION_TYPES.join(', ')}`), { status: 400 });
  }
  if (condition.type === 'amount_under' || condition.type === 'variance_under_pct') {
    if (typeof condition.value !== 'number' || condition.value <= 0) {
      throw Object.assign(new Error(`${condition.type} requires condition.value to be a positive number`), { status: 400 });
    }
  }
  if (condition.type === 'vendor_in') {
    if (!Array.isArray(condition.value) || !condition.value.every(v => typeof v === 'string' && v.trim())) {
      throw Object.assign(new Error('vendor_in requires condition.value to be a non-empty array of vendor name strings'), { status: 400 });
    }
  }
}

function _validateAppliesTo(appliesTo, conditionType) {
  if (!Array.isArray(appliesTo) || appliesTo.length === 0) {
    throw Object.assign(new Error('appliesTo must be a non-empty array of ambiguity types'), { status: 400 });
  }
  const allowed = ALLOWED_TARGETS[conditionType] || [];
  const bad = appliesTo.filter(t => !allowed.includes(t));
  if (bad.length) {
    throw Object.assign(new Error(
      `${conditionType} cannot apply to: ${bad.join(', ')}. Allowed for this condition: ${allowed.join(', ')}`
    ), { status: 400 });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function listRules() {
  await _ensureLoaded();
  return _rules;
}

async function createRule({ name, condition, appliesTo, createdBy }) {
  await _ensureLoaded();
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw Object.assign(new Error('name is required'), { status: 400 });
  }
  _validateCondition(condition);
  _validateAppliesTo(appliesTo, condition.type);

  const rule = {
    id       : `rule_${crypto.randomUUID()}`,
    name     : name.trim().slice(0, 200),
    enabled  : true,
    condition,
    appliesTo,
    createdBy: createdBy || null,
    createdAt: new Date().toISOString(),
  };
  _rules.push(rule);
  await _save();
  return rule;
}

async function updateRule(ruleId, patch) {
  await _ensureLoaded();
  const rule = _rules.find(r => r.id === ruleId);
  if (!rule) throw Object.assign(new Error('Rule not found'), { status: 404 });

  if (patch.condition !== undefined) {
    _validateCondition(patch.condition);
    rule.condition = patch.condition;
  }
  if (patch.appliesTo !== undefined) {
    _validateAppliesTo(patch.appliesTo, rule.condition.type);
    rule.appliesTo = patch.appliesTo;
  }
  if (patch.name !== undefined) rule.name = String(patch.name).trim().slice(0, 200);
  if (patch.enabled !== undefined) rule.enabled = !!patch.enabled;

  await _save();
  return rule;
}

async function deleteRule(ruleId) {
  await _ensureLoaded();
  const before = _rules.length;
  _rules = _rules.filter(r => r.id !== ruleId);
  if (_rules.length === before) throw Object.assign(new Error('Rule not found'), { status: 404 });
  await _save();
}

/**
 * Evaluate one ambiguity (as produced by python/data_engine.py's
 * op_reconcile) against the current rule set. Returns the first enabled,
 * applicable, matching rule, or null if nothing matches — the ambiguity
 * then goes to a human as it always has.
 *
 * Pure function w.r.t. the rules array passed in — does not read/write
 * storage, so it's cheap to call once per ambiguity in a batch.
 */
function findMatchingRule(ambiguity, rules) {
  if (ambiguity.type === 'duplicate_invoice') return null; // see SAFETY DEFAULTS

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!rule.appliesTo.includes(ambiguity.type)) continue;
    if (_conditionMatches(rule.condition, ambiguity)) return rule;
  }
  return null;
}

function _conditionMatches(condition, ambiguity) {
  switch (condition.type) {
    case 'amount_under': {
      const amount = _parseAmount(ambiguity.invoice?.amount);
      return amount !== null && amount < condition.value;
    }
    case 'variance_under_pct': {
      // amountDiffPct etc. are fractions (0.02 = 2%), condition.value is a
      // plain percentage (2 = 2%) — matches how the UI/API will present it.
      const pct = ambiguity.amountDiffPct ?? ambiguity.taxDiffPct ??
                  ambiguity.quantityDiffPct ?? ambiguity.priceDiffPct;
      return typeof pct === 'number' && (pct * 100) < condition.value;
    }
    case 'vendor_in': {
      const vendor = String(ambiguity.invoice?.vendor_name || '').trim().toLowerCase();
      if (!vendor) return false;
      return condition.value.some(v => v.trim().toLowerCase() === vendor);
    }
    default:
      return false;
  }
}

function _parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[^\d.-]/g, '');
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

module.exports = {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  findMatchingRule,
  CONDITION_TYPES,
  ALLOWED_TARGETS,
};