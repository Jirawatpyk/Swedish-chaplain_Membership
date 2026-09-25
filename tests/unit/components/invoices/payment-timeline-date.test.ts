import { describe, it, expect } from 'vitest';
import { formatTimestamp } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline-format';

describe('payment-timeline formatTimestamp', () => {
  it('renders the BE year for th (explicit, not ICU-default)', () => {
    const out = formatTimestamp(new Date('2026-05-29T03:00:00.000Z'), 'th');
    expect(out).toContain('2569');
  });
  it('renders Gregorian for en', () => {
    const out = formatTimestamp(new Date('2026-05-29T03:00:00.000Z'), 'en');
    expect(out).toContain('2026');
  });
});

describe('payment-timeline formatTimestamp — English uses en-GB (ux-standards § 12.3)', () => {
  it('day-first, 24-hour, Bangkok time', () => {
    // 07:10 UTC = 14:10 Bangkok.
    const out = formatTimestamp(new Date('2026-09-23T07:10:00.000Z'), 'en');
    expect(out).toMatch(/^23 Sept? 2026, 14:10/);
    expect(out).not.toContain('PM');
  });
});
