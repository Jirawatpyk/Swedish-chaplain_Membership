/**
 * 107-auto-invoice Task 16 — the aggregate behind the three auto-invoice
 * observable gauges.
 *
 * Lives here rather than inline in
 * `src/app/api/cron/renewals/auto-draft-coordinator/route.ts` (where the
 * sibling `observeCycleStateGaugesForTenant` still keeps its SQL) for one
 * reason: **testability**. Review MAJOR-3 — inline in the route, this query
 * was pinned by nothing. The coordinator unit test mocks `runInTenant` so the
 * gauge path no-ops, and a Next.js `route.ts` cannot export arbitrary symbols
 * for a test to import (only the route-handler contract). A rename of
 * `origin`, `invoice_subject`, `members.erased_at` or the cycle-status enum
 * would have broken it silently into a `logger.warn`. As its own module it is
 * covered directly by `tests/integration/renewals/auto-invoice-gauges.test.ts`
 * against live Neon.
 *
 * Consumed by the route through the module barrel (`@/modules/renewals`), the
 * same way that route already consumes `makeRenewalsDeps` — Presentation
 * touches the module's public interface, never a deep infrastructure path.
 *
 * See the calling function's JSDoc in the coordinator route for the full
 * rationale on each column: why the queue predicate matches the treasurer's
 * screen verbatim, why the aggregates are scalar subqueries rather than
 * `COUNT(*) FILTER` (index-eligibility — migration 0264), why the member-side
 * gate is load-bearing, and why enrolment is deliberately NOT part of it.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

export interface AutoInvoiceGaugeRow {
  /** Drafts awaiting treasurer review: origin='auto_renewal', status='draft'. */
  readonly queue_size: number;
  /** Age of the oldest such draft, seconds. 0 when the queue is empty. */
  readonly oldest_age_seconds: number;
  /** Wedged: awaiting_payment cycles, billable member, no live invoice. */
  readonly awaiting_payment_no_invoice: number;
}

/**
 * Reads the three gauge values for one tenant in a single round trip.
 *
 * Tenant isolation is two-layer (Constitution Principle I): the aggregate runs
 * on the `tx` threaded from `runInTenant` (which sets `app.current_tenant`, so
 * RLS+FORCE applies) AND carries an explicit `tenant_id = ${tenantId}`
 * predicate on every table it touches — `invoices`, `renewal_cycles` and
 * `members`, with the inner `NOT EXISTS` pinned transitively through `rc`.
 *
 * Throws on DB error — the CALLER owns the best-effort/never-block contract,
 * because it is the caller that knows this is a cron path. Keeping the throw
 * here means the integration test can assert on real failures.
 */
export async function readAutoInvoiceGaugeRow(
  tenantId: string,
): Promise<AutoInvoiceGaugeRow | null> {
  const ctx = asTenantContext(tenantId);
  const rows = await runInTenant<ReadonlyArray<AutoInvoiceGaugeRow>>(
    ctx,
    async (tx) => {
      const result = await tx.execute(sql`
        SELECT
          -- (1) Review-queue depth. Predicate lives in WHERE (not a
          -- COUNT(*) FILTER over an outer FROM) so the partial index
          -- invoices_auto_renewal_draft_idx is usable.
          (
            SELECT COUNT(*)::int
            FROM invoices q
            WHERE q.tenant_id = ${tenantId}
              AND q.origin = 'auto_renewal'
              AND q.status = 'draft'
          ) AS queue_size,
          -- (2) Head-of-queue age, same predicate, same index.
          -- COALESCE covers the empty queue, where MIN is NULL.
          (
            SELECT COALESCE(
              EXTRACT(EPOCH FROM (NOW() - MIN(a.created_at))),
              0
            )::int
            FROM invoices a
            WHERE a.tenant_id = ${tenantId}
              AND a.origin = 'auto_renewal'
              AND a.status = 'draft'
          ) AS oldest_age_seconds,
          -- (3) Wedged-state detector: cycles awaiting payment with no live
          -- membership invoice to pay. Steady-state expectation is 0.
          -- The members EXISTS gate mirrors listCyclesEligibleForAutoDraft's
          -- member-side gate (minus enrolment — see the caller's JSDoc).
          (
            SELECT COUNT(*)::int
            FROM renewal_cycles rc
            WHERE rc.tenant_id = ${tenantId}
              AND rc.status = 'awaiting_payment'
              AND EXISTS (
                SELECT 1
                FROM members m
                WHERE m.tenant_id = rc.tenant_id
                  AND m.member_id = rc.member_id
                  AND m.archived_at IS NULL
                  AND m.status <> 'archived'
                  AND m.erased_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1
                FROM invoices live
                WHERE live.tenant_id = rc.tenant_id
                  AND live.member_id = rc.member_id
                  AND live.invoice_subject = 'membership'
                  AND live.status IN ('draft', 'issued')
              )
          ) AS awaiting_payment_no_invoice
      `);
      // Drizzle's postgres-js driver returns the rows array directly.
      // Cast through `unknown` because the declared Row type is narrower
      // than the driver's untyped rowset.
      return (result as unknown as ReadonlyArray<AutoInvoiceGaugeRow>) ?? [];
    },
  );
  return rows[0] ?? null;
}
