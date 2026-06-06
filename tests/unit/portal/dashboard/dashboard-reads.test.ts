import { describe, expect, it } from 'vitest';
import { toOutstandingInvoiceInputs } from '@/app/(member)/portal/_components/dashboard-reads';

describe('toOutstandingInvoiceInputs', () => {
  it('maps Invoice rows to the pure outstanding shape (satang + due date)', () => {
    const rows = [
      {
        status: 'issued',
        total: { satang: 107_000n },
        dueDate: '2026-06-20',
      },
      {
        status: 'draft',
        total: null,
        dueDate: null,
      },
    ] as const;
    const out = toOutstandingInvoiceInputs(rows as never);
    expect(out).toEqual([
      { status: 'issued', totalSatang: 107_000n, dueDate: '2026-06-20' },
      { status: 'draft', totalSatang: null, dueDate: null },
    ]);
  });
});
