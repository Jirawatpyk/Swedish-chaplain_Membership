/**
 * `tenant-day-range` unit test (F9 US2 / FR-009 — the C2 UTC-gap fix).
 *
 * A local calendar day must map to the exact UTC instants that bound it in the
 * tenant timezone — a UTC-literal boundary silently drops a partial day for
 * non-UTC tenants. Pins the primary tenant tz (Asia/Bangkok, UTC+7), a UTC
 * identity case, and a DST-observing tz (Europe/Stockholm) since the helper
 * advertises DST-correctness.
 */
import { describe, expect, it } from 'vitest';
import { isYmd, tenantDayStartUtc, tenantDayEndUtc } from '@/lib/tenant-day-range';

describe('tenantDayStartUtc / tenantDayEndUtc', () => {
  it('Asia/Bangkok (UTC+7) — local day maps to the offset UTC instants', () => {
    // 2026-05-27 00:00 +07 = 2026-05-26 17:00Z; 23:59:59.999 +07 = 2026-05-27 16:59:59.999Z
    expect(tenantDayStartUtc('2026-05-27', 'Asia/Bangkok')).toBe('2026-05-26T17:00:00Z');
    expect(tenantDayEndUtc('2026-05-27', 'Asia/Bangkok')).toBe('2026-05-27T16:59:59.999Z');
  });

  it('UTC — identity (start of day, end of day)', () => {
    expect(tenantDayStartUtc('2026-05-27', 'UTC')).toBe('2026-05-27T00:00:00Z');
    expect(tenantDayEndUtc('2026-05-27', 'UTC')).toBe('2026-05-27T23:59:59.999Z');
  });

  it('Europe/Stockholm — DST-correct (CEST = UTC+2 in summer)', () => {
    // 2026-07-01 00:00 CEST(+02) = 2026-06-30 22:00Z
    expect(tenantDayStartUtc('2026-07-01', 'Europe/Stockholm')).toBe('2026-06-30T22:00:00Z');
    // winter: 2026-01-01 00:00 CET(+01) = 2025-12-31 23:00Z
    expect(tenantDayStartUtc('2026-01-01', 'Europe/Stockholm')).toBe('2025-12-31T23:00:00Z');
  });

  it('start < end for the same local day', () => {
    const s = new Date(tenantDayStartUtc('2026-05-27', 'Asia/Bangkok')).getTime();
    const e = new Date(tenantDayEndUtc('2026-05-27', 'Asia/Bangkok')).getTime();
    expect(s).toBeLessThan(e);
  });

  it('throws on a malformed date (caller must guard with isYmd first)', () => {
    expect(() => tenantDayStartUtc('garbage', 'UTC')).toThrow();
    expect(() => tenantDayStartUtc('2026-13-99', 'UTC')).toThrow();
  });
});

describe('isYmd', () => {
  it('accepts a well-shaped, calendar-VALID date', () => {
    expect(isYmd('2026-05-27')).toBe(true);
    expect(isYmd('2024-02-29')).toBe(true); // real leap day
  });

  it('rejects shape-malformed input', () => {
    expect(isYmd('2026-5-7')).toBe(false);
    expect(isYmd('garbage')).toBe(false);
    expect(isYmd('2026-05-27T00:00:00Z')).toBe(false);
    expect(isYmd('')).toBe(false);
  });

  it('rejects shape-valid but CALENDAR-IMPOSSIBLE dates (would throw in tenantDay*Utc)', () => {
    // These match \d{4}-\d{2}-\d{2} but LocalDate.parse throws — the guard MUST
    // reject them so callers return invalid_range, not a 500 / error card.
    expect(isYmd('2026-02-30')).toBe(false);
    expect(isYmd('2026-04-31')).toBe(false);
    expect(isYmd('2026-13-01')).toBe(false);
    expect(isYmd('2026-00-10')).toBe(false);
    expect(isYmd('2026-02-29')).toBe(false); // 2026 is not a leap year
  });
});
