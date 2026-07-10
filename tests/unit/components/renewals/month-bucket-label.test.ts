import { describe, expect, it } from 'vitest';
import { formatMonthKeyLabel } from '@/components/renewals/month-bucket-label';

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
