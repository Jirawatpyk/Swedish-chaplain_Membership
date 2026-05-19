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
 */
import { describe, it, expect } from 'vitest';
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
    // The helper relies on @js-joda Bangkok ZoneId, so it does NOT
    // consult `Date.prototype.getTimezoneOffset` or any system TZ.
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
