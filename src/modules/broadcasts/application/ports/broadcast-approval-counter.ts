/**
 * `BroadcastApprovalCounter` port — counts the E-Blasts waiting on MARKETING
 * for the current tenant. Kept separate from the broad `BroadcastsRepo` so
 * adding it doesn't force every existing repo mock to grow a method.
 *
 * F119 T132 — "waiting on marketing" is the marketing-turn set
 * (`MARKETING_TURN_STATUSES`: submitted, in_design, changes_requested,
 * member_approved), the same Domain predicate the
 * `broadcasts_marketing_turn_count` gauge counts. It was `status = 'submitted'`
 * alone before the approval round existed, and the F9 dashboard's "needs
 * attention" count (FR-002 / AS-2) reads the widened set too.
 */
import type { TenantContext } from '@/modules/tenants';

/** The two numbers the staff nav badge needs, from one indexed count. */
export interface MarketingQueueCounts {
  /** E-Blasts whose turn is marketing's — the badge's number. */
  readonly marketingTurn: number;
  /**
   * E-Blasts in an approval-round stage (`APPROVAL_ROUND_STATUSES`) — with the
   * feature flag off, the badge shows only while this is > 0 (research R18).
   */
  readonly inApprovalRound: number;
}

export interface BroadcastApprovalCounter {
  /** The marketing-turn count (the F9 dashboard's "needs attention" item). */
  countAwaitingApproval(ctx: TenantContext): Promise<number>;
  /** F119 T132 — both counts for the staff nav badge, in one query. */
  countMarketingQueue(ctx: TenantContext): Promise<MarketingQueueCounts>;
}
