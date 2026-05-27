/**
 * `trend-window` unit test (FR-001a) — pure tenant-tz month-key math. Covers
 * the off-by-one / year-rollover / timezone-day-boundary classes that bare
 * `Date` arithmetic gets wrong.
 */
import { describe, expect, it } from 'vitest';
import { lastNMonthKeys, monthKeyOf } from '@/modules/insights/domain/trend-window';

describe('monthKeyOf', () => {
  it('returns the tenant-tz YYYY-MM', () => {
    expect(monthKeyOf(new Date('2026-06-15T05:00:00.000Z'), 'UTC')).toBe('2026-06');
  });

  it('buckets by the TENANT-LOCAL month, not the UTC month (day-boundary)', () => {
    // 2026-03-31 20:00 UTC = 2026-04-01 03:00 in Asia/Bangkok (UTC+7).
    const instant = new Date('2026-03-31T20:00:00.000Z');
    expect(monthKeyOf(instant, 'UTC')).toBe('2026-03');
    expect(monthKeyOf(instant, 'Asia/Bangkok')).toBe('2026-04');
  });

  it('is stable across a DST transition in a DST-observing tz (Europe/Stockholm, SV locale)', () => {
    // SV is a first-class locale; Stockholm observes DST. 2026 spring-forward is
    // 2026-03-29 (CET→CEST). An instant just after the shift must still bucket to
    // the correct local month regardless of the UTC-offset change.
    const justAfterSpringForward = new Date('2026-03-29T02:30:00.000Z'); // 04:30 CEST
    expect(monthKeyOf(justAfterSpringForward, 'Europe/Stockholm')).toBe('2026-03');
    // Autumn fall-back (2026-10-25, CEST→CET) — late October stays in October.
    const aroundFallBack = new Date('2026-10-25T01:30:00.000Z');
    expect(monthKeyOf(aroundFallBack, 'Europe/Stockholm')).toBe('2026-10');
  });
});

describe('lastNMonthKeys', () => {
  it('returns n keys oldest→newest, inclusive of the current month', () => {
    const keys = lastNMonthKeys(new Date('2026-06-15T00:00:00.000Z'), 'UTC', 12);
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe('2025-07');
    expect(keys.at(-1)).toBe('2026-06');
  });

  it('rolls over the year boundary (Jan → previous Feb)', () => {
    const keys = lastNMonthKeys(new Date('2026-01-15T00:00:00.000Z'), 'UTC', 12);
    expect(keys).toEqual([
      '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07',
      '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01',
    ]);
  });

  it('walks back across multiple years', () => {
    const keys = lastNMonthKeys(new Date('2026-03-15T00:00:00.000Z'), 'UTC', 24);
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe('2024-04');
    expect(keys.at(-1)).toBe('2026-03');
  });

  it('n=1 returns just the current month', () => {
    expect(lastNMonthKeys(new Date('2026-06-15T00:00:00.000Z'), 'UTC', 1)).toEqual(['2026-06']);
  });

  it('uses the tenant tz for the current month (day-boundary)', () => {
    // Late-UTC instant that is next month in Bangkok.
    const keys = lastNMonthKeys(new Date('2026-03-31T20:00:00.000Z'), 'Asia/Bangkok', 3);
    expect(keys).toEqual(['2026-02', '2026-03', '2026-04']);
  });

  it('emits keys in lexicographic == chronological order (the member-adapter baseline contract)', () => {
    // member-source-adapter relies on `YYYY-MM` sorting lexicographically ==
    // chronologically (`key < firstKey` ⇒ joined before the window → baseline).
    // Pin that property so a key-format change can't silently break the baseline.
    const keys = lastNMonthKeys(new Date('2026-01-15T00:00:00.000Z'), 'UTC', 12);
    const sorted = [...keys].sort(); // default string sort
    expect(keys).toEqual(sorted);
    // Spot-check the year-boundary ordering the baseline math depends on.
    expect('2025-12' < '2026-01').toBe(true);
    expect(keys[0]! < keys.at(-1)!).toBe(true);
  });
});
