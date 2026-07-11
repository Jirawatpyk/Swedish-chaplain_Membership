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
 * paid/partially_credited/credited statuses and NET the credited portion.
 *
 * F9 revenue is NET-OF-VAT — the figure is labelled "รายได้/Revenue", and
 * revenue excludes output VAT (ภาษีขาย, a liability to the RD, not income). So
 * each invoice contributes its ex-VAT amount (`subtotal`), scaled proportionally
 * by any credit — NOT the VAT-inclusive `total`.
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

// A fully-paid, ZERO-VAT invoice (subtotal == total) with no credit → its ex-VAT
// revenue equals `satang`.
const paidRow = (satang: bigint) => ({
  status: 'paid',
  subtotal: { satang },
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

describe('invoiceSourceAdapter.getYtdPaidRevenueSatang — net-of-VAT', () => {
  it('excludes output VAT — a 7% invoice contributes its ex-VAT subtotal, not the gross total', async () => {
    getForIssueMock.mockResolvedValue({ fiscalYearStartMonth: 1 });
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          // 100,000 ex-VAT + 7,000 VAT = 107,000 gross → revenue is 100,000.
          { status: 'paid', subtotal: { satang: 100_000n }, total: { satang: 107_000n }, creditedTotal: { satang: 0n } },
        ],
        nextCursor: null,
      },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-02-15T00:00:00.000Z',
    );

    expect(total).toBe(100_000n); // ex-VAT, NOT the 107,000 gross
  });
});

describe('invoiceSourceAdapter.getYtdPaidRevenueSatang — credit-note netting', () => {
  it('nets the credited portion (ex-VAT) instead of dropping the whole invoice', async () => {
    getForIssueMock.mockResolvedValue({ fiscalYearStartMonth: 1 });
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          // Fully paid, no credit → ex-VAT 100,000 (gross 107,000).
          { status: 'paid', subtotal: { satang: 100_000n }, total: { satang: 107_000n }, creditedTotal: { satang: 0n } },
          // Partially credited (gross 21,400 of 107,000) → ex-VAT nets to 80,000.
          {
            status: 'partially_credited',
            subtotal: { satang: 100_000n },
            total: { satang: 107_000n },
            creditedTotal: { satang: 21_400n },
          },
          // Fully credited → nets to 0.
          {
            status: 'credited',
            subtotal: { satang: 50_000n },
            total: { satang: 53_500n },
            creditedTotal: { satang: 53_500n },
          },
          // Issued (unpaid) → excluded from paid revenue.
          { status: 'issued', subtotal: { satang: 999n }, total: { satang: 1_069n }, creditedTotal: { satang: 0n } },
          // Void → excluded.
          { status: 'void', subtotal: { satang: 777n }, total: { satang: 831n }, creditedTotal: { satang: 0n } },
        ],
        nextCursor: null,
      },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-02-15T00:00:00.000Z',
    );

    // 100,000 + (100,000 − 20,000) + 0 = 180,000 (ex-VAT).
    expect(total).toBe(180_000n);
    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'all' }),
    );
  });
});

describe('invoiceSourceAdapter — auto_refunded payment money is non-revenue (M-h)', () => {
  // F5 `auto_refunded` is a terminal PAYMENT status reached ONLY from `pending`
  // (the stale-invoice auto-refund path): the Stripe charge was captured for an
  // invoice that was no longer payable (voided / credited / already paid
  // out-of-band), so it NEVER settled the invoice. F9 revenue is driven purely
  // by INVOICE status + credit-note netting (it never sums the `payments`
  // table), so an auto_refunded payment's money is structurally excluded. These
  // lock that invariant — mirroring the F9 credit-note lesson (do NOT drop the
  // whole invoice; do NOT double-count).

  it('YTD: a voided invoice (auto-refund on a stale/voided invoice) contributes 0 revenue', async () => {
    getForIssueMock.mockResolvedValue({ fiscalYearStartMonth: 1 });
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          // The auto-refunded Stripe charge left the invoice `void` → excluded.
          { status: 'void', subtotal: { satang: 100_000n }, total: { satang: 107_000n }, creditedTotal: { satang: 0n } },
        ],
        nextCursor: null,
      },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-02-15T00:00:00.000Z',
    );

    expect(total).toBe(0n);
  });

  it('YTD: an invoice paid OUT-OF-BAND with a duplicate auto_refunded Stripe charge is counted EXACTLY ONCE (no double-count)', async () => {
    getForIssueMock.mockResolvedValue({ fiscalYearStartMonth: 1 });
    // The member paid out-of-band (bank transfer) → invoice is `paid` and
    // counts once. The concurrent Stripe charge was auto_refunded (a duplicate
    // that never settled the invoice). Because F9 sums the INVOICE by status —
    // not the `payments` rows — the auto_refunded money adds nothing: the
    // invoice contributes its ex-VAT subtotal exactly once, not twice.
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          { status: 'paid', subtotal: { satang: 100_000n }, total: { satang: 107_000n }, creditedTotal: { satang: 0n } },
        ],
        nextCursor: null,
      },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-02-15T00:00:00.000Z',
    );

    expect(total).toBe(100_000n); // ex-VAT, counted once — NOT 200,000
  });

  it('monthly trend: a voided invoice (auto-refund outcome) never appears in the settled-revenue trend', async () => {
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          {
            status: 'void',
            paidAt: '2026-03-10T05:00:00.000Z',
            subtotal: { satang: 100_000n },
            total: { satang: 107_000n },
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

    expect(buckets['2026-03']).toBeUndefined();
  });
});

describe('invoiceSourceAdapter.getMonthlyPaidRevenueSatang — credit-note netting', () => {
  it('buckets net-of-VAT revenue by settle month across paid + credited statuses', async () => {
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          {
            status: 'paid',
            paidAt: '2026-03-15T05:00:00.000Z',
            subtotal: { satang: 500_000n },
            total: { satang: 535_000n },
            creditedTotal: { satang: 0n },
          },
          {
            status: 'partially_credited',
            paidAt: '2026-03-20T05:00:00.000Z',
            subtotal: { satang: 100_000n },
            total: { satang: 107_000n },
            creditedTotal: { satang: 10_700n },
          },
          // Unpaid — must not appear in a "revenue realised" trend.
          {
            status: 'issued',
            paidAt: null,
            issueDate: '2026-03-01',
            subtotal: { satang: 999n },
            total: { satang: 1_069n },
            creditedTotal: { satang: 0n },
          },
          // Void — excluded.
          {
            status: 'void',
            paidAt: '2026-03-10T05:00:00.000Z',
            subtotal: { satang: 200_000n },
            total: { satang: 214_000n },
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

    // 500,000 + (100,000 − 10,000) = 590,000 (ex-VAT).
    expect(buckets['2026-03']).toBe(590_000n);
    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'all' }),
    );
  });
});
