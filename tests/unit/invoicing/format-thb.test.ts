/**
 * 088-invoice-tax-flow-redesign — T034 [US4] `formatThbSatang` thousands
 * separators + `capitalizeFirstLetter` (FR-009).
 *
 * These pure helpers live in `infrastructure/pdf/format-thb.ts` (NOT the
 * template) specifically so this unit test can import them WITHOUT pulling in
 * `@react-pdf/renderer` + the heavyweight Sarabun font registration — the
 * template-render assertions belong in tests/integration (node env).
 *
 * SC-003 byte-stability: the grouping is OPT-IN (`grouped` defaults false) so
 * the pre-v6 (v1-v5) render path stays byte-identical — only a v6+ template
 * passes `grouped: true`. The grouping is deterministic + locale-independent
 * (manual digit-triplet regex, NEVER `toLocaleString`, whose output varies with
 * the ambient ICU locale).
 */
import { describe, it, expect } from 'vitest';
import {
  formatThbSatang,
  capitalizeFirstLetter,
} from '@/modules/invoicing/infrastructure/pdf/format-thb';

describe('088 T034 — formatThbSatang thousands grouping (FR-009)', () => {
  it('grouped: 1,234,567 satang → "12,345.67"', () => {
    expect(formatThbSatang(1_234_567n, true)).toBe('12,345.67');
  });

  it('grouped: small sub-baht value → "0.50"', () => {
    expect(formatThbSatang(50n, true)).toBe('0.50');
  });

  it('grouped: exact thousand → "1,000.00"', () => {
    expect(formatThbSatang(100_000n, true)).toBe('1,000.00');
  });

  it('grouped: millions get a separator every three digits → "1,000,000.00"', () => {
    expect(formatThbSatang(100_000_000n, true)).toBe('1,000,000.00');
  });

  it('grouped: no separator needed under 1,000 → "999.99"', () => {
    expect(formatThbSatang(99_999n, true)).toBe('999.99');
  });

  // SC-003 — the DEFAULT (ungrouped) output is byte-identical to the pre-v6
  // formatter so a pinned v1-v5 template re-renders with the SAME bytes.
  it('ungrouped (default) stays "12345.67" — pre-v6 byte-stable', () => {
    expect(formatThbSatang(1_234_567n)).toBe('12345.67');
    expect(formatThbSatang(1_234_567n, false)).toBe('12345.67');
  });

  it('ungrouped: "1000.00" (no comma) — pre-v6 byte-stable', () => {
    expect(formatThbSatang(100_000n)).toBe('1000.00');
  });

  it('grouped vs ungrouped differ only in the integer thousands separators', () => {
    expect(formatThbSatang(100n, true)).toBe('1.00');
    expect(formatThbSatang(100n)).toBe('1.00');
    expect(formatThbSatang(0n, true)).toBe('0.00');
    expect(formatThbSatang(0n)).toBe('0.00');
  });
});

describe('088 T034 — capitalizeFirstLetter (FR-009 English amount-in-words)', () => {
  it('capitalizes the first letter, leaves the rest untouched', () => {
    expect(capitalizeFirstLetter('one thousand seventy baht')).toBe(
      'One thousand seventy baht',
    );
  });

  it('is a no-op on an already-capitalized string', () => {
    expect(capitalizeFirstLetter('One baht')).toBe('One baht');
  });

  it('handles the empty string without throwing', () => {
    expect(capitalizeFirstLetter('')).toBe('');
  });

  it('does not upper-case subsequent words (only the first character)', () => {
    expect(capitalizeFirstLetter('two hundred baht and fifty satang')).toBe(
      'Two hundred baht and fifty satang',
    );
  });
});
