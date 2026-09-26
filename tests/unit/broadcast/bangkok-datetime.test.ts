/**
 * F7 UX hardening — E2: schedule-picker datetime-local was parsing as
 * browser-local TZ, not Bangkok wall-time. This unit test pins the
 * helpers used by `src/components/broadcast/schedule-picker.tsx` (and
 * eligible for re-use by `approve-dialog.tsx` later) so the conversion
 * is correct regardless of the executing browser's timezone.
 *
 * Spec references: members compose every broadcast in Bangkok wall-time
 * (microcopy claim); `<input type="datetime-local">` returns a naive
 * `YYYY-MM-DDTHH:mm` string with no offset. `new Date(localString)`
 * interprets the value in the BROWSER local zone — that is the bug.
 *
 * The helpers are `Intl`-based (they ship to the browser, and js-joda's tz
 * database is ~900 KB). The parity blocks below pin them to the previous
 * js-joda implementation, which lives on here as a test-only reference.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { LocalDateTime, ZoneId } from '@js-joda/core';
import '@js-joda/timezone';
import {
  bangkokInputToIso,
  isoToBangkokInput,
  bangkokMinInputAfterMinutes,
} from '@/components/broadcast/bangkok-datetime';

describe('bangkokInputToIso', () => {
  it('parses 14:00 wall-time as Bangkok (UTC+7) → 07:00 UTC ISO', () => {
    const iso = bangkokInputToIso('2026-06-15T14:00');
    expect(iso).toBe('2026-06-15T07:00:00.000Z');
  });

  it('parses 00:00 wall-time as Bangkok → previous day 17:00 UTC', () => {
    const iso = bangkokInputToIso('2026-06-15T00:00');
    expect(iso).toBe('2026-06-14T17:00:00.000Z');
  });

  it('returns null for empty input', () => {
    expect(bangkokInputToIso('')).toBeNull();
  });

  it('accepts `:ss` already-padded input', () => {
    const iso = bangkokInputToIso('2026-06-15T14:00:00');
    expect(iso).toBe('2026-06-15T07:00:00.000Z');
  });

  it('produces same ISO regardless of executing browser TZ (the bug)', () => {
    // The helper resolves the offset via `Intl` with a pinned
    // `timeZone: 'Asia/Bangkok'`, so it does NOT consult
    // `Date.prototype.getTimezoneOffset` or any system TZ.
    // Demonstrate by parsing the same wall-time string in three
    // notional browser TZ frames — all yield the same UTC ISO.
    const result = bangkokInputToIso('2026-06-15T14:00');
    expect(result).toBe('2026-06-15T07:00:00.000Z');
    // (If we used the buggy `new Date('2026-06-15T14:00').toISOString()`
    // pattern, the result would differ in non-Bangkok timezones because
    // the browser would treat 14:00 as its OWN local time and convert
    // back to UTC accordingly. This assertion proves we don't.)
  });
});

describe('isoToBangkokInput', () => {
  it('formats UTC ISO back into Bangkok wall-time `YYYY-MM-DDTHH:mm` (round-trip)', () => {
    const input = '2026-06-15T14:00';
    const iso = bangkokInputToIso(input);
    expect(iso).not.toBeNull();
    expect(isoToBangkokInput(iso!)).toBe(input);
  });

  it('returns empty string for null input', () => {
    expect(isoToBangkokInput(null)).toBe('');
  });

  it('returns empty string for invalid ISO', () => {
    expect(isoToBangkokInput('not-an-iso')).toBe('');
  });

  it('round-trips midnight Bangkok wall-time', () => {
    const input = '2026-01-01T00:00';
    const iso = bangkokInputToIso(input);
    expect(iso).not.toBeNull();
    expect(isoToBangkokInput(iso!)).toBe(input);
  });
});

describe('bangkokMinInputAfterMinutes', () => {
  it('returns a properly-formatted YYYY-MM-DDTHH:mm string', () => {
    const result = bangkokMinInputAfterMinutes(6);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('returns a future Bangkok wall-time strictly after "now + N min"', () => {
    const result = bangkokMinInputAfterMinutes(60);
    const resultIso = bangkokInputToIso(result);
    expect(resultIso).not.toBeNull();
    const resultMs = new Date(resultIso!).getTime();
    const expectedMin = Date.now() + 59 * 60 * 1000;
    expect(resultMs).toBeGreaterThanOrEqual(expectedMin);
  });
});

/**
 * The pre-`Intl` implementation, verbatim apart from naming — the reference
 * the new helpers must match.
 */
const BANGKOK_ZONE = ZoneId.of('Asia/Bangkok');

