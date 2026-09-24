/**
 * F119 T130 — `ApprovalLifecycleScanPort` Application port: the daily scan
 * behind the reminder / warning / expiry block of the
 * `prune-expired-drafts` cron (contracts/dashboard-and-notifications.md § 5,
 * data-model § 3 `broadcasts_awaiting_member_idx`).
 *
 * Kept separate from `BroadcastsRepo` for the reason `BroadcastApprovalCounter`
 * is: a method added there has to be stubbed by every repo double in the
 * suite. The writes go through the existing `applyTransition`; this port only
 * FINDS candidates, and every candidate is re-read under the row lock before
 * anything is written.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantSlug } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';

/** One E-Blast awaiting the member, as the scan found it. */
export interface AwaitingApprovalCandidate {
  readonly broadcastId: BroadcastId;
  readonly stageEnteredAt: Date;
}

/**
 * `status = 'awaiting_member_approval'` — and no other status, ever (FR-022a:
 * expiry applies only while awaiting the member) — with `stage_entered_at` in
 * `(enteredAfter, enteredAtOrBefore]`, OLDEST FIRST, at most `limit`.
 */
export interface AwaitingApprovalScanQuery {
  readonly enteredAtOrBefore: Date;
  readonly enteredAfter?: Date;
  readonly limit: number;
}

export interface ApprovalLifecycleScanPort {
  /** The candidates, on the caller's `runInTenant` tx (never the pool-global `db`). */
  listAwaitingMemberApprovalInTx(
    tx: unknown,
    tenantId: TenantSlug,
    query: AwaitingApprovalScanQuery,
  ): Promise<readonly AwaitingApprovalCandidate[]>;
  /**
   * `SET LOCAL statement_timeout` on the caller's transaction, in MILLISECONDS
   * — the pooled Neon endpoint drops the connection-level 5 s, so without it
   * the block's only bound is the route's `maxDuration` (the image sweep's
   * ROUND-3 #4 finding). On the port because Application may not import
   * Drizzle.
   */
  setStatementTimeoutInTx(tx: unknown, ms: number): Promise<void>;
}
