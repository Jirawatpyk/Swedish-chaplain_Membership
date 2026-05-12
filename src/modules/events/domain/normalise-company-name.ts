/**
 * T024 — `normaliseCompanyName` pure function (F6 Domain).
 *
 * Strips common corporate suffixes + trailing punctuation + lower-cases
 * the input so that "Acme Co., Ltd." and "acme co ltd" yield the same
 * normalised key for the fuzzy match cascade (FR-012 step 3 → research.md R4).
 *
 * Suffix list comes from the most common Thai/Swedish/UK/US corporate
 * forms seen in EventCreate attendee data. Order matters: longer / more
 * specific patterns are removed first so we don't leave fragments.
 *
 * Pure TypeScript — Constitution Principle III. Deterministic. No
 * locale-specific casing (uses `toLowerCase()` not `toLocaleLowerCase()`)
 * to keep the function input-output stable across runtime locales.
 */

/**
 * Ordered suffix patterns. Each is matched as a whole word at the end
 * (after optional surrounding punctuation) and stripped. Multi-pass
 * application handles compounds like "Co., Ltd." (two suffixes).
 */
const SUFFIX_PATTERNS: ReadonlyArray<RegExp> = [
  // Multi-word patterns first
  /\s+co\.?\s*,?\s+ltd\.?$/i,
  /\s+co\.?\s*,?\s+inc\.?$/i,
  /\s+pte\.?\s+ltd\.?$/i,
  // Single-word suffixes
  /\s+limited$/i,
  /\s+ltd\.?$/i,
  /\s+llc$/i,
  /\s+inc\.?$/i,
  /\s+corp\.?$/i,
  /\s+pte\.?$/i,
  /\s+ab$/i, // Swedish AB (Aktiebolag)
  /\s+gmbh$/i, // German GmbH
  /\s+sa$/i, // French SA (Société Anonyme)
  /\s+ag$/i, // Swiss / German AG (Aktiengesellschaft)
  /\s+co\.?$/i,
];

/**
 * Trailing-punctuation strip applied after suffix removal so commas /
 * dots left by suffix patterns get cleaned up.
 */
const TRAILING_PUNCT = /[.,;:\s]+$/;

/**
 * Internal whitespace collapse — multiple spaces → single space.
 */
const COLLAPSE_WS = /\s+/g;

export function normaliseCompanyName(input: string): string {
  if (!input) return '';

  let s = input.trim();
  if (s.length === 0) return '';

  // Repeatedly strip suffix patterns — handles "Co., Ltd." (two suffixes).
  // Bounded loop to prevent any pathological infinite-strip case.
  for (let i = 0; i < 5; i++) {
    let changed = false;
    for (const pattern of SUFFIX_PATTERNS) {
      const next = s.replace(pattern, '');
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Trim trailing punctuation + collapse whitespace + lowercase.
  s = s.replace(TRAILING_PUNCT, '').replace(COLLAPSE_WS, ' ').toLowerCase();

  return s.trim();
}
