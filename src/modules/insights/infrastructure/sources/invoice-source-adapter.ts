/**
 * F9 `InvoiceSource` adapter (US1 Increment 2 / T017; `getInvoiceStatusDistribution`
 * added 067-dashboard-interactive-charts Task 4).
 *
 * Reads YTD paid revenue, overdue-invoice count, and the invoice-status
 * distribution (paid/unpaid/overdue + draft count) via the invoicing PUBLIC
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
import type { InvoiceSource, WaivedRefundTotals } from '../../application/ports/source-ports';
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
// partially_credited, netted above) OR — Track B — via the WAIVED-refund total
// threaded in as `waivedByInvoice`, for the refunds that legitimately issue no
// credit note at all and therefore leave both the status and
// `credited_total_satang` untouched. An `auto_refunded` payment (reached
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
const netPaidRevenueSatang = (
  inv: {
    subtotal: { satang: bigint } | null;
    total: { satang: bigint } | null;
    creditedTotal: { satang: bigint } | null;
  },
  /**
   * Track B — VAT-INCLUSIVE cash returned by refunds carrying no §86/10.
   * Folded into the numerator BEFORE the single division, deliberately: scaling
   * it separately and subtracting afterwards truncates twice and can differ by
   * a satang. Both terms are subtracted, never one or the other — the DB's
   * `refunds_cn_xor_waived` makes them mutually exclusive per refund row, so
   * they can never describe the same money.
   */
  waivedSatang: bigint,
): bigint => {
  const total = inv.total?.satang ?? 0n;
  if (total <= 0n) return 0n;
  const netOfCredit = total - (inv.creditedTotal?.satang ?? 0n) - waivedSatang;
  // Unreachable today: a §105 invoice always has creditedTotal == 0 (F4 refuses
  // to credit one) and Σwaived is capped at the payment amount, which is capped
  // at the invoice total. Kept as defence-in-depth against a future edit, NOT
  // as a fix for an observed negative — do not delete it after "verifying" the
  // scenario cannot happen, because that verification is what makes it safe.
  if (netOfCredit <= 0n) return 0n;
  return (netOfCredit * (inv.subtotal?.satang ?? 0n)) / total;
};

/**
 * Gross, net-of-credit amount (`total − creditedTotal`) for the status-
 * distribution donut — used for ALL THREE `paid`/`unpaid`/`overdue` buckets.
 * A part-to-whole chart needs one consistent basis (067 design § Data &
 * correctness): amounts are VAT-INCLUSIVE, the way accounts-receivable is
 * actually booked (§86/4 tax invoices always include VAT), NOT the ex-VAT
 * `netPaidRevenueSatang` figure the separate revenue-KPI methods
 * (`getYtdPaidRevenueSatang` / `getMonthlyPaidRevenueSatang`) sum — mixing
 * ex-VAT `paid` with gross `unpaid`/`overdue` would distort the slice
 * proportions. A `partially_credited` invoice nets down by exactly the
 * credited amount, same as the revenue KPI — and (review fix) it is bucketed
 * into `paid`, not `unpaid`/`overdue`: `canTransition` in
 * `invoice.ts` only reaches `partially_credited` FROM `paid`
 * (`paid → ['partially_credited', 'credited', 'void']`), so every
 * `partially_credited` invoice was paid first — its net balance is already-
 * collected cash, not an outstanding receivable, regardless of `dueDate`.
 */
const netBalanceSatang = (
  inv: {
    total: { satang: bigint } | null;
    creditedTotal: { satang: bigint } | null;
  },
  /**
   * Track B — subtracted RAW here, with NO ex-VAT scaling. This helper works on
   * the gross, VAT-inclusive basis, and the refund amount is gross cash, so the
   * two already agree. Applying the `subtotal / total` ratio here — the mirror
   * image of forgetting it in `netPaidRevenueSatang` — would under-subtract by
   * the VAT portion.
   */
  waivedSatang: bigint,
): bigint => {
  const total = inv.total?.satang ?? 0n;
  const net = total - (inv.creditedTotal?.satang ?? 0n) - waivedSatang;
  // Clamped explicitly: unlike the helper above there is no division to
  // truncate a negative away, and a negative bucket renders as a negative
  // percentage in the donut legend beside a hard-coded 100% total.
  return net <= 0n ? 0n : net;
};

