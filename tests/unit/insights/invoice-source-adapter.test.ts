/**
 * F9 #4 — the dashboard YTD-paid-revenue KPI must window by the tenant FISCAL
 * year (matching how invoices.fiscalYear is tagged at issue time), not the
 * calendar year. invoiceSourceAdapter.getYtdPaidRevenueSatang derives the fiscal
 * year from `nowIso` + the tenant's fiscalYearStartMonth and filters by it.
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

beforeEach(() => {
  listInvoicesMock.mockReset();
  getForIssueMock.mockReset();
});

describe('invoiceSourceAdapter.getYtdPaidRevenueSatang — fiscal-year windowing (F9 #4)', () => {
  it('an April-start tenant on 2026-02-15 windows by FY 2025, not calendar 2026', async () => {
    getForIssueMock.mockResolvedValue({ fiscalYearStartMonth: 4 });
    listInvoicesMock.mockResolvedValue({
      ok: true,
      value: { rows: [{ total: { satang: 500n } }], nextCursor: null },
    });

    const total = await invoiceSourceAdapter.getYtdPaidRevenueSatang(
      ctx,
      '2026-02-15T00:00:00.000Z',
    );

    expect(total).toBe(500n);
    // Feb 2026 (Bangkok) with an April-start fiscal year → FY 2025.
    expect(listInvoicesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fiscalYear: 2025, status: 'paid' }),
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
