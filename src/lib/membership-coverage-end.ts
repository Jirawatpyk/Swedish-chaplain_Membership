/**
 * 0305 — presentation-layer orchestration of the ONE "end membership coverage"
 * operation, shared by `POST /api/credit-notes` (full manual credit note,
 * `membershipEffect: 'cancel_membership'`) and `POST /api/refunds/initiate`
 * (full refund of a membership invoice, same effect).
 *
 * Both routes call this AFTER their own money work has committed; F4/F5
 * Application never import F8 (Principle III), so the route is the seam. A
 * failure here NEVER fails the already-committed credit note / refund — it
 * comes back as an outcome the admin UI turns into a notice.
 *
 * Outcomes (the `membership_end` response field):
 *   - `ended`         access ended now.
 *   - `scheduled`     the refund is still settling; coverage ends once it
 *                     settles `succeeded` (nightly reconcile). A `failed`
 *                     settle keeps the membership — no money came back.
 *   - `deferred`      the end failed inline; the nightly pass retries it.
 *   - `no_open_cycle` the member has no open renewal cycle — nothing to end.
 *   - `failed`        could not end or schedule; the admin must follow up.
 */
import { logger } from '@/lib/logger';
import { asMemberId } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';
import {
  endMembershipCoverageNow,
  makeRenewalsDeps,
  type CoverageEndTrigger,
} from '@/modules/renewals';

export type MembershipEndOutcome =
  | 'ended'
  | 'scheduled'
  | 'deferred'
  | 'no_open_cycle'
  | 'failed';

export async function endMembershipAfterMoneyReturned(args: {
  readonly tenant: TenantContext;
  /** Null only on a corrupt row (a membership invoice always has a member). */
  readonly memberId: string | null;
  readonly trigger: CoverageEndTrigger;
  /** The async refund to wait on; omit when the money is already back. */
  readonly awaitRefund?: { readonly refundId: string; readonly invoiceId: string };
  readonly initiatedByUserId: string;
  readonly initiatedByRole?: 'admin' | 'super_admin';
  readonly requestId: string | null;
  readonly correlationId: string;
}): Promise<MembershipEndOutcome> {
  const logBase = {
    tenantId: args.tenant.slug,
    trigger: args.trigger,
    correlationId: args.correlationId,
    requestId: args.requestId,
  };
  if (args.memberId === null) {
    logger.error(logBase, 'membership_end.no_member_on_invoice (unreachable — investigate)');
    return 'failed';
  }
  try {
    const r = await endMembershipCoverageNow(makeRenewalsDeps(args.tenant.slug), {
      tenant: args.tenant,
      memberId: asMemberId(args.memberId),
      trigger: args.trigger,
      ...(args.awaitRefund ? { awaitRefund: args.awaitRefund } : {}),
      initiatedByUserId: args.initiatedByUserId,
      ...(args.initiatedByRole ? { initiatedByRole: args.initiatedByRole } : {}),
      requestId: args.requestId,
      correlationId: args.correlationId,
    });
    if (!r.ok) {
      logger.error({ ...logBase, errName: r.error.errName }, 'membership_end.failed');
      return 'failed';
    }
    if (r.value.outcome !== 'ended' && r.value.outcome !== 'scheduled') {
      logger.warn({ ...logBase, outcome: r.value.outcome }, 'membership_end.not_ended_now');
    }
    return r.value.outcome;
  } catch (e) {
    logger.error(
      { ...logBase, errName: e instanceof Error ? e.name : 'UnknownError' },
      'membership_end.threw',
    );
    return 'failed';
  }
}
