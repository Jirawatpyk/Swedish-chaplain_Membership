/**
 * Round 10 I5 — unit tests for the `countConstEntries` regex semantics
 * used by the cross-module audit-count drift check.
 *
 * The script is now CI-blocking: a regex regression that miscounts
 * (e.g., comment-line false-positive, quote-style refactor) would
 * either always-pass or always-fail. These tests pin the contract.
 */
import { describe, expect, it } from 'vitest';
import { countConstEntries } from '@/../scripts/check-cross-module-audit-counts';

const SAMPLE_F8 = `
import { z } from 'zod';

export const F8_AUDIT_EVENT_TYPES = [
  'plan_created',
  'plan_updated',
  // commented entry — must NOT count
  // 'plan_disabled',
  'plan_cloned',
  'plan_change_scheduled',
] as const;

export const SOMETHING_ELSE = 'noise';
`;

describe('countConstEntries (Round 10 I5)', () => {
  it('returns N for a 4-entry const ignoring commented-out lines', () => {
    expect(countConstEntries(SAMPLE_F8, 'F8_AUDIT_EVENT_TYPES')).toBe(4);
  });

  it('returns -1 when the const literal cannot be located', () => {
    expect(
      countConstEntries(SAMPLE_F8, 'NON_EXISTENT_CONST'),
    ).toBe(-1);
  });

  it('returns -1 when the const opener exists but no `as const` closer', () => {
    const malformed = `export const X = ['a', 'b']`; // missing `as const`
    expect(countConstEntries(malformed, 'X')).toBe(-1);
  });

  it('returns 0 on quote-style refactor (single→double) — caller fail-loud per S2', () => {
    const doubleQuoted = `
      export const X = [
        "a",
        "b",
        "c",
      ] as const;
    `;
    expect(countConstEntries(doubleQuoted, 'X')).toBe(0);
  });

  it('returns 0 on quote-style refactor (single→backtick) — caller fail-loud per S2', () => {
    const backtickQuoted = `
      export const X = [
        \`a\`,
        \`b\`,
      ] as const;
    `;
    expect(countConstEntries(backtickQuoted, 'X')).toBe(0);
  });

  it('counts entries with mixed indentation correctly', () => {
    const mixed = `
      export const Y = [
          'deep_indent',
        'shallow',
      'flush',
      ] as const;
    `;
    expect(countConstEntries(mixed, 'Y')).toBe(3);
  });

  it('does NOT count single-quoted strings outside the const block', () => {
    const noisy = `
      const before = 'noise_before';
      export const Z = [
        'real_entry',
      ] as const;
      const after = 'noise_after';
    `;
    expect(countConstEntries(noisy, 'Z')).toBe(1);
  });
});
