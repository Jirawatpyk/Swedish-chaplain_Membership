import { describe, expect, it, vi } from 'vitest';

// 057 R2 finding C — `listInvoicesPaged` is typed `Result<…, never>` and has
// no try/catch, so a DB error THROWS. We mock the invoicing barrel so the call
// throws and assert `loadDashboardOutstanding` resolves to the error sentinel
// (not a crash). `makeListInvoicesDeps` is stubbed so no live DB is touched.
vi.mock('@/modules/invoicing', () => ({
  listInvoicesPaged: vi.fn(async () => {
    throw new Error('simulated DB read failure');
  }),
  makeListInvoicesDeps: vi.fn(() => ({ invoiceRepo: {} })),
}));

import {
  toOutstandingInvoiceInputs,
  loadDashboardOutstanding,
} from '@/app/(member)/portal/_components/dashboard-reads';

describe('loadDashboardOutstanding — error resilience (finding C)', () => {
  it('returns the error sentinel when the invoice read THROWS (not a crash)', async () => {
    const read = await loadDashboardOutstanding('tenant-1', 'member-1');
    expect(read.error).toBe(true);
    expect(read.inputs).toEqual([]);
    expect(read.total).toBe(0);
    expect(read.partial).toBe(false);
  });
});

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
