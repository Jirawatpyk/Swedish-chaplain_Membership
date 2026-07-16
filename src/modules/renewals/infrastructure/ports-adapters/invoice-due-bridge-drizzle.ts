/**
 * 059-membership-suspension Task 12 — Drizzle adapter for the F8 →
 * `InvoiceDueBridge` port.
 *
 * Reads F4's `invoices` table directly (read-only) — `true` iff the
 * member has a `status='issued'`, `invoice_subject='membership'` row
 * whose `due_date` is non-null and `>= todayBkk`. F4 doesn't expose a
 * use-case for this exact question today (the closest,
 * `listInvoicesByMember`, returns a richer projection than this cheap
 * boolean check needs), so this is a direct schema read via the
 * `invoicesTable` barrel re-export (mirrors
 * `f5-payment-attempts-bridge-drizzle.ts` reading `paymentsTable`).
 *
 * Tenant scope: RLS on `invoices` enforces `tenant_id` isolation per
 * `runInTenant(ctx, …)`. The explicit `eq(invoicesTable.tenantId, …)`
 * predicate is application-layer defence-in-depth alongside RLS
 * (Constitution Principle I § 1).
 */
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { invoicesTable } from '@/modules/invoicing';
import type {
  HasUnpaidNotYetDueMembershipInvoiceInput,
  InvoiceDueBridge,
  OldestUnpaidMembershipInvoiceDueDateInput,
} from '../../application/ports/invoice-due-bridge';

export function makeInvoiceDueBridgeDrizzle(ctx: TenantContext): InvoiceDueBridge {
  return {
    async hasUnpaidNotYetDueMembershipInvoice(
      input: HasUnpaidNotYetDueMembershipInvoiceInput,
    ): Promise<boolean> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ invoiceId: invoicesTable.invoiceId })
          .from(invoicesTable)
          .where(
            and(
              eq(invoicesTable.tenantId, input.tenantId),
              eq(invoicesTable.memberId, input.memberId),
              eq(invoicesTable.invoiceSubject, 'membership'),
              eq(invoicesTable.status, 'issued'),
              isNotNull(invoicesTable.dueDate),
              gte(invoicesTable.dueDate, input.todayBkk),
            ),
          )
          .limit(1);
        return rows.length > 0;
      });
    },

    async oldestUnpaidMembershipInvoiceDueDate(
      input: OldestUnpaidMembershipInvoiceDueDateInput,
    ): Promise<string | null> {
      // 065 §5.2 — the member's OLDEST-DUE unpaid membership invoice
      // `due_date` (or null), restricted to invoices due on/after
      // `input.sinceDueDate`. Member-scoped, NOT `linked_invoice_id`: a
      // §5.3 born-`awaiting_payment` initial cycle has no linked invoice,
      // so anchoring the lapse clock on the cycle's linked invoice would
      // miss exactly that cohort. `status='issued'` = unpaid (draft/paid/
      // void/credited never count); `ORDER BY due_date ASC LIMIT 1` picks
      // the oldest so a member with several unpaid invoices is judged by
      // the one they were asked to pay first. The
      // `gte(dueDate, sinceDueDate)` floor (065 §5.2 review) keeps a STALE
      // prior-period invoice from anchoring the CURRENT period's
      // termination clock — see the port's `sinceDueDate` note. RLS scopes
      // to the tenant via `runInTenant`; the explicit `tenantId` predicate
      // is defence-in-depth alongside RLS (Constitution Principle I § 1).
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ dueDate: invoicesTable.dueDate })
          .from(invoicesTable)
          .where(
            and(
              eq(invoicesTable.tenantId, input.tenantId),
              eq(invoicesTable.memberId, input.memberId),
              eq(invoicesTable.invoiceSubject, 'membership'),
              eq(invoicesTable.status, 'issued'),
              isNotNull(invoicesTable.dueDate),
              gte(invoicesTable.dueDate, input.sinceDueDate),
            ),
          )
          .orderBy(sql`${invoicesTable.dueDate} ASC`)
          .limit(1);
        return rows[0]?.dueDate ?? null;
      });
    },
  };
}
