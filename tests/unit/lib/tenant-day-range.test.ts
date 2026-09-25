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
import { isYmd, tenantDayRangeUtc, tenantDayStartUtc, tenantDayEndUtc } from '@/lib/tenant-day-range';

describe('tenantDayStartUtc / tenantDayEndUtc', () => {
  it('Asia/Bangkok (UTC+7) — local day maps to the offset UTC instants', () => {
    // 2026-05-27 00:00 +07 = 2026-05-26 17:00Z; 23:59:59.999999 +07 = 2026-05-27 16:59:59.999999Z
    // End cap is microsecond-precise (.999999) so it covers a timestamptz(6)
    // column's full final second under an inclusive `lte` (F9 #14).
    expect(tenantDayStartUtc('2026-05-27', 'Asia/Bangkok')).toBe('2026-05-26T17:00:00Z');
    expect(tenantDayEndUtc('2026-05-27', 'Asia/Bangkok')).toBe('2026-05-27T16:59:59.999999Z');
  });

  it('UTC — identity (start of day, end of day)', () => {
    expect(tenantDayStartUtc('2026-05-27', 'UTC')).toBe('2026-05-27T00:00:00Z');
    expect(tenantDayEndUtc('2026-05-27', 'UTC')).toBe('2026-05-27T23:59:59.999999Z');
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

/**
 * F119 FR-030 — the E-Blast dashboard's date range as a HALF-OPEN interval of
 * instants: `[start of fromDate, start of the day after toDate)` in the tenant
 * timezone. Half-open because a `Date` carries milliseconds only — an inclusive
 * `lte` on `new Date(tenantDayEndUtc(…))` would drop the final 999 µs of the
 * `to` day on a `timestamptz(6)` column (F9 #14's class).
 */
describe('tenantDayRangeUtc', () => {
  it('Asia/Bangkok — from = 00:00 +07 of fromDate, toExclusive = 00:00 +07 of the day AFTER toDate', () => {
    const r = tenantDayRangeUtc('2026-03-10', '2026-03-15', 'Asia/Bangkok');
    expect(r.fromInclusive?.toISOString()).toBe('2026-03-09T17:00:00.000Z');
    expect(r.toExclusive?.toISOString()).toBe('2026-03-15T17:00:00.000Z');
  });

  it('a one-day range is exactly 24 h wide, whatever the zone', () => {
    const r = tenantDayRangeUtc('2026-03-15', '2026-03-15', 'Asia/Bangkok');
    expect(r.toExclusive!.getTime() - r.fromInclusive!.getTime()).toBe(24 * 3_600_000);
  });

  it('the day after the end of a month / year rolls over', () => {
    expect(tenantDayRangeUtc(undefined, '2026-12-31', 'Asia/Bangkok').toExclusive?.toISOString()).toBe(
      '2026-12-31T17:00:00.000Z',
    );
  });

  it('Europe/Stockholm — the end bound follows the zone on the day it applies (CET → CEST)', () => {
    // 2026-03-29 is the spring-forward day: 00:00 CEST(+02) on 03-30 = 03-29 22:00Z.
    expect(tenantDayRangeUtc(undefined, '2026-03-29', 'Europe/Stockholm').toExclusive?.toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
  });

  it('each side is optional; an absent side is absent, not an unbounded instant', () => {
    expect(tenantDayRangeUtc(undefined, undefined, 'Asia/Bangkok')).toEqual({});
    expect(tenantDayRangeUtc('2026-03-10', undefined, 'Asia/Bangkok')).toEqual({
      fromInclusive: new Date('2026-03-09T17:00:00.000Z'),
    });
    expect(tenantDayRangeUtc(undefined, '2026-03-10', 'Asia/Bangkok')).toEqual({
      toExclusive: new Date('2026-03-10T17:00:00.000Z'),
    });
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
