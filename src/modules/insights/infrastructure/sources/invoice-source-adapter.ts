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

// Statuses that represent realised paid revenue. A paid invoice that later
// receives a credit note is flipped paid → 'partially_credited' / 'credited'
// (issue-credit-note), so an exact `status:'paid'` filter would drop the whole
// invoice from the revenue figures. We include all three and NET the credited
// portion so a partial credit reduces revenue by exactly the credited amount,
// not by the entire invoice. ReadonlySet<string> (not the narrow literal union)
// so `.has(inv.status)` type-checks against the wider InvoiceStatus.
//
// M-h — these are INVOICE statuses; F9 revenue never reads F5 `payment` status.
// So the F5 refund TERMINALS (`refunded` / `partially_refunded` / `auto_refunded`)
// are all excluded from revenue by construction: a succeeded refund's money
// impact flows in via the CREDIT NOTE it issues (invoice → credited /
// partially_credited, netted above), and an `auto_refunded` payment (reached
// ONLY from `pending` on the stale-invoice path) NEVER settled its invoice —
// the invoice is `void`/`credited`/paid-out-of-band, so either it is excluded
// here or the legitimate out-of-band revenue is counted exactly ONCE (this
// adapter sums each invoice by status, never the `payments` rows, so a
// duplicate auto-refunded Stripe charge can neither inflate nor drop revenue).
const PAID_REVENUE_STATUSES: ReadonlySet<string> = new Set([
  'paid',
  'partially_credited',
  'credited',
]);

/**
 * Net-of-VAT realised revenue for one invoice.
 *
 * "Revenue" (รายได้) EXCLUDES output VAT (ภาษีขาย) — VAT is a liability to the
 * Revenue Department, not income (Thai accounting; the KPI is labelled
 * "รายได้/Revenue"). So we take the net-of-credit gross (`total −
 * creditedTotal`) and scale it by the invoice's OWN ex-VAT ratio
 * (`subtotal / total`), rather than summing the VAT-inclusive `total`.
 *
 * - No credit: `total × subtotal / total == subtotal` (exact — the ex-VAT base).
 * - Partial credit: proportional ex-VAT of the surviving amount.
 * - Zero-rated invoice (`subtotal == total`): the ratio is 1, so ex-VAT == gross.
 *
 * Multiply before divide to preserve satang precision; BigInt division truncates
 * (sub-satang, negligible for a dashboard KPI). This is a MANAGEMENT figure, not
 * a tax document — do not reconcile it against ภ.พ.30.
 */
const netPaidRevenueSatang = (inv: {
  subtotal: { satang: bigint } | null;
  total: { satang: bigint } | null;
  creditedTotal: { satang: bigint } | null;
}): bigint => {
  const total = inv.total?.satang ?? 0n;
  if (total <= 0n) return 0n;
  const netOfCredit = total - (inv.creditedTotal?.satang ?? 0n);
  return (netOfCredit * (inv.subtotal?.satang ?? 0n)) / total;
};

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
      // `status:'all'` (not 'paid') so credit-note-flipped invoices are still
      // returned; the paid-revenue status filter + credit netting happen below.
      const result = await listInvoices(deps, {
        tenantId: ctx.slug,
        status: 'all',
        fiscalYear,
        pageSize: PAGE,
        cursor,
        includeDrafts: false,
      });
      if (!result.ok) throw new Error('InvoiceSource: paid-revenue list failed');
      for (const inv of result.value.rows) {
        if (!PAID_REVENUE_STATUSES.has(inv.status)) continue;
        total += netPaidRevenueSatang(inv);
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
    // Credit notes are NETTED against the invoice's original settle month
    // (`total − creditedTotal`); attributing the reversal to the credit-note
    // month instead would need a separate credit_notes source (follow-on).
    const window = new Set(monthKeys);
    const buckets: Record<string, bigint> = {};
    const deps = makeListInvoicesDeps(ctx.slug);
    let cursor: string | null = null;
    do {
      // `status:'all'` (not 'paid') so credit-note-flipped invoices are still
      // returned; the paid-revenue status filter + credit netting happen below.
      const result = await listInvoices(deps, {
        tenantId: ctx.slug,
        status: 'all',
        pageSize: PAGE,
        cursor,
        includeDrafts: false,
      });
      if (!result.ok) throw new Error('InvoiceSource: monthly-revenue list failed');
      for (const inv of result.value.rows) {
        if (!PAID_REVENUE_STATUSES.has(inv.status)) continue;
        const settled = inv.paidAt ?? inv.issueDate;
        if (!settled) continue;
        const key = monthKeyOf(new Date(settled), timeZone);
        if (!window.has(key)) continue; // outside the 12-month window
        buckets[key] = (buckets[key] ?? 0n) + netPaidRevenueSatang(inv);
      }
      cursor = result.value.nextCursor;
    } while (cursor !== null);
    return buckets;
  },
};
