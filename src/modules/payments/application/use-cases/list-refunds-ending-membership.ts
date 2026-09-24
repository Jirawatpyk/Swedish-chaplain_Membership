/**
 * 0305 — read facade: recent refunds whose staff chose "End membership"
 * (`refunds.membership_effect = 'cancel_membership'`, pinned in Phase A).
 *
 * The renewals reconcile uses it as a BACKSTOP: the refund route ends the
 * member's coverage right after the refund commits, but that call can be lost
 * (the function dies, or the refund returns `f4_bridge_deferred` AFTER Stripe
 * refunded). This row is the durable record of the decision.
 *
 * Read-only, tenant-scoped. Pure Application — its own port, no ORM imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { RefundStatus } from '../../domain/refund';

export interface RefundEndingMembershipRow {
  readonly refundId: string;
  readonly invoiceId: string;
  readonly memberId: string;
  readonly status: RefundStatus;
  readonly initiatedAt: Date;
}

export interface ListRefundsEndingMembershipDeps {
  readonly read: (tenantId: string, since: Date) => Promise<readonly RefundEndingMembershipRow[]>;
}

export async function listRefundsEndingMembership(
  deps: ListRefundsEndingMembershipDeps,
  input: { readonly tenantId: string; readonly since: Date },
): Promise<Result<readonly RefundEndingMembershipRow[], { readonly code: 'read_failed' }>> {
  try {
    return ok(await deps.read(input.tenantId, input.since));
  } catch {
    return err({ code: 'read_failed' });
  }
}
