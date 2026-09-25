/**
 * FR-021 / AS2 — where the one-hour dispatch retry budget starts, for BOTH
 * dispatch legs (`dispatchScheduledBroadcast` and `buildAudienceTick`). One
 * reader, so the legs cannot drift (they did once: round 4 F3).
 *
 * **F119 PR-E (migration 0311) — the budget counts from the FIRST retryable
 * gateway failure of the current dispatch attempt**, persisted as
 * `broadcasts.dispatch_first_failed_at`. It used to count from
 * `scheduledFor ?? approvedAt ?? createdAt`, which was only right while a row
 * was always attempted on time. Since #403 (a suspended member's E-Blast is
 * HELD at dispatch) and #410 (every cron pauses under READ_ONLY_MODE), a row
 * resuming days after its schedule is routine, and on that path ONE retryable
 * Resend error went terminal: the row failed for good, the member was told the
 * provider had been unreachable for over an hour (false), and
 * `dispatchBudgetExhausted` paged on-call. Anchored on the failure, the member
 * email's "unreachable for over an hour" is now true by construction, and the
 * send-now fallback (`approvedAt`) is gone with the epoch it patched: the clock
 * starts at the failure whatever the row's schedule was.
 *
 * Only a real gateway failure starts the clock — a HOLD and a READ_ONLY_MODE
 * skip never reach this function. `applyTransition` resets the column on a
 * status change or a re-time, so a re-approved or re-dispatched row starts
 * clean.
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';

/** FR-021 — how long retryable gateway failures may continue before the row goes terminal. */
export const RETRY_BUDGET_MS = 60 * 60 * 1000;

/**
 * The instant the budget counts from, starting the clock if this is the first
 * retryable failure of the attempt.
 *
 * - Already stamped → that stamp. No write: the stored value cannot have moved
 *   (COALESCE), and a status change since the read would have cleared it AND
 *   taken the row out of `approved`, where the stamp's predicate cannot reach.
 * - Not stamped → stamp `now` in its OWN transaction (both legs call this after
 *   their Step-1 lock tx has committed, so no row lock is held and no second
 *   pool connection is taken while one is), and answer `now`: the first failure
 *   is within budget by construction.
 * - The stamp write FAILS → logged (`errKind` only — a Neon error carries bound
 *   parameters) and still `now`. A failed bookkeeping write must never turn a
 *   retryable failure into a permanent one; the next failure tries again. This
 *   rescues only an UNSTAMPED row — a row already carrying a 61-minute-old
 *   stamp never reaches the write, so a storage fault cannot extend a spent
 *   budget.
 */
export async function dispatchRetryEpoch(
  deps: { readonly tenant: TenantContext; readonly broadcastsRepo: BroadcastsRepo },
  broadcastId: BroadcastId,
  broadcast: Broadcast,
  now: Date,
  /** The leg's own log event, so an operator can tell the two apart. */
  stampFailedEvent: string,
): Promise<Date> {
  if (broadcast.dispatchFirstFailedAt !== null) return broadcast.dispatchFirstFailedAt;
  try {
    await deps.broadcastsRepo.withTx((tx) =>
      deps.broadcastsRepo.markDispatchRetryStarted(tx, deps.tenant.slug, broadcastId, now),
    );
  } catch (e) {
    logger.warn(
      {
        err: errKind(e),
        tenantId: deps.tenant.slug,
        broadcastId: broadcastId as string,
      },
      stampFailedEvent,
    );
  }
  return now;
}
