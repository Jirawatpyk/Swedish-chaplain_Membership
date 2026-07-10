/**
 * F9 #4 — the dashboard YTD-paid-revenue KPI must window by the tenant FISCAL
 * year (matching how invoices.fiscalYear is tagged at issue time), not the
 * calendar year. invoiceSourceAdapter.getYtdPaidRevenueSatang derives the fiscal
 * year from `nowIso` + the tenant's fiscalYearStartMonth and filters by it.
 *
 * F9 credit-note netting — a paid invoice that later receives a credit note has
 * its status flipped paid → partially_credited / credited, so an exact
 * `status:'paid'` filter would drop the ENTIRE invoice from the revenue figures.
 * Both the YTD KPI and the monthly trend must instead include the
 * paid/partially_credited/credited statuses and NET the credited portion
 * (`total − creditedTotal`), so a partial credit reduces revenue by exactly the
 * credited amount, not by the whole invoice.
 *
 * The invoicing barrel is mocked; `@/lib/fiscal-year` (deriveFiscalYear) is the
 * REAL pure helper so the derivation is exercised end-to-end.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const listInvoicesMock = vi.hoisted(() => vi.fn());
const getForIssueMock = vi.hoisted(() => vi.fn());

vi.mock('@/modules/invoicing', () => ({
  makeListInvoicesDeps: () => ({}),
  listInvoices: listInvoicesMock,
  computeIsOverdue: () => false,
  drizzleTenantSettingsRepo: { getForIssue: getForIssueMock },
}));

const { invoiceSourceAdapter } = await import(
  '@/modules/insights/infrastructure/sources/invoice-source-adapter'
);
const { asTenantContext } = await import('@/modules/tenants');

const ctx = asTenantContext('tenant-a');

// A fully-paid invoice with no credit note contributes its full total.
const paidRow = (satang: bigint) => ({
  status: 'paid',
  total: { satang },
  creditedTotal: { satang: 0n },
});

beforeEach(() => {
  listInvoicesMock.mockReset();
  getForIssueMock.mockReset();
});

describe('invoiceSourceAdapter.getYtdPaidRevenueSatang — fiscal-year windowing (F9 #4)', () => {
  it('an April-start tenant on 2026-02-15 windows by FY 2025, not calendar 2026', async () => {
    getForIssueMock.mockResolvedValue({ fiscalYearStartMonth: 4 });
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: { rows: [paidRow(500n)], nextCursor: null },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-02-15T00:00:00.000Z',
    );

    expect(total).toBe(500n);
    // Feb 2026 (Bangkok) with an April-start fiscal year → FY 2025. The status
    // filter must be 'all' (not 'paid') so credited invoices are not dropped;
    // the adapter nets them below.
    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fiscalYear: 2025, status: 'all' }),
    );
  });

  it('a January-start tenant uses FY == calendar year (SweCham — unchanged)', async () => {
    getForIssueMock.mockResolvedValue({ fiscalYearStartMonth: 1 });
    listInvoicesMock.mockResolvedValue({ ok: true, value: { rows: [], nextCursor: null } });

    await invoiceSourceAdapter.getYtdPaidRevenueSatang(ctx, '2026-02-15T00:00:00.000Z');

    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fiscalYear: 2026 }),
    );
  });

  it('falls back to January-start when no tenant invoice settings row exists', async () => {
    getForIssueMock.mockResolvedValue(null);
    listInvoicesMock.mockResolvedValue({ ok: true, value: { rows: [], nextCursor: null } });

    await invoiceSourceAdapter.getYtdPaidRevenueSatang(ctx, '2026-02-15T00:00:00.000Z');

    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fiscalYear: 2026 }),
    );
  });
});

describe('invoiceSourceAdapter.getYtdPaidRevenueSatang — credit-note netting', () => {
  it('nets the credited portion instead of dropping the whole invoice', async () => {
    getForIssueMock.mockResolvedValue({ fiscalYearStartMonth: 1 });
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          // Fully paid, no credit → full 100,000.
          { status: 'paid', total: { satang: 100_000n }, creditedTotal: { satang: 0n } },
          // Partially credited 20,000 → nets to 80,000 (NOT dropped, NOT 100,000).
          {
            status: 'partially_credited',
            total: { satang: 100_000n },
            creditedTotal: { satang: 20_000n },
          },
          // Fully credited → nets to 0.
          {
            status: 'credited',
            total: { satang: 50_000n },
            creditedTotal: { satang: 50_000n },
          },
          // Issued (unpaid) → excluded from paid revenue.
          { status: 'issued', total: { satang: 999n }, creditedTotal: { satang: 0n } },
          // Void → excluded.
          { status: 'void', total: { satang: 777n }, creditedTotal: { satang: 0n } },
        ],
        nextCursor: null,
      },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-02-15T00:00:00.000Z',
    );

    // 100,000 + (100,000 − 20,000) + (50,000 − 50,000) = 180,000.
    expect(total).toBe(180_000n);
    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'all' }),
    );
  });
});

describe('invoiceSourceAdapter.getMonthlyPaidRevenueSatang — credit-note netting', () => {
  it('buckets net (total − credited) by settle month across paid + credited statuses', async () => {
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          {
            status: 'paid',
            paidAt: '2026-03-15T05:00:00.000Z',
            total: { satang: 500_000n },
            creditedTotal: { satang: 0n },
          },
          {
            status: 'partially_credited',
            paidAt: '2026-03-20T05:00:00.000Z',
            total: { satang: 100_000n },
            creditedTotal: { satang: 10_000n },
          },
          // Unpaid — must not appear in a "revenue realised" trend.
          {
            status: 'issued',
            paidAt: null,
            issueDate: '2026-03-01',
            total: { satang: 999n },
            creditedTotal: { satang: 0n },
          },
          // Void — excluded.
          {
            status: 'void',
            paidAt: '2026-03-10T05:00:00.000Z',
            total: { satang: 200_000n },
            creditedTotal: { satang: 0n },
          },
        ],
        nextCursor: null,
      },
    });

    const buckets = await invoiceSourceAdapter.getMonthlyPaidRevenueSatang(
      ctx,
      ['2026-03'],
      'Asia/Bangkok',
    );

    // 500,000 + (100,000 − 10,000) = 590,000.
    expect(buckets['2026-03']).toBe(590_000n);
    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'all' }),
    );
  });
});
