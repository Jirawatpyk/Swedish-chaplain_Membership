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
