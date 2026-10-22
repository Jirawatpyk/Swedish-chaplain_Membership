/**
 * 124 invoice dashboard — `InvoiceDashboardSource` adapter: ONE SQL aggregate
 * per card (spec 124 § Figure definitions, D-d, D-e).
 *
 * Reads four money tables through their owning barrels — `invoicesTable`,
 * `creditNotesTable`, `invoiceTaxPointSql` from `@/modules/invoicing`;
 * `paymentsTable`, `refundsTable` from `@/modules/payments` — the documented
 * read-only infra-to-infra schema sharing (`payments/index.ts` § paymentsTable).
 * No deep import into another module, no paging rows into JS, no `IN (...)`
 * list built from data.
 *
 * Tenancy (Principle I, two walls): every statement runs inside
 * `runInTenant(ctx, tx)` (RLS + FORCE via `SET LOCAL app.current_tenant`), AND
 * every table it reads carries an explicit `tenant_id = ctx.slug` predicate,
 * joins included.
 *
 * The figures, as implemented here:
 *   - Outstanding = Σ `total_satang`, count of `status = 'issued'`, all years,
 *     no netting. Aging buckets come from that same statement (GROUP BY a CASE
 *     on `due_date`); the edges are `agingBucketDueRange(…, today)` handed in as
 *     parameters, so a row lands exactly where `agingBucketOf` puts it and the
 *     buckets sum to Outstanding. `today` is the caller's Bangkok date, never
 *     `now()` / `CURRENT_DATE`.
 *   - Collected (document basis) over [from, to] =
 *       Σ invoices in paid | partially_credited | credited whose tax point
 *         (`invoiceTaxPointSql`, the very object migration 0318 indexes) is in
 *         range
 *     − Σ credit notes by `issue_date` in range, joined to their invoice via
 *         `original_invoice_id`, same status set and filters
 *     − Σ waived refunds (`status = 'succeeded' AND credit_note_waived_at IS
 *         NOT NULL`) by `(completed_at AT TIME ZONE 'Asia/Bangkok')::date` in
 *         range, joined via `refunds.invoice_id`, same status set and filters.
 *     A refund on a void invoice therefore never subtracts; a `failed` or
 *     `pending` refund is never subtracted; `payments.amount_satang` is never
 *     summed.
 *   - By method: an invoice's method is its latest `payments` row in
 *     succeeded | partially_refunded | refunded (`DISTINCT ON (invoice_id)`,
 *     `completed_at DESC`), else `invoices.payment_method`; a credit note takes
 *     its invoice's method, a waived refund its own payment's method. The same
 *     three terms as Collected, so the rows add up to it.
 *   - Billed per month = Σ `total_satang` by `issue_date`, status neither draft
 *     nor void (D-e), − credit notes by their `issue_date` (their invoice is in
 *     the paid family, so never draft or void). Collected per month as above.
 *   - Needs attention: drafts by origin; `receipt_pdf_status = 'failed'`;
 *     payments whose LATEST refund attempt (by `initiated_at`) is `failed` with
 *     `stripe_refund_%`; refunds `pending` whose `initiated_at` is strictly
 *     older than `now − STALE_REFUND_ESCALATION_AGE_MS` (the payments sweep's
 *     own constant and column, D-k). `now` is the caller's instant.
 *   - Oldest overdue: issued, `due_date < today`, by `due_date`, then amount
 *     desc, then document number.
 *
 * Status literals are inlined (`sql.raw` of constants, never input) so the
 * planner can match the partial indexes `invoices_tenant_tax_point_paid_idx`,
 * `invoices_tenant_due_date_issued_idx` and `refunds_tenant_completed_succeeded_idx`.
 * The three row filters arrive parsed (`parseInvoiceDashboardFilters`) and
 * are bound as parameters.
 *
 * A Drizzle / Postgres error propagates: the loader turns it into a typed
 * error with a logged reference id. Drizzle types stay in this file.
 */
import { sql, type SQL } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { parseBigintColumn } from '@/lib/money';
import { creditNotesTable, invoicesTable, invoiceTaxPointSql } from '@/modules/invoicing';
import {
  paymentsTable,
  refundsTable,
  STALE_REFUND_ESCALATION_AGE_MS,
} from '@/modules/payments';
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
 * The four tables, resolved per call rather than at module load: a test's
 * partial `vi.mock` of a sibling barrel must not crash every importer of the
 * insights barrel (vitest throws on reading an export the mock lacks).
 */
function tables() {
  return { inv: invoicesTable, cn: creditNotesTable, pay: paymentsTable, rf: refundsTable };
}

/** The paid family — exactly the predicate of `invoices_tenant_tax_point_paid_idx`. */
const PAID_FAMILY = sql.raw(`('paid', 'partially_credited', 'credited')`);
/** Payment rows whose method stands for the invoice. */
const METHOD_PAYMENT_STATUSES = sql.raw(`('succeeded', 'partially_refunded', 'refunded')`);
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

