import { describe, expect, it } from 'vitest';
import {
  bandForBucketIndex,
  formatMonthKeyLabel,
  formatMonthKeyShort,
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

  it('renders SV month + Gregorian year (no BE offset)', () => {
    // Swedish uses the Gregorian calendar — unlike th-TH, sv-SE never gets
    // the `-u-ca-buddhist` variant, so the year must render unmodified.
    const label = formatMonthKeyLabel('2027-07', 'sv');
    expect(label).toContain('juli');
    expect(label).toContain('2027');
  });
});

describe('formatMonthKeyShort (compact axis label)', () => {
  it('renders EN abbreviated month + 2-digit Gregorian year', () => {
    const label = formatMonthKeyShort('2027-07', 'en'); // "Jul 27"
    expect(label).toMatch(/Jul/);
    expect(label).toContain('27');
  });

  it('renders TH 2-digit BUDDHIST-ERA year (69 for BE 2569, never the Gregorian 26)', () => {
    // Same off-by-543 ship-blocker guard as formatMonthKeyLabel, for the
    // year:'2-digit' branch: "ธ.ค. 69", not "ธ.ค. 26".
    const label = formatMonthKeyShort('2026-12', 'th');
    expect(label).toContain('69'); // BE 2569
    expect(label).not.toContain('26'); // not the Gregorian 2-digit year
  });

  it('rolls the TH BE year across the Gregorian year boundary (2027-01 → 70)', () => {
    const label = formatMonthKeyShort('2027-01', 'th');
    expect(label).toContain('70'); // BE 2570
    expect(label).not.toContain('27');
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
