/**
 * 124 invoice dashboard — `InvoiceDashboardSource` adapter: one SQL aggregate
 * per card. Figures: spec 124 § Figure definitions (D-d, D-e, D-k).
 *
 * Invariants a reader cannot see in the SQL alone:
 *   - Tenancy, two walls (Principle I): every statement runs in `runInTenant`
 *     (RLS + FORCE) AND every table it reads — joins and subqueries included —
 *     carries an explicit `tenant_id = ctx.slug` predicate.
 *   - Collected's three terms are written once (`collectedTermsSql`); the
 *     Collected tile, By method and the trend's Collected all aggregate them
 *     over the same range the caller hands in (the FY clamped to today), so
 *     the method rows and the months add up to the tile.
 *   - Status literals are inlined (`sql.raw` of constants, never input) and the
 *     tax point is `invoiceTaxPointSql` (the expression migration 0318
 *     indexes), so the planner can match the partial indexes.
 *   - `today`, `now` and every range come from the caller, never `now()` /
 *     `CURRENT_DATE`; the aging edges are `agingBucketDueRange(…, today)`, so a
 *     row lands exactly where `agingBucketOf` puts it.
 *   - The four money tables come through their owning barrels (read-only
 *     infra-to-infra sharing). A Drizzle / Postgres error propagates to the
 *     loader, which logs it with a reference id.
 */
import { sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { runInTenant } from '@/lib/db';
import { insightsMetrics } from '@/lib/metrics';
import { addDays } from '@/lib/fiscal-year';
import { parseBigintColumn } from '@/lib/money';
import { creditNotesTable, invoicesTable, invoiceTaxPointSql } from '@/modules/invoicing';
import {
  paymentsTable,
  refundsTable,
  STALE_REFUND_ESCALATION_AGE_MS,
  SUCCEEDED_LINEAGE,
} from '@/modules/payments';
import { eventsTable } from '@/modules/events';
import type { TenantContext } from '@/modules/tenants';
import { agingBucketDueRange, type AgingBucket } from '../../domain/invoice-dashboard-aging';
import type { InvoiceDashboardFilters } from '../../domain/invoice-dashboard-filters';
import type {
  AgingBucketTotal,
  AttentionCounts,
  CollectedMethodTotal,
  CollectedTotal,
  DashboardDateRange,
  InvoiceDashboardSource,
  MonthlyBilledCollected,
  OverdueInvoiceRow,
} from '../../application/ports/invoice-dashboard-source';

/**
 * Barrel values (the four tables, the escalation age) are read per call, never
 * at module load: a test's partial `vi.mock` of a sibling barrel must not crash
 * every importer of the insights barrel (vitest throws on reading an export the
 * mock lacks).
 */
function tables() {
  return { inv: invoicesTable, cn: creditNotesTable, pay: paymentsTable, rf: refundsTable };
}

/** The paid family — exactly the predicate of `invoices_tenant_tax_point_paid_idx`. */
const PAID_FAMILY = sql.raw(`('paid', 'partially_credited', 'credited')`);
/**
 * Billed (D-e): every status but `draft` and `void`, written as the positive
 * list (the same rows; a list the planner can match, unlike `NOT IN`).
 */
const BILLABLE = sql.raw(`('issued', 'paid', 'partially_credited', 'credited')`);
/**
 * Payment rows whose method stands for the invoice — the payments barrel's
 * list, shared with the CSV export. A function: barrel values are read per call.
 */
function methodPaymentStatuses() {
  return sql.raw(`(${SUCCEEDED_LINEAGE.map((s) => `'${s}'`).join(', ')})`);
}
const BANGKOK = sql.raw(`'Asia/Bangkok'`);

/** `AND`-prefixed type / plan / origin predicates on `invoices`, or nothing. */
function scopeOf(filters: InvoiceDashboardFilters): SQL {
  const { inv } = tables();
  const parts: SQL[] = [];
  if (filters.type !== 'all') parts.push(sql`${inv.invoiceSubject} = ${filters.type}`);
  if (filters.planId !== null) parts.push(sql`${inv.planId} = ${filters.planId}`);
  if (filters.origin !== 'all') parts.push(sql`${inv.origin} = ${filters.origin}`);
  return parts.length === 0 ? sql`` : sql` AND ${sql.join(parts, sql` AND `)}`;
}

/** Credit notes joined to their invoice, both tenant-fenced. */
function creditNotesJoin(tenantId: string): SQL {
  const { inv, cn } = tables();
  return sql`${cn} JOIN ${inv}
      ON ${inv.tenantId} = ${cn.tenantId} AND ${inv.invoiceId} = ${cn.originalInvoiceId}
    WHERE ${cn.tenantId} = ${tenantId} AND ${inv.tenantId} = ${tenantId}`;
}

/** Refunds joined to their invoice, both tenant-fenced. */
function refundsJoin(tenantId: string): SQL {
  const { inv, rf } = tables();
  return sql`${rf} JOIN ${inv}
      ON ${inv.tenantId} = ${rf.tenantId} AND ${inv.invoiceId} = ${rf.invoiceId}
    WHERE ${rf.tenantId} = ${tenantId} AND ${inv.tenantId} = ${tenantId}`;
}

function inRange(expr: SQL, range: DashboardDateRange): SQL {
  return sql`${expr} >= ${range.from}::date AND ${expr} <= ${range.to}::date`;
}

/**
 * `range` as a half-open instant range `[from 00:00, to + 1 day 00:00)` in
 * Bangkok (+07:00, no DST), for a timestamptz column. Comparing the column
 * itself keeps the predicate leakproof, so under RLS it can be an index
 * condition, unlike a range on `(col AT TIME ZONE 'Asia/Bangkok')::date`.
 */
function inBangkokInstantRange(column: SQL, range: DashboardDateRange): SQL {
  const fromTs = `${range.from}T00:00:00+07:00`;
  const toNextTs = `${addDays(range.to, 1)}T00:00:00+07:00`;
  return sql`${column} >= ${fromTs}::timestamptz AND ${column} < ${toNextTs}::timestamptz`;
}

/**
 * Collected's three terms over `range` (spec D-d), one signed row each, all
 * through a paid-family invoice and the row filters:
 *   `gross`         + invoice total, by tax point;
 *   `credit_note`   − credit note total, by `issue_date`;
 *   `waived_refund` − succeeded refund with `credit_note_waived_at`, by its
 *                     Bangkok `completed_at` date (filtered on the instant
 *                     range, grouped by the date).
 * Columns: term, term_date, invoice_id, payment_id (the waived refund's own
 * payment, else NULL), invoice_payment_method, amount.
 */
function collectedTermsSql(t: string, range: DashboardDateRange, scope: SQL): SQL {
  const { inv, cn, rf } = tables();
  const paidFamily = sql`${inv.status} IN ${PAID_FAMILY}`;
  const waivedOn = sql`((${rf.completedAt} AT TIME ZONE ${BANGKOK})::date)`;
  return sql`
    SELECT 'gross' AS term, ${invoiceTaxPointSql} AS term_date, ${inv.invoiceId} AS invoice_id,
           NULL::text AS payment_id, ${inv.paymentMethod} AS invoice_payment_method,
           ${inv.totalSatang} AS amount
    FROM ${inv}
    WHERE ${inv.tenantId} = ${t} AND ${paidFamily}
      AND ${inRange(invoiceTaxPointSql, range)}${scope}
    UNION ALL
    SELECT 'credit_note', ${cn.issueDate}, ${inv.invoiceId}, NULL, ${inv.paymentMethod},
           0 - ${cn.totalSatang}
    FROM ${creditNotesJoin(t)}
      AND ${paidFamily}
      AND ${inRange(sql`${cn.issueDate}`, range)}${scope}
    UNION ALL
    SELECT 'waived_refund', ${waivedOn}, ${inv.invoiceId}, ${rf.paymentId}, ${inv.paymentMethod},
           0 - ${rf.amountSatang}
    FROM ${refundsJoin(t)}
      AND ${rf.status} = 'succeeded' AND ${rf.creditNoteWaivedAt} IS NOT NULL
      AND ${paidFamily}
      AND ${inBangkokInstantRange(sql`${rf.completedAt}`, range)}${scope}`;
}

type Row = Record<string, unknown>;

/** The `card` label of `insights_invoice_dashboard_query_duration_ms`: one per query. */
type QueryCard =
  | 'aging'
  | 'collected'
  | 'methods'
  | 'trend'
  | 'attention'
  | 'oldest_overdue'
  | 'any_invoice'
  | 'drafts';

/**
 * One statement in its own `runInTenant`, timed from here (the transaction's
 * round trips included) and recorded on both outcomes; the error propagates.
 */
async function rows(ctx: TenantContext, card: QueryCard, query: SQL): Promise<Row[]> {
  const startedAt = performance.now();
  try {
    const result = await runInTenant(ctx, async (tx) => (await tx.execute(query)) as unknown as Row[]);
    insightsMetrics.invoiceDashboardQueryDurationMs(performance.now() - startedAt, card, 'ok');
    return result;
  } catch (e) {
    insightsMetrics.invoiceDashboardQueryDurationMs(performance.now() - startedAt, card, 'error');
    throw e;
  }
}

export const invoiceDashboardSourceAdapter: InvoiceDashboardSource = {
  async outstandingByAgingBucket(ctx, filters, today): Promise<readonly AgingBucketTotal[]> {
    const { inv } = tables();
    const t = ctx.slug;
    const edge = (bucket: AgingBucket): string => agingBucketDueRange(bucket, today).dueAfter ?? today;
    const result = await rows(
      ctx,
      'aging',
      sql`
      SELECT
        CASE
          WHEN ${inv.dueDate} IS NULL OR ${inv.dueDate} >= ${today}::date THEN 'not_yet_due'
          WHEN ${inv.dueDate} >= ${edge('days_1_30')}::date THEN 'days_1_30'
          WHEN ${inv.dueDate} >= ${edge('days_31_60')}::date THEN 'days_31_60'
          WHEN ${inv.dueDate} >= ${edge('days_61_90')}::date THEN 'days_61_90'
          ELSE 'over_90'
        END AS bucket,
        COALESCE(SUM(${inv.totalSatang}), 0)::bigint AS amount,
        COUNT(*)::int AS n
      FROM ${inv}
      WHERE ${inv.tenantId} = ${t} AND ${inv.status} = 'issued'${scopeOf(filters)}
      GROUP BY 1`,
    );
    return result.map((r) => ({
      bucket: r.bucket as AgingBucket,
      amountSatang: parseBigintColumn(r.amount, 'outstanding'),
      count: Number(r.n),
    }));
  },

  async collectedInRange(ctx, filters, range): Promise<CollectedTotal> {
    const result = await rows(
      ctx,
      'collected',
      sql`
      WITH terms AS (${collectedTermsSql(ctx.slug, range, scopeOf(filters))})
      SELECT COALESCE(SUM(amount), 0)::bigint AS amount,
             COUNT(*) FILTER (WHERE term = 'gross')::int AS n
      FROM terms`,
    );
    const r = result[0] ?? {};
    return { amountSatang: parseBigintColumn(r.amount, 'collected'), invoiceCount: Number(r.n ?? 0) };
  },

  async collectedByMethod(ctx, filters, range): Promise<readonly CollectedMethodTotal[]> {
    const { pay } = tables();
    const t = ctx.slug;
    // Every term lands on a row, so the rows add up to the tile. A waived
    // refund takes its own payment's method; failing that (and for the
    // invoice terms) the invoice's latest payment in the method set (looked
    // up only for the invoices the terms touch), else `invoices.payment_method`.
    const result = await rows(
      ctx,
      'methods',
      sql`
      WITH terms AS (${collectedTermsSql(t, range, scopeOf(filters))}),
      latest_method AS (
        SELECT DISTINCT ON (${pay.invoiceId}) ${pay.invoiceId} AS invoice_id, ${pay.method} AS method
        FROM ${pay}
        WHERE ${pay.tenantId} = ${t} AND ${pay.status} IN ${methodPaymentStatuses()}
          AND ${pay.invoiceId} IN (SELECT invoice_id FROM terms)
        ORDER BY ${pay.invoiceId}, ${pay.completedAt} DESC NULLS LAST, ${pay.id} DESC
      ), own_method AS (
        SELECT ${pay.id} AS payment_id, ${pay.method} AS method
        FROM ${pay}
        WHERE ${pay.tenantId} = ${t}
          AND ${pay.id} IN (SELECT payment_id FROM terms WHERE term = 'waived_refund')
      )
      SELECT COALESCE(own_method.method, latest_method.method, terms.invoice_payment_method) AS method,
             SUM(terms.amount)::bigint AS amount
      FROM terms
      LEFT JOIN latest_method ON latest_method.invoice_id = terms.invoice_id
      LEFT JOIN own_method ON own_method.payment_id = terms.payment_id
      GROUP BY 1`,
    );
    return result.map((r) => ({
      method: r.method === null || r.method === undefined ? null : String(r.method),
      amountSatang: parseBigintColumn(r.amount, 'collected_by_method'),
    }));
  },

  async monthlyBilledCollected(
    ctx,
    filters,
    range,
    collectedRange,
  ): Promise<readonly MonthlyBilledCollected[]> {
    const { inv, cn } = tables();
    const t = ctx.slug;
    const scope = scopeOf(filters);
    const billable = sql`${inv.status} IN ${BILLABLE}`;
    const month = (d: SQL) => sql`to_char(${d}, 'YYYY-MM')`;
    const result = await rows(
      ctx,
      'trend',
      sql`
      WITH collected AS (${collectedTermsSql(t, collectedRange, scope)}),
      terms AS (
        SELECT ${month(sql`${inv.issueDate}`)} AS month, ${inv.totalSatang} AS billed, 0::bigint AS collected
        FROM ${inv}
        WHERE ${inv.tenantId} = ${t} AND ${billable}
          AND ${inRange(sql`${inv.issueDate}`, range)}${scope}
        UNION ALL
        SELECT ${month(sql`${cn.issueDate}`)}, 0 - ${cn.totalSatang}, 0::bigint
        FROM ${creditNotesJoin(t)}
          AND ${billable}
          AND ${inRange(sql`${cn.issueDate}`, range)}${scope}
        UNION ALL
        SELECT to_char(term_date, 'YYYY-MM'), 0::bigint, amount FROM collected
      )
      SELECT month, SUM(billed)::bigint AS billed, SUM(collected)::bigint AS collected
      FROM terms GROUP BY month ORDER BY month`,
    );
    return result.map((r) => ({
      monthKey: String(r.month),
      billedSatang: parseBigintColumn(r.billed, 'billed'),
      collectedSatang: parseBigintColumn(r.collected, 'collected'),
    }));
  },

  async attentionCounts(ctx, filters, now): Promise<AttentionCounts> {
    const { inv, rf } = tables();
    const later = alias(rf, 'later_attempt');
    const t = ctx.slug;
    const scope = scopeOf(filters);
    // Strictly older, as the sweep's `ageMs <= ESCALATION_AGE_MS → not yet` reads.
    const pendingBefore = new Date(now.getTime() - STALE_REFUND_ESCALATION_AGE_MS).toISOString();
    // Refunds failed at Stripe (US1): a payment counts once while one of its
    // `stripe_refund_%` failures has no LATER succeeded or pending attempt
    // (initiated_at, created_at, id — the order the latest attempt is chosen by).
    // A later failure of another kind does not clear it.
    // Row 5 (D-k) also counts legacy `failed` + `f4_bridge_%` refunds that
    // carry a `processor_refund_id` — the payments module's settled-unbooked
    // shape (`drizzle-refunds-repo.ts`): Stripe paid out, the credit note was
    // never booked, nothing was subtracted. A failed row can carry neither a
    // credit note nor a waiver (CHECK `refunds_succeeded_iff_documented`), and
    // the out-of-band runbook reconciles with a credit note on the INVOICE, so
    // such a row stays counted after reconciliation.
    // Receipt PDF failed: `paid` invoices only — the receipt worker
    // (`render-receipt-pdf.ts`) re-renders no other status, so a credited or
    // voided invoice's stale failure is no receipt anyone can re-render.
    const receiptFailed = sql`${inv.receiptPdfStatus} = 'failed' AND ${inv.status} = 'paid'`;
    const result = await rows(
      ctx,
      'attention',
      sql`
      WITH invoice_pass AS (
        SELECT
          COUNT(*) FILTER (WHERE ${inv.status} = 'draft' AND ${inv.origin} = 'manual')::int AS manual_drafts,
          COUNT(*) FILTER (WHERE ${inv.status} = 'draft' AND ${inv.origin} = 'auto_renewal')::int
            AS auto_renewal_drafts,
          COUNT(*) FILTER (WHERE ${receiptFailed})::int AS receipt_pdf_failed
        FROM ${inv}
        WHERE ${inv.tenantId} = ${t}
          AND (${inv.status} = 'draft' OR (${receiptFailed}))${scope}
      ), refund_pass AS (
        SELECT
          COUNT(DISTINCT ${rf.paymentId}) FILTER (
            WHERE ${rf.status} = 'failed' AND ${rf.failureReasonCode} LIKE 'stripe_refund_%'
              AND NOT EXISTS (
                SELECT 1 FROM ${rf} AS ${later}
                WHERE ${later.tenantId} = ${t} AND ${later.paymentId} = ${rf.paymentId}
                  AND ${later.status} IN ('succeeded', 'pending')
                  AND (${later.initiatedAt}, ${later.createdAt}, ${later.id})
                    > (${rf.initiatedAt}, ${rf.createdAt}, ${rf.id})
              )
          )::int AS refunds_failed_at_stripe,
          COUNT(*) FILTER (
            WHERE (${rf.status} = 'pending' AND ${rf.initiatedAt} < ${pendingBefore}::timestamptz)
               OR (${rf.status} = 'failed' AND ${rf.processorRefundId} IS NOT NULL
                   AND ${rf.failureReasonCode} LIKE 'f4_bridge_%')
          )::int AS refunds_pending_over_threshold
        FROM ${refundsJoin(t)}
          AND ${rf.status} IN ('failed', 'pending')${scope}
      )
      SELECT * FROM invoice_pass, refund_pass`,
    );
    const r = result[0] ?? {};
    return {
      manualDrafts: Number(r.manual_drafts ?? 0),
      autoRenewalDrafts: Number(r.auto_renewal_drafts ?? 0),
      receiptPdfFailed: Number(r.receipt_pdf_failed ?? 0),
      refundsFailedAtStripe: Number(r.refunds_failed_at_stripe ?? 0),
      refundsPendingOverThreshold: Number(r.refunds_pending_over_threshold ?? 0),
    };
  },

  async oldestOverdue(ctx, filters, today, limit): Promise<readonly OverdueInvoiceRow[]> {
    const { inv } = tables();
    const ev = eventsTable;
    const t = ctx.slug;
    const docNo = sql`COALESCE(${inv.documentNumber}, ${inv.billDocumentNumberRaw})`;
    const result = await rows(
      ctx,
      'oldest_overdue',
      sql`
      SELECT ${inv.invoiceId}::text AS invoice_id,
             ${docNo} AS document_number,
             ${inv.memberIdentitySnapshot} ->> 'legal_name' AS buyer_name,
             ${inv.dueDate}::text AS due_date,
             (${today}::date - ${inv.dueDate})::int AS days_past_due,
             ${inv.totalSatang}::bigint AS amount,
             ${inv.invoiceSubject} AS subject,
             ${inv.planYear} AS plan_year,
             ${ev.name} AS event_name
      FROM ${inv}
      LEFT JOIN ${ev} ON ${ev.tenantId} = ${t} AND ${ev.eventId} = ${inv.eventId}
      WHERE ${inv.tenantId} = ${t} AND ${inv.status} = 'issued'
        AND ${inv.dueDate} < ${today}::date${scopeOf(filters)}
      ORDER BY ${inv.dueDate} ASC, ${inv.totalSatang} DESC, ${docNo} ASC NULLS LAST, ${inv.invoiceId} ASC
      LIMIT ${limit}`,
    );
    return result.map((r) => ({
      invoiceId: String(r.invoice_id),
      documentNumber: r.document_number === null ? null : String(r.document_number),
      buyerName: r.buyer_name === null ? null : String(r.buyer_name),
      dueDate: String(r.due_date),
      daysPastDue: Number(r.days_past_due),
      amountSatang: parseBigintColumn(r.amount, 'overdue_amount'),
      subject: r.subject === 'event' ? ('event' as const) : ('membership' as const),
      planYear: r.plan_year === null ? null : Number(r.plan_year),
      eventName: r.event_name === null ? null : String(r.event_name),
    }));
  },

  async hasNonDraftInvoice(ctx): Promise<boolean> {
    const { inv } = tables();
    const result = await rows(
      ctx,
      'any_invoice',
      sql`
      SELECT EXISTS (
        SELECT 1 FROM ${inv}
        WHERE ${inv.tenantId} = ${ctx.slug} AND ${inv.status} <> 'draft'
      ) AS any`,
    );
    return result[0]?.any === true;
  },

  async draftCount(ctx, filters): Promise<number> {
    const { inv } = tables();
    const result = await rows(
      ctx,
      'drafts',
      sql`
      SELECT COUNT(*)::int AS drafts
      FROM ${inv}
      WHERE ${inv.tenantId} = ${ctx.slug} AND ${inv.status} = 'draft'${scopeOf(filters)}`,
    );
    return Number(result[0]?.drafts ?? 0);
  },
};
