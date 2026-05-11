/**
 * F8 Phase 4 Wave I3 / T099 spec — dual-format date math (FR-014).
 *
 * Test scope:
 *   - BE = CE + 543 (no off-by-543 errors per spec FR-014)
 *   - Asia/Bangkok timezone honored at midnight UTC boundaries
 *   - All 12 months map correctly to Thai abbreviations
 *   - Locale-specific Gregorian formatting (en-GB / sv-SE day-month-year)
 */
import { describe, expect, it } from 'vitest';
import { formatDualFormatDate } from '@/modules/renewals/infrastructure/email/templates/dual-format-date-footer';

describe('formatDualFormatDate', () => {
  describe('BE conversion', () => {
    it('2026-08-15 (Aug) → BE 2569 / Gregorian "15 August 2026"', () => {
      const r = formatDualFormatDate('2026-08-15T00:00:00Z', 'en');
      expect(r.thaiBE).toContain('2569');
      expect(r.thaiBE).toContain('ส.ค.');
      expect(r.gregorian).toMatch(/15\s+August\s+2026/);
    });

    it('2025-12-31 (Dec) → BE 2568', () => {
      const r = formatDualFormatDate('2025-12-31T05:00:00Z', 'en');
      expect(r.thaiBE).toContain('2568');
      expect(r.thaiBE).toContain('ธ.ค.');
    });

    it('2026-01-01 (Jan) → BE 2569 (year boundary)', () => {
      const r = formatDualFormatDate('2026-01-01T05:00:00Z', 'en');
      expect(r.thaiBE).toContain('2569');
      expect(r.thaiBE).toContain('ม.ค.');
    });
  });

  describe('Asia/Bangkok timezone', () => {
    it('2026-08-15T16:30:00Z → 15 August in Bangkok (still UTC day)', () => {
      // 16:30 UTC = 23:30 Bangkok same day → "15 August"
      const r = formatDualFormatDate('2026-08-15T16:30:00Z', 'en');
      expect(r.gregorian).toMatch(/15\s+August/);
      expect(r.thaiBE).toMatch(/^15\s+ส\.ค\./);
    });

    it('2026-08-15T18:00:00Z → 16 August in Bangkok (UTC+7 rolls forward)', () => {
      // 18:00 UTC = 01:00 next day Bangkok → "16 August"
      const r = formatDualFormatDate('2026-08-15T18:00:00Z', 'en');
      expect(r.gregorian).toMatch(/16\s+August/);
      expect(r.thaiBE).toMatch(/^16\s+ส\.ค\./);
    });
  });

  describe('Thai month abbreviations', () => {
    it.each([
      ['2026-01-15', 'ม.ค.'],
      ['2026-02-15', 'ก.พ.'],
      ['2026-03-15', 'มี.ค.'],
      ['2026-04-15', 'เม.ย.'],
      ['2026-05-15', 'พ.ค.'],
      ['2026-06-15', 'มิ.ย.'],
      ['2026-07-15', 'ก.ค.'],
      ['2026-08-15', 'ส.ค.'],
      ['2026-09-15', 'ก.ย.'],
      ['2026-10-15', 'ต.ค.'],
      ['2026-11-15', 'พ.ย.'],
      ['2026-12-15', 'ธ.ค.'],
    ])('%s → %s', (iso, expectedAbbr) => {
      const r = formatDualFormatDate(`${iso}T05:00:00Z`, 'en');
      expect(r.thaiBE).toContain(expectedAbbr);
    });
  });

  describe('locale-specific Gregorian', () => {
    it('en uses en-GB (day month year)', () => {
      const r = formatDualFormatDate('2026-08-15T00:00:00Z', 'en');
      // Day-Month-Year: "15 August 2026" — month name in full
      expect(r.gregorian).toMatch(/15\s+August\s+2026/);
    });

    it('sv uses sv-SE (day month year, Swedish month name)', () => {
      const r = formatDualFormatDate('2026-08-15T00:00:00Z', 'sv');
      // Swedish month name: "augusti"
      expect(r.gregorian).toMatch(/15\s+augusti\s+2026/);
    });
  });

  describe('defensive fallback', () => {
    it('returns input verbatim when ISO date is invalid', () => {
      const r = formatDualFormatDate('not-a-date', 'en');
      expect(r.gregorian).toBe('not-a-date');
      expect(r.thaiBE).toBe('not-a-date');
    });
  });
});