function waivedBangkokDate(): SQL {
  const { rf } = tables();
  return sql`((${rf.completedAt} AT TIME ZONE ${BANGKOK})::date)`;
}
function waivedRefund(): SQL {
  const { rf } = tables();
  return sql`${rf.status} = 'succeeded' AND ${rf.creditNoteWaivedAt} IS NOT NULL`;
}

function inRange(expr: SQL, range: DashboardDateRange): SQL {
  return sql`${expr} >= ${range.from}::date AND ${expr} <= ${range.to}::date`;
}

type Row = Record<string, unknown>;

async function rows(ctx: TenantContext, query: SQL): Promise<Row[]> {
  return runInTenant(ctx, async (tx) => (await tx.execute(query)) as unknown as Row[]);
}

export const invoiceDashboardSourceAdapter: InvoiceDashboardSource = {
  async outstandingByAgingBucket(ctx, filters, today): Promise<readonly AgingBucketTotal[]> {
    const { inv } = tables();
    const t = ctx.slug;
    const edge = (bucket: AgingBucket): string => agingBucketDueRange(bucket, today).dueAfter ?? today;
    const result = await rows(
      ctx,
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
    const { inv, cn, rf } = tables();
    const t = ctx.slug;
    const scope = scopeOf(filters);
    const result = await rows(
      ctx,
      sql`
      WITH gross AS (
        SELECT COALESCE(SUM(${inv.totalSatang}), 0)::bigint AS amount, COUNT(*)::int AS n
        FROM ${inv}
        WHERE ${inv.tenantId} = ${t} AND ${inv.status} IN ${PAID_FAMILY}
          AND ${inRange(invoiceTaxPointSql, range)}${scope}
      ), credited AS (
        SELECT COALESCE(SUM(${cn.totalSatang}), 0)::bigint AS amount
        FROM ${creditNotesJoin(t)}
          AND ${inv.status} IN ${PAID_FAMILY}
          AND ${inRange(sql`${cn.issueDate}`, range)}${scope}
      ), waived AS (
        SELECT COALESCE(SUM(${rf.amountSatang}), 0)::bigint AS amount
        FROM ${refundsJoin(t)}
          AND ${waivedRefund()}
          AND ${inv.status} IN ${PAID_FAMILY}
          AND ${inRange(waivedBangkokDate(), range)}${scope}
      )
      SELECT (gross.amount - credited.amount - waived.amount)::bigint AS amount, gross.n AS n
      FROM gross, credited, waived`,
    );
    const r = result[0] ?? {};
    return { amountSatang: parseBigintColumn(r.amount, 'collected'), invoiceCount: Number(r.n ?? 0) };
  },

  async collectedByMethod(ctx, filters, range): Promise<readonly CollectedMethodTotal[]> {
    const { inv, cn, pay, rf } = tables();
    const t = ctx.slug;
    const scope = scopeOf(filters);
    const result = await rows(
      ctx,
      sql`
      WITH invoice_method AS (
        SELECT DISTINCT ON (${pay.invoiceId}) ${pay.invoiceId} AS invoice_id, ${pay.method} AS method
        FROM ${pay}
        WHERE ${pay.tenantId} = ${t} AND ${pay.status} IN ${METHOD_PAYMENT_STATUSES}
        ORDER BY ${pay.invoiceId}, ${pay.completedAt} DESC NULLS LAST, ${pay.id} DESC
      ), terms AS (
        SELECT COALESCE(invoice_method.method, ${inv.paymentMethod}) AS method,
               ${inv.totalSatang} AS amount
        FROM ${inv}
        LEFT JOIN invoice_method ON invoice_method.invoice_id = ${inv.invoiceId}
        WHERE ${inv.tenantId} = ${t} AND ${inv.status} IN ${PAID_FAMILY}
          AND ${inRange(invoiceTaxPointSql, range)}${scope}
        UNION ALL
        SELECT COALESCE(invoice_method.method, ${inv.paymentMethod}), 0 - ${cn.totalSatang}
        FROM ${cn}
        JOIN ${inv} ON ${inv.tenantId} = ${cn.tenantId} AND ${inv.invoiceId} = ${cn.originalInvoiceId}
        LEFT JOIN invoice_method ON invoice_method.invoice_id = ${inv.invoiceId}
        WHERE ${cn.tenantId} = ${t} AND ${inv.tenantId} = ${t}
          AND ${inv.status} IN ${PAID_FAMILY}
          AND ${inRange(sql`${cn.issueDate}`, range)}${scope}
        UNION ALL
        SELECT ${pay.method}, 0 - ${rf.amountSatang}
        FROM ${rf}
        JOIN ${inv} ON ${inv.tenantId} = ${rf.tenantId} AND ${inv.invoiceId} = ${rf.invoiceId}
        JOIN ${pay} ON ${pay.tenantId} = ${rf.tenantId} AND ${pay.id} = ${rf.paymentId}
        WHERE ${rf.tenantId} = ${t} AND ${inv.tenantId} = ${t} AND ${pay.tenantId} = ${t}
          AND ${waivedRefund()}
          AND ${inv.status} IN ${PAID_FAMILY}
          AND ${inRange(waivedBangkokDate(), range)}${scope}
      )
      SELECT method, SUM(amount)::bigint AS amount FROM terms GROUP BY method`,
    );
    return result.map((r) => ({
      method: r.method === null || r.method === undefined ? null : String(r.method),
      amountSatang: parseBigintColumn(r.amount, 'collected_by_method'),
    }));
  },

  async monthlyBilledCollected(ctx, filters, range): Promise<readonly MonthlyBilledCollected[]> {
    const { inv, cn, rf } = tables();
    const t = ctx.slug;
    const scope = scopeOf(filters);
    const month = (d: SQL) => sql`to_char(${d}, 'YYYY-MM')`;
    const result = await rows(
      ctx,
      sql`
      WITH terms AS (
        SELECT ${month(sql`${inv.issueDate}`)} AS month, ${inv.totalSatang} AS billed, 0::bigint AS collected
        FROM ${inv}
        WHERE ${inv.tenantId} = ${t} AND ${inv.status} NOT IN ('draft', 'void')
          AND ${inRange(sql`${inv.issueDate}`, range)}${scope}
        UNION ALL
        SELECT ${month(invoiceTaxPointSql)}, 0::bigint, ${inv.totalSatang}
        FROM ${inv}
        WHERE ${inv.tenantId} = ${t} AND ${inv.status} IN ${PAID_FAMILY}
          AND ${inRange(invoiceTaxPointSql, range)}${scope}
        UNION ALL
        SELECT ${month(sql`${cn.issueDate}`)},
               CASE WHEN ${inv.status} NOT IN ('draft', 'void') THEN 0 - ${cn.totalSatang} ELSE 0 END,
               CASE WHEN ${inv.status} IN ${PAID_FAMILY} THEN 0 - ${cn.totalSatang} ELSE 0 END
        FROM ${creditNotesJoin(t)}
          AND ${inRange(sql`${cn.issueDate}`, range)}${scope}
        UNION ALL
        SELECT ${month(waivedBangkokDate())}, 0::bigint, 0 - ${rf.amountSatang}
        FROM ${refundsJoin(t)}
          AND ${waivedRefund()}
          AND ${inv.status} IN ${PAID_FAMILY}
          AND ${inRange(waivedBangkokDate(), range)}${scope}
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
    const t = ctx.slug;
    const scope = scopeOf(filters);
    // Read per call like `tables()`: a partial mock of the payments barrel
    // must not crash this module at load. Strictly older, as the sweep's
    // `ageMs <= ESCALATION_AGE_MS → not yet` reads.
    const pendingBefore = new Date(now.getTime() - STALE_REFUND_ESCALATION_AGE_MS).toISOString();
    const result = await rows(
      ctx,
      sql`
      SELECT
        (SELECT COUNT(*)::int FROM ${inv}
          WHERE ${inv.tenantId} = ${t} AND ${inv.status} = 'draft' AND ${inv.origin} = 'manual'${scope}
        ) AS manual_drafts,
        (SELECT COUNT(*)::int FROM ${inv}
          WHERE ${inv.tenantId} = ${t} AND ${inv.status} = 'draft' AND ${inv.origin} = 'auto_renewal'${scope}
        ) AS auto_renewal_drafts,
        (SELECT COUNT(*)::int FROM ${inv}
          WHERE ${inv.tenantId} = ${t} AND ${inv.receiptPdfStatus} = 'failed'${scope}
        ) AS receipt_pdf_failed,
        (SELECT COUNT(*)::int FROM (
           SELECT DISTINCT ON (${rf.paymentId}) ${rf.status} AS status, ${rf.failureReasonCode} AS code
           FROM ${refundsJoin(t)}${scope}
           ORDER BY ${rf.paymentId}, ${rf.initiatedAt} DESC, ${rf.createdAt} DESC, ${rf.id} DESC
         ) latest
         WHERE latest.status = 'failed' AND latest.code LIKE 'stripe_refund_%'
        ) AS refunds_failed_at_stripe,
        (SELECT COUNT(*)::int FROM ${refundsJoin(t)}
          AND ${rf.status} = 'pending' AND ${rf.initiatedAt} < ${pendingBefore}::timestamptz${scope}
        ) AS refunds_pending_over_threshold`,
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
    const t = ctx.slug;
    const docNo = sql`COALESCE(${inv.documentNumber}, ${inv.billDocumentNumberRaw})`;
    const result = await rows(
      ctx,
      sql`
      SELECT ${inv.invoiceId}::text AS invoice_id,
             ${docNo} AS document_number,
             ${inv.memberIdentitySnapshot} ->> 'legal_name' AS buyer_name,
             ${inv.dueDate}::text AS due_date,
             (${today}::date - ${inv.dueDate})::int AS days_past_due,
             ${inv.totalSatang}::bigint AS amount
      FROM ${inv}
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
    }));
  },
};
