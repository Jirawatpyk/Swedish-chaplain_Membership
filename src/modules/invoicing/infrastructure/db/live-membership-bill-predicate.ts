/**
 * Single source of truth for "a live membership bill for (tenant, member,
 * plan year)" — the WHERE predicate every duplicate-§86/4 guard shares.
 *
 * Extracted so the two guards that must agree on what counts as a live
 * membership bill read ONE definition, not two that can silently drift:
 *   - `createInvoiceDraft` (invoicing) — the admin "New invoice" guard.
 *   - `markPaidOffline` (renewals, via the F8 `InvoiceDueBridge`) — the
 *     offline mark-paid guard.
 * Both previously inlined a byte-identical copy of this predicate in their
 * own adapter; four inconsistent copies of this check is what produced the
 * duplicate-bill defect in the first place. Callers keep their OWN projection
 * and ordering (they surface different columns to different operators) — only
 * the "what counts as live" rule lives here.
 *
 * "Live" = `status <> 'void'` (`ne`, NOT an IN-list of the live statuses): a
 * future `invoiceStatusEnum` value then defaults to BLOCKING — the safe
 * direction for a §86/4 duplicate check (refuse to mint a second numbered tax
 * document rather than silently fall through). A voided invoice must NOT block:
 * one voided for correction has to stay re-issuable.
 *
 * Tenant scope rides the caller's `SET LOCAL app.current_tenant` GUC under
 * RLS; the explicit `tenant_id` predicate here is application-layer
 * defence-in-depth (Constitution Principle I § 1), matching the sibling reads
 * in both adapters.
 */
import { and, eq, ne, type SQL } from 'drizzle-orm';
import { invoices } from './schema-invoices';

export interface LiveMembershipBillKey {
  readonly tenantId: string;
  readonly memberId: string;
  readonly planYear: number;
}

export function liveMembershipBillWhere(key: LiveMembershipBillKey): SQL | undefined {
  return and(
    eq(invoices.tenantId, key.tenantId),
    eq(invoices.memberId, key.memberId),
    eq(invoices.invoiceSubject, 'membership'),
    eq(invoices.planYear, key.planYear),
    ne(invoices.status, 'void'),
  );
}
