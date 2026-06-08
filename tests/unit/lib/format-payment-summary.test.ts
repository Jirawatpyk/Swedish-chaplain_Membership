/**
 * Unit tests for `formatPaymentDateTime` in `src/lib/format-payment-summary.ts`.
 *
 * Covers the #6 speckit-review finding:
 *   - `formatPaymentDateTime` now routes through `getDateFormatLocale`, so
 *     `'sv'` resolves to `'sv-SE'` and `'th'` resolves to
 *     `'th-TH-u-ca-buddhist'` (Buddhist Era calendar).
 *   - The datetime-formatter cache keys on the RESOLVED locale so `'sv'` and
 *     `'sv-SE'` share one cached `Intl.DateTimeFormat` instance.
 *
 * Signature under test (from the source):
 *   formatPaymentDateTime(date?: Date, locale?: string): string
 *
 * We do NOT test `formatPaymentAmount` here — that takes a number + currency
 * and is unrelated to the locale-routing change.
 */
import { describe, it, expect } from 'vitest';

import { formatPaymentDateTime } from '@/lib/format-payment-summary';

// A fixed UTC instant in 2026 CE = 2569 BE.
// 2026-03-15T10:30:00.000Z — a noon-ish Bangkok time so time-rendering is
// stable across UTC and UTC+7 (avoids "previous day" edge for date assertions).
const FIXED_DATE = new Date('2026-03-15T10:30:00.000Z');

describe('formatPaymentDateTime', () => {
  it('th locale: output contains the Buddhist Era year "2569" (2026 CE + 543)', () => {
    const result = formatPaymentDateTime(FIXED_DATE, 'th');
    // th-TH-u-ca-buddhist calendar increments the year by +543.
    expect(result).toContain('2569');
    // The raw Gregorian year must NOT appear (guards against calendar
    // regression where the buddhist-era mapping is dropped).
    expect(result).not.toContain('2026');
  });

  it('sv and sv-SE produce identical output (sv is transparently routed to sv-SE)', () => {
    const sv = formatPaymentDateTime(FIXED_DATE, 'sv');
    const svSE = formatPaymentDateTime(FIXED_DATE, 'sv-SE');
    expect(sv).toBe(svSE);
  });

  it('en locale: output contains the Gregorian year "2026"', () => {
    const result = formatPaymentDateTime(FIXED_DATE, 'en');
    expect(result).toContain('2026');
    // Buddhist Era year must NOT appear in an English-locale output.
    expect(result).not.toContain('2569');
  });

  it('default locale (en-US): output contains the Gregorian year "2026"', () => {
    // No locale arg — falls through to the default parameter 'en-US'.
    const result = formatPaymentDateTime(FIXED_DATE);
    expect(result).toContain('2026');
  });
});
