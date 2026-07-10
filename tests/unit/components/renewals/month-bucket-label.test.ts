import { describe, expect, it } from 'vitest';
import {
  bandForBucketIndex,
  formatMonthKeyLabel,
} from '@/components/renewals/month-bucket-label';

describe('formatMonthKeyLabel', () => {
  it('renders EN month + Gregorian year', () => {
    const label = formatMonthKeyLabel('2027-07', 'en');
    expect(label).toContain('July');
    expect(label).toContain('2027');
  });

  it('renders TH month with the BUDDHIST-ERA year (2569, never 2026)', () => {
    const label = formatMonthKeyLabel('2026-12', 'th');
    expect(label).toContain('2569'); // 2026 + 543
    expect(label).not.toContain('2026');
  });

  it('does not drift a month across the UTC boundary', () => {
    // 2026-12 must render December, not November.
    expect(formatMonthKeyLabel('2026-12', 'en')).toContain('December');
  });
});

describe('bandForBucketIndex', () => {
  it('index 0 (overdue) → red (t-0)', () => {
    expect(bandForBucketIndex(0)).toBe('t-0');
  });

  it('index 1 (current month) → orange (t-7)', () => {
    expect(bandForBucketIndex(1)).toBe('t-7');
  });

  it('indices 2 and 3 (next 1-2 months) → amber (t-14)', () => {
    expect(bandForBucketIndex(2)).toBe('t-14');
    expect(bandForBucketIndex(3)).toBe('t-14');
  });

  it('later indices → slate (t-90)', () => {
    expect(bandForBucketIndex(4)).toBe('t-90');
    expect(bandForBucketIndex(13)).toBe('t-90');
  });
});
