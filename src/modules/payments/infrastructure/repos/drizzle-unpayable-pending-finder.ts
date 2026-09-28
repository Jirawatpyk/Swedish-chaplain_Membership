/**
 * Drizzle adapter for `UnpayablePendingFinderPort` — one cross-tenant read for
 * the hourly retry sweep (`sweepPendingPaymentsOnUnpayableInvoices`).
 *
 * Runs on the OWNER `db` (bypasses RLS, no `app.current_tenant`) on purpose:
 * this is a cross-tenant ops path gated by CRON_SECRET, like the sibling
 * `stale-pending-count` gauge and `void-pdf-reconcile` scan. It only READS
 * `(tenant_id, invoice_id)` pairs; every write happens afterwards per tenant
 * through `runInTenant` in the cancel use-case.
 *
 * The age window is measured from `GREATEST(p.initiated_at, i.updated_at)` —
 * i.e. from whichever came LAST: the attempt, or the invoice's last write
 * (every status transition — void, pay, credit — sets `updated_at = now()`).
 * Measuring from `initiated_at` alone would never retry an attempt that was
 * already 7 days old when its invoice was voided (review M2), and could
 * race the void's own post-commit cancel for a young void on an old attempt.
 *
 * Raw SQL keeps the payments module from importing the invoicing module's
 * Drizzle schema (Principle III); the `invoices` columns used are the stable
 * `tenant_id`, `invoice_id`, `status` and `updated_at`.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import type { UnpayablePendingFinderPort } from '../../application/ports/unpayable-pending-finder-port';

interface Row {
  readonly tenant_id: string;
  readonly invoice_id: string;
  [key: string]: unknown;
}

export const drizzleUnpayablePendingFinder: UnpayablePendingFinderPort = {
  async listInvoicesWithPendingOnUnpayable({ minAgeMinutes, maxAgeDays, limit }) {
    const result = await db.transaction(async (tx) => {
      // Bound the scan's wall-clock like the stale-pending gauge does.
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      return tx.execute<Row>(sql`
        SELECT p.tenant_id, p.invoice_id::text AS invoice_id
        FROM payments p
        JOIN invoices i
          ON i.tenant_id = p.tenant_id
         AND i.invoice_id = p.invoice_id
        WHERE p.status = 'pending'
          AND i.status <> 'issued'
          AND GREATEST(p.initiated_at, i.updated_at) < now() - (${minAgeMinutes} || ' minutes')::interval
          AND GREATEST(p.initiated_at, i.updated_at) > now() - (${maxAgeDays} || ' days')::interval
        GROUP BY p.tenant_id, p.invoice_id
        ORDER BY min(GREATEST(p.initiated_at, i.updated_at))
        LIMIT ${limit}
      `);
    });
    return Array.from(result).map((r) => ({ tenantId: r.tenant_id, invoiceId: r.invoice_id }));
  },
};
