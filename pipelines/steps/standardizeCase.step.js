'use strict';

// Known acronyms / all-caps tokens that should never be title-cased down.
// Extend this list to suit your domain.
const KNOWN_ACRONYMS = new Set([
  'LLC', 'LLP', 'PLC', 'INC', 'CORP', 'LTD',
  'IBM', 'SAP', 'HP', 'GE',
  'USA', 'UK', 'UAE', 'EU',
  'VAT', 'GST', 'PO', 'ID', 'ETA', 'ETD',
]);

function execute(rows, step) {
  const { column }                      = step;
  const { mode, skipNonString = false } = step.parameters || {};

  if (!column) throw new Error('standardizeCase requires step.column');

  if (!['lower', 'upper', 'title'].includes(mode)) {
    throw new Error('standardizeCase requires parameters.mode: lower | upper | title');
  }

  // FIX: hasOwnProperty — prevents false positives from inherited properties
  if (rows.length > 0 && !rows.some(r =>
    Object.prototype.hasOwnProperty.call(r, column)
  )) {
    throw new Error(`standardizeCase: column "${column}" does not exist in dataset`);
  }

  const outputRows      = [];
  const affectedIndices = [];
  const skippedIndices  = [];

  for (let i = 0; i < rows.length; i++) {
    const row = { ...rows[i] };
    const val = row[column];

    // Always skip nulls safely
    if (val === null || val === undefined) {
      outputRows.push(row);
      continue;
    }

    // Non-string handling
    if (typeof val !== 'string') {
      if (skipNonString) {
        skippedIndices.push(i);
        outputRows.push(row);
        continue;
      } else {
        throw new Error(
          `standardizeCase: non-string value "${val}" (type: ${typeof val}) ` +
          `found in column "${column}" at row ${i}. ` +
          `Convert column to string type before applying case transformation, ` +
          `or set skipNonString: true to skip non-string values.`
        );
      }
    }

    // NOTE: empty strings "" and whitespace-only strings "   " pass through
    // unchanged. Use trimWhitespace.step.js before this step if needed.
    const transformed = _applyCase(val, mode);
    if (transformed !== val) {
      row[column] = transformed;
      affectedIndices.push(i);
    }

    outputRows.push(row);
  }

  return {
    rows            : outputRows,
    inputRowCount   : rows.length,
    affectedCount   : affectedIndices.length,
    affectedIndices,
    columnStats     : {
      column,
      mode,
      skipNonString,
      changedCount : affectedIndices.length,
      skippedCount : skippedIndices.length,
    },
    summary: [
      `Applied "${mode}" case to ${affectedIndices.length} value(s) in "${column}".`,
      skippedIndices.length > 0
        ? `${skippedIndices.length} non-string value(s) skipped.`
        : '',
    ].filter(Boolean).join(' '),
  };
}

function _applyCase(str, mode) {
  switch (mode) {
    case 'lower': return str.toLowerCase();
    case 'upper': return str.toUpperCase();
    case 'title': return _toTitleCase(str);
    default:      return str;
  }
}

/**
 * Enterprise-grade title case:
 *   - Preserves known acronyms (IBM, LLC, PLC …)
 *   - Handles hyphenated words: "smith-jones" → "Smith-Jones"
 *   - Handles apostrophes: "o'connor" → "O'Connor", "mcdonald" → "McDonald"
 *   - Unicode-aware: uses \p{L} with `u` flag for accented characters
 *     (José, François, Müller, नेपाल)
 *   - Handles Mc/Mac prefix capitalisation: "mcdonald" → "McDonald"
 */
function _toTitleCase(str) {
  // Split on whitespace boundaries, preserving the separators
  return str.replace(/\S+/gu, token => _capitaliseToken(token));
}

function _capitaliseToken(token) {
  // Preserve if it's a known acronym (compare uppercase)
  if (KNOWN_ACRONYMS.has(token.toUpperCase())) {
    return token.toUpperCase();
  }

  // Handle hyphenated compounds: "smith-jones" → "Smith-Jones"
  if (token.includes('-')) {
    return token.split('-').map(part => _capitaliseWord(part)).join('-');
  }

  return _capitaliseWord(token);
}

/**
 * Capitalise a single word with special handling for:
 *   - Mc/Mac prefixes: "mcdonald" → "McDonald", "macleod" → "MacLeod"
 *   - Apostrophe mid-word: "o'connor" → "O'Connor"
 *   - All other words: first Unicode letter uppercased, rest lowercased
 */
function _capitaliseWord(word) {
  if (!word) return word;

  // Mc prefix: "mcdonald" → "McDonald"
  const mcMatch = word.match(/^(Mc|mc|MC)(.+)/u);
  if (mcMatch) {
    return 'Mc' + _capitaliseFirstLetter(mcMatch[2]);
  }

  // Mac prefix (only if followed by a capital-worthy letter, avoids "Mace" → "MacE")
  const macMatch = word.match(/^(Mac|mac|MAC)([A-Za-z\u00C0-\u024F].{2,})/u);
  if (macMatch) {
    return 'Mac' + _capitaliseFirstLetter(macMatch[2]);
  }

  // Apostrophe mid-word: "o'connor" → "O'Connor"
  if (word.includes("'")) {
    return word.split("'").map(part => _capitaliseFirstLetter(part)).join("'");
  }

  return _capitaliseFirstLetter(word);
}

/**
 * Uppercase the first Unicode letter of a string, lowercase the rest.
 * Uses \p{L} to correctly handle accented / non-ASCII first characters.
 */
function _capitaliseFirstLetter(word) {
  if (!word) return word;
  // Match the first Unicode letter character
  return word.replace(/^(\p{L})(\p{L}*)(.*)/u, (_, first, rest, tail) =>
    first.toUpperCase() + rest.toLowerCase() + tail
  ) || word[0].toUpperCase() + word.slice(1).toLowerCase();
}

module.exports = { execute };

