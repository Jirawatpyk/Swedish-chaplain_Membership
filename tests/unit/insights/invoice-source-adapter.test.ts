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

/**
 * Track B — the waived-refund netting map. Every case in this file predates
 * credit-note waivers and has none, so an empty map preserves exactly what
 * each assertion was written to test. The netting itself is exercised in the
 * dedicated cases that build a non-empty map.
 */
const NO_WAIVERS: ReadonlyMap<string, bigint> = new Map();

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
      NO_WAIVERS,
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

    await invoiceSourceAdapter.getYtdPaidRevenueSatang(ctx, '2026-02-15T00:00:00.000Z', NO_WAIVERS);

    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fiscalYear: 2026 }),
    );
  });

  it('falls back to January-start when no tenant invoice settings row exists', async () => {
    getForIssueMock.mockResolvedValue(null);
    listInvoicesMock.mockResolvedValue({ ok: true, value: { rows: [], nextCursor: null } });

    await invoiceSourceAdapter.getYtdPaidRevenueSatang(ctx, '2026-02-15T00:00:00.000Z', NO_WAIVERS);

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
      NO_WAIVERS,
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
      NO_WAIVERS,
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
      NO_WAIVERS,
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
      NO_WAIVERS,
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
      NO_WAIVERS,
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
      NO_WAIVERS,
    );

    // 500,000 + (100,000 − 10,000) = 590,000 (ex-VAT).
    expect(buckets['2026-03']).toBe(590_000n);
    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'all' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Track B — netting refunds that carried NO §86/10 credit note
// ---------------------------------------------------------------------------
//
// A waived refund returns money to the member and writes NOTHING to
// `credited_total_satang`, and leaves the invoice status alone. A §105 event
// invoice therefore stays `paid` at full value after the cash went back, and
// every revenue figure here overstated by exactly the refunded amount.
//
// The worked example throughout: subtotal 100,000 + 7% VAT = total 107,000
// satang, refunded 21,400 gross (20%).
//
// These cases assert EXACT figures, never "less than before". The lookup key is
// `inv.invoiceId` — the `Invoice` aggregate has no `id` field — so a typo there
// makes the netting a silent no-op that any "revenue decreased" assertion would
// happily pass.
describe('invoiceSourceAdapter — waived-refund netting (Track B)', () => {
  const INV = 'inv-105';
  // A §105 event invoice: paid, VAT-bearing, never credited.
  const section105Row = {
    invoiceId: INV,
    status: 'paid',
    subtotal: { satang: 100_000n },
    total: { satang: 107_000n },
    creditedTotal: { satang: 0n },
    paidAt: '2026-03-20T00:00:00.000Z',
  };

  beforeEach(() => {
    getForIssueMock.mockResolvedValue({ fiscalYearStartMonth: 1 });
  });

  it('YTD nets the waived amount on the EX-VAT basis, not raw', async () => {
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: { rows: [section105Row], nextCursor: null },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-06-15T00:00:00.000Z',
      new Map([[INV, 21_400n]]),
    );

    // ((107000 − 0 − 21400) × 100000) / 107000 = 80,000 exactly.
    // Subtracting the gross 21,400 from the ex-VAT 100,000 would give 78,600 —
    // ~7% too much removed, which is the mistake this asserts against.
    expect(total).toBe(80_000n);
  });

  it('a FULL waived refund takes the invoice to exactly zero, never negative', async () => {
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: { rows: [section105Row], nextCursor: null },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-06-15T00:00:00.000Z',
      new Map([[INV, 107_000n]]),
    );
    expect(total).toBe(0n);
  });

  it('two partial waived refunds sum to the same figure as one combined refund', async () => {
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: { rows: [section105Row], nextCursor: null },
    });
    // The source read already SUMs per invoice, so the adapter sees one total.
    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-06-15T00:00:00.000Z',
      new Map([[INV, 10_700n + 10_700n]]),
    );
    expect(total).toBe(80_000n);
  });

  it('NEVER double-subtracts: a credit note and a waiver describe different money', async () => {
    // `refunds_cn_xor_waived` makes these mutually exclusive per refund row, so
    // both terms are subtracted. An implementation that picked one over the
    // other (`credited > 0 ? credited : waived`) would drop a real reversal.
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [
          {
            ...section105Row,
            status: 'partially_credited',
            creditedTotal: { satang: 21_400n },
          },
        ],
        nextCursor: null,
      },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-06-15T00:00:00.000Z',
      new Map([[INV, 21_400n]]),
    );
    // ((107000 − 21400 − 21400) × 100000) / 107000 = 60,000.
    // 80,000 would mean one of the two reversals was ignored.
    expect(total).toBe(60_000n);
  });

  it('a VOIDED invoice is excluded by status, so its waiver never nets anything', async () => {
    // This is why the F5 read is reason-agnostic: the status filter, not a
    // reason filter, is what keeps `invoice_voided` waivers out. Netting one
    // here would subtract money from a figure that never included it.
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: {
        rows: [{ ...section105Row, status: 'void' }],
        nextCursor: null,
      },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-06-15T00:00:00.000Z',
      new Map([[INV, 107_000n]]),
    );
    expect(total).toBe(0n);
  });

  it('the monthly trend nets into the invoice SETTLE month, not the refund month', async () => {
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: { rows: [section105Row], nextCursor: null },
    });

    const buckets = await invoiceSourceAdapter.getMonthlyPaidRevenueSatang(
      ctx,
      ['2026-03', '2026-04', '2026-05'],
      'Asia/Bangkok',
      new Map([[INV, 21_400n]]),
    );

    // Netted where the invoice SETTLED (paidAt = March), matching how credit
    // notes are already attributed. Crediting the refund's own month would
    // subtract from a month whose revenue never contained this invoice.
    expect(buckets['2026-03']).toBe(80_000n);
    expect(buckets['2026-05']).toBeUndefined();
  });

  it('the donut paid bucket nets on the GROSS basis and keeps the count', async () => {
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: { rows: [section105Row], nextCursor: null },
    });

    const dist = await invoiceSourceAdapter.getInvoiceStatusDistribution(
      ctx,
      '2026-06-15T00:00:00.000Z',
      new Map([[INV, 21_400n]]),
    );

    const paid = dist.buckets.find((b) => b.bucket === 'paid');
    // 107000 − 21400 = 85,600 — VAT-INCLUSIVE, because the donut compares
    // against unpaid/overdue receivables which are booked gross. Scaling this
    // one ex-VAT is the mirror image of forgetting to scale the KPI.
    expect(paid?.satang).toBe(85_600n);
    // The count is deliberately NOT netted: the invoice WAS paid.
    expect(paid?.count).toBe(1);
  });
});
