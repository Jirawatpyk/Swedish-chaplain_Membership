/**
 * F9 `InvoiceSource` adapter (US1 Increment 2 / T017).
 *
 * Reads YTD paid revenue + overdue-invoice count via the invoicing PUBLIC
 * BARREL only (`listInvoices` + `makeListInvoicesDeps` + pure `computeIsOverdue`)
 * — no deep/foreign-table imports (Constitution Principle III). Composes from
 * the existing exports (no invoicing surgery): paginates the filtered list and
 * aggregates in the adapter.
 *
 * Runs in the ~5-min snapshot cron, so paginating to sum/count is acceptable at
 * the SC-002 scale; a dedicated invoicing aggregate use-case can be promoted if
 * a tenant approaches the ~20k revisit trigger (spec Assumptions).
 */
import {
  listInvoices,
  makeListInvoicesDeps,
  computeIsOverdue,
  drizzleTenantSettingsRepo,
} from '@/modules/invoicing';
import { deriveFiscalYear, type FiscalYearStartMonth } from '@/lib/fiscal-year';
import type { TenantContext } from '@/modules/tenants';
import type { InvoiceSource } from '../../application/ports/source-ports';
import { monthKeyOf } from '../../domain/trend-window';

const PAGE = 100;

export const invoiceSourceAdapter: InvoiceSource = {
  async getYtdPaidRevenueSatang(ctx: TenantContext, nowIso: string): Promise<bigint> {
    // Resolve the CURRENT fiscal year the way F4 tags invoices at issue time
    // (deriveFiscalYear + the tenant's fiscalYearStartMonth) so the KPI windows
    // by the same value stored on invoices.fiscalYear. The calendar year would
    // mis-window revenue for any non-January fiscal-year tenant (F9 #4). Falls
    // back to January-start (FY == CE year) when no settings row exists yet.
    const settings = await drizzleTenantSettingsRepo.getForIssue(ctx.slug);
    const rawStart = settings?.fiscalYearStartMonth ?? 1;
    const startMonth = (rawStart >= 1 && rawStart <= 12 ? rawStart : 1) as FiscalYearStartMonth;
    const fiscalYear: number = deriveFiscalYear(nowIso, startMonth);

    const deps = makeListInvoicesDeps(ctx.slug);
    let cursor: string | null = null;
    let total = 0n;
    do {
      const result = await listInvoices(deps, {
        tenantId: ctx.slug,
        status: 'paid',
        fiscalYear,
        pageSize: PAGE,
        cursor,
        includeDrafts: false,
      });
      if (!result.ok) throw new Error('InvoiceSource: paid-revenue list failed');
      for (const inv of result.value.rows) {
        total += inv.total?.satang ?? 0n;
      }
      cursor = result.value.nextCursor;
    } while (cursor !== null);
    return total;
  },

  async countOverdue(ctx: TenantContext): Promise<number> {
    const deps = makeListInvoicesDeps(ctx.slug);
    const nowIso = new Date().toISOString();
    let cursor: string | null = null;
    let count = 0;
    do {
      const result = await listInvoices(deps, {
        tenantId: ctx.slug,
        status: 'issued', // only 'issued' invoices can be overdue (computeIsOverdue)
        pageSize: PAGE,
        cursor,
        includeDrafts: false,
      });
      if (!result.ok) throw new Error('InvoiceSource: overdue list failed');
      for (const inv of result.value.rows) {
        if (computeIsOverdue(inv, nowIso)) count += 1;
      }
      cursor = result.value.nextCursor;
    } while (cursor !== null);
    return count;
  },

  async getMonthlyPaidRevenueSatang(
    ctx: TenantContext,
    monthKeys: readonly string[],
    timeZone: string,
  ): Promise<Readonly<Record<string, bigint>>> {
    // NOTE: this buckets by the month a paid invoice was SETTLED (`paidAt`),
    // spanning fiscal years — intentionally a different basis from the YTD KPI
    // (`getYtdPaidRevenueSatang`, which filters by issue-date fiscal year). The
    // trend answers "revenue realised per month", the KPI "this fiscal year".
    const window = new Set(monthKeys);
    const buckets: Record<string, bigint> = {};
    const deps = makeListInvoicesDeps(ctx.slug);
    let cursor: string | null = null;
    do {
      const result = await listInvoices(deps, {
        tenantId: ctx.slug,
        status: 'paid',
        pageSize: PAGE,
        cursor,
        includeDrafts: false,
      });
      if (!result.ok) throw new Error('InvoiceSource: monthly-revenue list failed');
      for (const inv of result.value.rows) {
        const settled = inv.paidAt ?? inv.issueDate;
        if (!settled) continue;
        const key = monthKeyOf(new Date(settled), timeZone);
        if (!window.has(key)) continue; // outside the 12-month window
        buckets[key] = (buckets[key] ?? 0n) + (inv.total?.satang ?? 0n);
      }
      cursor = result.value.nextCursor;
    } while (cursor !== null);
    return buckets;
  },
};