export const invoiceSourceAdapter: InvoiceSource = {
  async getYtdPaidRevenueSatang(
    ctx: TenantContext,
    nowIso: string,
    waivedByInvoice: WaivedRefundTotals,
  ): Promise<bigint> {
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
        // The status filter above is what excludes `invoice_voided` waivers:
        // a voided invoice never reaches this line, so its waived refund is
        // never netted from a figure that never included it. That is why the
        // F5 read is reason-agnostic.
        total += netPaidRevenueSatang(inv, waivedByInvoice.get(inv.invoiceId) ?? 0n);
      }
      cursor = result.value.nextCursor;
    } while (cursor !== null);
    return total;
  },

  async countOverdue(ctx: TenantContext, nowIso: string): Promise<number> {
    const deps = makeListInvoicesDeps(ctx.slug);
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
    waivedByInvoice: WaivedRefundTotals,
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
        // Track B — the waived amount nets into the invoice's ORIGINAL settle
        // month, never the month the refund completed. Same basis the credit
        // notes already use (see the note above). Attributing it to the refund
        // month would subtract money from a month whose revenue never included
        // it, and would stop the trend reconciling with the fiscal-year KPI
        // rendered beside it on the same page.
        //
        // Accepted consequence: a waived refund on an invoice settled outside
        // the 12-month window is never netted from anything. The netting is not
        // retroactive beyond the live window.
        buckets[key] =
          (buckets[key] ?? 0n) +
          netPaidRevenueSatang(inv, waivedByInvoice.get(inv.invoiceId) ?? 0n);
      }
      cursor = result.value.nextCursor;
    } while (cursor !== null);
    return buckets;
  },

  async getInvoiceStatusDistribution(
    ctx: TenantContext,
    nowIso: string,
    waivedByInvoice: WaivedRefundTotals,
  ): Promise<{
    readonly buckets: ReadonlyArray<{
      bucket: 'paid' | 'unpaid' | 'overdue';
      satang: bigint;
      count: number;
    }>;
    readonly draftCount: number;
  }> {
    const deps = makeListInvoicesDeps(ctx.slug);
    let cursor: string | null = null;
    let paidSatang = 0n;
    let paidCount = 0;
    let unpaidSatang = 0n;
    let unpaidCount = 0;
    let overdueSatang = 0n;
    let overdueCount = 0;
    let draftCount = 0;
    do {
      // `status:'all'` + `includeDrafts:true` — this method (unlike the
      // other reads above) needs EVERY status in one pass: draft (for
      // draftCount), issued (bucketed unpaid/overdue by due date below), and
      // paid/partially_credited (both counted as `paid`, net of credit) /
      // void/credited (excluded).
      const result = await listInvoices(deps, {
        tenantId: ctx.slug,
        status: 'all',
        pageSize: PAGE,
        cursor,
        includeDrafts: true,
      });
      if (!result.ok) throw new Error('InvoiceSource: status-distribution list failed');
      for (const inv of result.value.rows) {
        switch (inv.status) {
          case 'draft':
            draftCount += 1;
            break;
          case 'paid':
          case 'partially_credited':
            // `partially_credited` is reachable ONLY from `paid`
            // (`canTransition` in invoice.ts) — it was paid first, so its
            // net balance is already-collected cash, not a receivable. Never
            // route it through the overdue-by-due-date check below.
            paidSatang += netBalanceSatang(inv, waivedByInvoice.get(inv.invoiceId) ?? 0n);
            // Count is deliberately NOT netted. A fully-refunded §105 invoice
            // reads "paid — ฿0.00 — 1 invoice", which is true: it WAS paid, and
            // the refund is a later event. Dropping the count would also make
            // the bucket counts stop summing to the invoice population.
            paidCount += 1;
            break;
          case 'issued':
            // No waiver lookup on the `issued` arm: an unpaid invoice has no
            // succeeded payment, so it can have no refund. Passing 0n keeps
            // that reasoning visible rather than implicit.
            if (computeIsOverdue(inv, nowIso)) {
              overdueSatang += netBalanceSatang(inv, 0n);
              overdueCount += 1;
            } else {
              unpaidSatang += netBalanceSatang(inv, 0n);
              unpaidCount += 1;
            }
            break;
          case 'void':
          case 'credited':
            // Excluded from every bucket AND draftCount (design rules).
            break;
        }
      }
      cursor = result.value.nextCursor;
    } while (cursor !== null);

    return {
      buckets: [
        { bucket: 'paid', satang: paidSatang, count: paidCount },
        { bucket: 'unpaid', satang: unpaidSatang, count: unpaidCount },
        { bucket: 'overdue', satang: overdueSatang, count: overdueCount },
      ],
      draftCount,
    };
  },
};
