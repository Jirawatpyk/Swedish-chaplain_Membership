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
import { db, runInTenant, type TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { invoicesTable, liveMembershipBillWhere } from '@/modules/invoicing';
import type {
  HasUnpaidNotYetDueMembershipInvoiceInput,
  InvoiceDueBridge,
  LiveMembershipBill,
  LiveMembershipBillInput,
  OldestUnpaidMembershipInvoiceDueDateInput,
} from '../../application/ports/invoice-due-bridge';

export function makeInvoiceDueBridgeDrizzle(ctx: TenantContext): InvoiceDueBridge {
  return {
    async findLiveMembershipBillInTx(
      tx: unknown,
      input: LiveMembershipBillInput,
    ): Promise<LiveMembershipBill | null> {
      // Uses the CALLER's tx (the `*InTx` convention — see the port note):
      // the caller holds a per-(tenant, cycle) advisory lock on that tx, and
      // `runInTenant` here would take a second pooled connection that neither
      // sees the lock's snapshot nor is safe to open mid-transaction.
      // Tenant scope therefore rides the caller's `SET LOCAL
      // app.current_tenant` GUC; the explicit `tenantId` predicate (inside the
      // shared helper) is application-layer defence-in-depth alongside RLS
      // (Constitution Principle I § 1), matching the sibling reads below.
      //
      // "Live membership bill" (status <> 'void') via the shared
      // `liveMembershipBillWhere` from the invoicing barrel — the SAME
      // predicate the admin-create guard (`createInvoiceDraft`) uses, so the
      // two duplicate-§86/4 checks read one rule and cannot drift. This method
      // owns only its projection + ordering.
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({
          invoiceId: invoicesTable.invoiceId,
          status: invoicesTable.status,
        })
        .from(invoicesTable)
        .where(
          liveMembershipBillWhere({
            tenantId: input.tenantId,
            memberId: input.memberId,
            planYear: input.planYear,
          }),
        )
        // Deterministic pick so the id surfaced to the operator (and the
        // deep-link in the toast) is stable across retries: newest first, so
        // they land on the document they most recently dealt with.
        .orderBy(sql`${invoicesTable.createdAt} DESC`)
        .limit(1);
      const row = rows[0];
      return row ? { invoiceId: row.invoiceId, status: row.status } : null;
    },

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

    async hasIssuedMembershipInvoiceForMemberInTx(
      tx: TenantTx,
      tenantId: string,
      memberId: string,
    ): Promise<{ readonly invoiceId: string } | null> {
      // Plan-change immediate re-freeze (Phase 2, Step 2.5). Runs on the
      // CALLER's `tx` (NOT its own `runInTenant`) so the re-freeze can consult
      // it while `change-plan` holds the member FOR UPDATE lock in one tx —
      // opening a second pooled connection here would risk a cross-connection
      // stall under the pooler's dropped `statement_timeout`. `status='issued'`
      // = unpaid-but-billed; paid / draft / void / credited / partially_credited
      // never count (a paid or voided §86/4 does NOT block the re-freeze). RLS
      // scopes the read to `tx`'s tenant GUC; the explicit `tenant_id` predicate
      // is defence-in-depth (Constitution Principle I § 1).
      const rows = await tx
        .select({ invoiceId: invoicesTable.invoiceId })
        .from(invoicesTable)
        .where(
          and(
            eq(invoicesTable.tenantId, tenantId),
            eq(invoicesTable.memberId, memberId),
            eq(invoicesTable.invoiceSubject, 'membership'),
            eq(invoicesTable.status, 'issued'),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? { invoiceId: row.invoiceId } : null;
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