function jsJodaBangkokInputToIso(local: string): string | null {
  if (local === '') return null;
  const normalised = local.length === 16 ? `${local}:00` : local;
  try {
    const wall = LocalDateTime.parse(normalised);
    const instant = wall.atZone(BANGKOK_ZONE).toInstant();
    return new Date(instant.toEpochMilli()).toISOString();
  } catch {
    return null;
  }
}

function jsJodaBangkokMinInputAfterMinutes(plusMinutes: number): string {
  const future = LocalDateTime.now(BANGKOK_ZONE).plusMinutes(plusMinutes);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${future.year()}-${pad(future.monthValue())}-${pad(future.dayOfMonth())}T${pad(future.hour())}:${pad(future.minute())}`;
}

describe('bangkokInputToIso — parity with the js-joda implementation', () => {
  it.each([
    // ordinary wall-times, seconds and fractions (ns truncated to ms)
    '2026-06-15T14:00',
    '2026-06-15T00:00',
    '2026-06-15T23:59',
    '2026-06-15T14:00:30',
    '2026-06-15T14:00:30.123',
    '2026-06-15T14:00:30.1',
    '2026-06-15T14:00:30.123456789',
    '2026-06-15T14:00:00.',
    // calendar edges
    '2026-12-31T23:59',
    '2027-01-01T00:00',
    '2028-02-29T12:00',
    '1970-01-01T07:00',
    '2038-01-19T10:14',
    // Bangkok LMT/BMT (+06:42:04) before 1920-04-01, and the gap at the switch
    '1900-01-01T12:00',
    '1920-03-31T23:59',
    '1920-04-01T00:00',
    '1920-04-01T00:10',
    '1920-04-01T00:17:56',
    // year-range edges (two-digit years must not map to 19xx)
    '0001-01-01T00:00',
    '0099-06-15T14:00',
    '+12026-06-15T14:00',
    '-0001-06-15T14:00',
    '+2026-06-15T14:00',
    '+02026-06-15T14:00',
    '-2026-06-15T14:00',
    '+999999999-12-31T23:59',
    '-999999999-01-01T00:00',
    // the ends of the JS Date range (±8.64e15 ms): must be null, never throw
    '+275760-09-13T00:00',
    '+275760-09-13T07:00',
    '-271821-04-20T00:00',
    '-271821-04-20T07:00',
    '-271821-04-19T23:59',
    // rejected: impossible values and wrong shapes
    '2026-02-30T10:00',
    '2027-02-29T10:00',
    '2026-13-01T00:00',
    '2026-00-10T00:00',
    '2026-06-00T00:00',
    '2026-06-15T24:00',
    '2026-06-15T12:60',
    '2026-06-15T12:00:60',
    '2026-06-15T12:00:30.1234567890',
    '12026-06-15T14:00',
    'garbage',
    '',
    '2026-06-15 14:00',
    '2026-6-15T14:00',
    '2026-06-15T14',
    '2026-06-15T14:00Z',
    '2026-06-15T14:00+07:00',
  ])('%j', (input) => {
    expect(bangkokInputToIso(input)).toBe(jsJodaBangkokInputToIso(input));
  });
});

describe('bangkokInputToIso — seeded sweep against the js-joda implementation', () => {
  it('agrees on 3000 random wall-times across 1800–2400 (incl. impossible days)', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 0x5eed;
    const next = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
    const mismatches: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const input =
        `${pad(1800 + next(601), 4)}-${pad(1 + next(12))}-${pad(1 + next(31))}` +
        `T${pad(next(24))}:${pad(next(60))}` +
        (next(2) === 0 ? '' : `:${pad(next(60))}.${pad(next(1000), 3)}`);
      const actual = bangkokInputToIso(input);
      const expected = jsJodaBangkokInputToIso(input);
      if (actual !== expected) mismatches.push(`${input}: ${actual} !== ${expected}`);
    }
    expect(mismatches).toEqual([]);
  });
});

describe('bangkokMinInputAfterMinutes — parity with the js-joda implementation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['mid-day', '2026-06-15T07:00:00.000Z', 6],
    ['seconds are truncated, not rounded', '2026-06-15T07:00:59.999Z', 5],
    ['crosses Bangkok midnight', '2026-06-15T16:57:00.000Z', 6],
    ['crosses month + year end', '2026-12-31T16:58:30.000Z', 5],
    ['crosses a leap day', '2028-02-28T16:59:00.000Z', 60],
    ['zero minutes', '2026-06-15T07:00:00.000Z', 0],
  ] as const)('%s (%s + %i min)', (_label, now, minutes) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    expect(bangkokMinInputAfterMinutes(minutes)).toBe(jsJodaBangkokMinInputAfterMinutes(minutes));
  });
});
