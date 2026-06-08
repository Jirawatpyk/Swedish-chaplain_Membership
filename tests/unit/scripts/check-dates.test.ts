/**
 * Self-test for scripts/check-dates.ts
 *
 * Uses the exported `scanSource` pure function so no file I/O is needed.
 * Covers:
 *  - The R5 multiline feature (the ONLY proof the full-text pass works)
 *  - Ternary bare-locale forms
 *  - Member-access locale chains (props.locale, this.locale — #7 fix)
 *  - Inline buddhist-literal
 *  - Negative cases: getDateFormatLocale wrap, cacheKey, toLocaleString, comments
 */
import { describe, expect, it } from 'vitest';
import { scanSource } from '@/../scripts/check-dates';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hasViolation(source: string, patternId: string): boolean {
  return scanSource(source, 'test-fixture.ts').some((v) => v.patternId === patternId);
}

function hasNoViolations(source: string): boolean {
  return scanSource(source, 'test-fixture.ts').length === 0;
}

// ---------------------------------------------------------------------------
// Should FLAG
// ---------------------------------------------------------------------------
describe('check-dates scanSource — patterns that MUST be flagged', () => {
  it('FLAGS multiline new Intl.DateTimeFormat with bare locale on its own line (R5)', () => {
    const src = `
const fmt = new Intl.DateTimeFormat(
  locale,
  { year: 'numeric' }
);
`;
    expect(hasViolation(src, 'bare-Intl-DateTimeFormat')).toBe(true);
  });

  it('FLAGS ternary .toLocaleDateString with locale in ternary expression', () => {
    const src = `const s = date.toLocaleDateString(locale === 'th' ? 'x' : locale, {});`;
    expect(hasViolation(src, 'bare-toLocaleDateString')).toBe(true);
  });

  it('FLAGS new Intl.DateTimeFormat(props.locale, …) — member-access chain (#7)', () => {
    const src = `const fmt = new Intl.DateTimeFormat(props.locale, { dateStyle: 'medium' });`;
    expect(hasViolation(src, 'bare-Intl-DateTimeFormat')).toBe(true);
  });

  it('FLAGS .toLocaleDateString(this.locale, …) — member-access chain (#7)', () => {
    const src = `const s = date.toLocaleDateString(this.locale, { dateStyle: 'short' });`;
    expect(hasViolation(src, 'bare-toLocaleDateString')).toBe(true);
  });

  it('FLAGS new Intl.DateTimeFormat(ctx.requestLocale, …) — deep member-access (#7)', () => {
    const src = `const fmt = new Intl.DateTimeFormat(ctx.requestLocale, {});`;
    expect(hasViolation(src, 'bare-Intl-DateTimeFormat')).toBe(true);
  });

  it("FLAGS inline 'th-TH-u-ca-buddhist' string literal", () => {
    const src = `const loc = 'th-TH-u-ca-buddhist';`;
    expect(hasViolation(src, 'buddhist-literal')).toBe(true);
  });

  it('FLAGS multiline new Intl.DateTimeFormat with multiline whitespace + bare locale', () => {
    // Extra whitespace between paren and argument — still a bare locale
    const src = `
new Intl.DateTimeFormat(
  locale,
  {}
)
`;
    expect(hasViolation(src, 'bare-Intl-DateTimeFormat')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Should NOT FLAG
// ---------------------------------------------------------------------------
describe('check-dates scanSource — patterns that must NOT be flagged', () => {
  it('does NOT flag new Intl.DateTimeFormat(getDateFormatLocale(locale), …)', () => {
    const src = `const fmt = new Intl.DateTimeFormat(getDateFormatLocale(locale), { dateStyle: 'medium' });`;
    expect(hasNoViolations(src)).toBe(true);
  });

  it('does NOT flag new Intl.DateTimeFormat(cacheKey, …) — cacheKey does not end in *locale', () => {
    // Mirrors src/lib/format-payment-summary.ts cache pattern
    const src = `
const cacheKey = getDateFormatLocale(locale);
let fmt = FORMATTERS.get(cacheKey);
if (!fmt) {
  fmt = new Intl.DateTimeFormat(cacheKey, { dateStyle: 'short' });
  FORMATTERS.set(cacheKey, fmt);
}
`;
    expect(hasNoViolations(src)).toBe(true);
  });

  it('does NOT flag amount.toLocaleString(locale) — number formatting false-positive guard', () => {
    const src = `const display = amount.toLocaleString(locale, { style: 'currency', currency: 'THB' });`;
    expect(hasNoViolations(src)).toBe(true);
  });

  it('does NOT flag a bare-locale Intl call inside a // single-line comment', () => {
    const src = `// new Intl.DateTimeFormat(locale, { year: 'numeric' })`;
    expect(hasNoViolations(src)).toBe(true);
  });

  it('does NOT flag a bare-locale Intl call inside a /* block */ comment', () => {
    const src = `/* new Intl.DateTimeFormat(locale, {}) — example in docs */`;
    expect(hasNoViolations(src)).toBe(true);
  });

  it('does NOT flag .toLocaleDateString(getDateFormatLocale(locale), …)', () => {
    const src = `const s = date.toLocaleDateString(getDateFormatLocale(locale), { dateStyle: 'short' });`;
    expect(hasNoViolations(src)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge-cases & combined
// ---------------------------------------------------------------------------
describe('check-dates scanSource — edge cases', () => {
  it('returns violation with correct line number for multiline match', () => {
    const src = `line1\nconst fmt = new Intl.DateTimeFormat(\n  locale,\n  {}\n);\n`;
    const violations = scanSource(src, 'test-fixture.ts');
    expect(violations.length).toBeGreaterThan(0);
    // Match starts on line 2 (the `new Intl…` line)
    expect(violations[0]?.line).toBe(2);
  });

  it('returns violation file label as the relPath passed in', () => {
    const src = `const fmt = new Intl.DateTimeFormat(locale, {});`;
    const violations = scanSource(src, 'custom/path/file.ts');
    expect(violations[0]?.file).toBe('custom/path/file.ts');
  });

  it('deduplicates when reLine and reFullText would both fire on the same line', () => {
    // buddhist-literal has only reLine; bare-Intl has only reFullText — no
    // dedup needed there.  This test covers the dedup path generically: a
    // source with one violation produces exactly 1 entry, not 2.
    const src = `const s = date.toLocaleDateString(locale, {});`;
    const violations = scanSource(src, 'test-fixture.ts');
    const bare = violations.filter((v) => v.patternId === 'bare-toLocaleDateString');
    expect(bare.length).toBe(1);
  });
});
