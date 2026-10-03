/**
 * VAT rates shown in the admin invoicing UI (Issue dialog, invoice detail
 * totals, event-fee preview) read the same on every surface: the trimmed rate
 * formatted for the UI locale — "7%", sv "7,5 %" — never a fixed "7.00%".
 */
import { describe, expect, it } from 'vitest';
import { formatVatRateBps } from '@/lib/format-vat-rate';

describe('formatVatRateBps — the rate as a locale percentage', () => {
  it('trims to the significant digits', () => {
    expect(formatVatRateBps(700, 'en')).toBe('7%');
    expect(formatVatRateBps(0, 'en')).toBe('0%');
    expect(formatVatRateBps(750, 'en')).toBe('7.5%');
    expect(formatVatRateBps(725, 'en')).toBe('7.25%');
  });

  it('follows the locale: Swedish decimal comma and a non-breaking space before %', () => {
    expect(formatVatRateBps(750, 'sv')).toBe('7,5 %');
    expect(formatVatRateBps(700, 'th')).toBe('7%');
  });
});
