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
} from '@/modules/invoicing';
import type { TenantContext } from '@/modules/tenants';
import type { InvoiceSource } from '../../application/ports/source-ports';

const PAGE = 100;

export const invoiceSourceAdapter: InvoiceSource = {
  async getYtdPaidRevenueSatang(ctx: TenantContext, year: number): Promise<bigint> {
    const deps = makeListInvoicesDeps(ctx.slug);
    let cursor: string | null = null;
    let total = 0n;
    do {
      const result = await listInvoices(deps, {
        tenantId: ctx.slug,
        status: 'paid',
        fiscalYear: year,
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
};
