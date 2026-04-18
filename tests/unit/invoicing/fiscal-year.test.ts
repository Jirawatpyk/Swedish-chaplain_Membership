import { describe, expect, it } from 'vitest';
import {
  asFiscalYear,
  asFiscalYearUnsafe,
  fiscalYearFromUtcIso,
} from '@/modules/invoicing/domain/value-objects/fiscal-year';

describe('FiscalYear', () => {
  it('accepts 2026', () => {
    const r = asFiscalYear(2026);
    expect(r.ok).toBe(true);
  });

  it('rejects <2000 and >2100', () => {
    expect(asFiscalYear(1999).ok).toBe(false);
    expect(asFiscalYear(2101).ok).toBe(false);
  });

  it('rejects non-integer', () => {
    expect(asFiscalYear(2026.5).ok).toBe(false);
  });

  it('asFiscalYearUnsafe throws on bad input', () => {
    expect(() => asFiscalYearUnsafe(1500)).toThrow();
  });

  it('asFiscalYearUnsafe returns value on ok input', () => {
    expect(asFiscalYearUnsafe(2026)).toBe(2026);
  });

  describe('fiscalYearFromUtcIso — Asia/Bangkok boundary', () => {
    it('default startMonth=1: 2026-01-15 UTC → FY 2026', () => {
      expect(fiscalYearFromUtcIso('2026-01-15T12:00:00Z', 1)).toBe(2026);
    });

    it('Dec 31 23:59:59 UTC → Jan 1 06:59:59 Bangkok → FY 2026 when calendar Jan', () => {
      // Bangkok is UTC+7 → 2025-12-31T23:59:59Z + 7h = 2026-01-01T06:59:59
      expect(fiscalYearFromUtcIso('2025-12-31T23:59:59Z', 1)).toBe(2026);
    });

    it('Jan 1 00:00:01 UTC → Jan 1 07:00:01 Bangkok → FY 2026', () => {
      expect(fiscalYearFromUtcIso('2026-01-01T00:00:01Z', 1)).toBe(2026);
    });

    it('April-start tenant: 2026-03-31 Bangkok → FY 2025', () => {
      expect(fiscalYearFromUtcIso('2026-03-31T10:00:00Z', 4)).toBe(2025);
    });

    it('April-start tenant: 2026-04-01 Bangkok → FY 2026', () => {
      expect(fiscalYearFromUtcIso('2026-04-01T10:00:00Z', 4)).toBe(2026);
    });
  });
});
