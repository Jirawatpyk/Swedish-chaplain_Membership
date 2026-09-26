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
 * `dispatchBudgetExhausted` paged on-call. The send-now fallback (`approvedAt`)
 * is gone with the epoch it patched: the clock starts at the failure whatever
 * the row's schedule was.
 *
 * What moves the clock:
 * - A retryable gateway failure STARTS it (`dispatchRetryEpoch`, COALESCE — the
 *   first failure of the attempt wins).
 * - A status change or a re-time RESETS it (`applyTransition`, in the adapter).
 * - A HOLD resets it (`resetDispatchRetryClock`): a suspended member's row can
 *   sit for days, and the hour it had left before the hold says nothing about
 *   the provider after it. A successful `sendBroadcast` resets it too: the
 *   provider has the mail, so there is nothing left to budget.
 *
 * **Residual — the READ_ONLY_MODE freeze does NOT reset it.** A cron paused by
 * the freeze never reaches the row, so it cannot write, and writing is exactly
 * what the freeze forbids. A row that failed before a freeze keeps its stamp;
 * if the freeze outlasts the rest of its hour, the first retryable failure after
 * the lift is terminal, and the member email's "unreachable for over an hour"
 * then describes the freeze, not the provider. The claim is true by
 * construction everywhere else. Mitigation (runbook `cron-jobs.md` § Read-only
 * mode): after lifting a long freeze, clear the clock with SQL on the stamped
 * `approved` rows (`dispatch_first_failed_at = NULL`, as the migration owner or
 * per tenant under `SET LOCAL app.current_tenant` — the PR-E rollback
 * statement). A staff re-time is not the general fix: confirm-schedule refuses
 * `round_zero` (every legacy-approved row) and `sending_started` (a row already
 * handed to Resend), so it clears the clock only on a round ≥ 1 row with no
 * Resend id.
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';

/** FR-021 — how long retryable gateway failures may continue before the row goes terminal. */
export const RETRY_BUDGET_MS = 60 * 60 * 1000;

type RetryClockDeps = { readonly tenant: TenantContext; readonly broadcastsRepo: BroadcastsRepo };

/**
 * The instant the budget counts from, starting the clock if this is the first
 * retryable failure of the attempt. `null` = the row is no longer `approved`
 * (another writer moved it since the Step-1 read): the caller stops WITHOUT a
 * terminal write — there is no attempt left to fail.
 *
 * - The stamp is written on EVERY retryable failure, in its OWN transaction
 *   (both legs call this after their Step-1 lock tx has committed, so no row
 *   lock is held and no second pool connection is taken while one is), and the
 *   answer is what `RETURNING` says the row carries. COALESCE keeps the first
 *   stamp, so the write is idempotent; reading the Step-1 snapshot instead was
 *   wrong whenever an admin re-timed the row in between (the re-time clears the
 *   clock and the row stays `approved` — the snapshot's 61-minute-old stamp
 *   then killed the freshly re-timed row).
 * - The write FAILS → logged (`errKind` only — a Neon error carries bound
 *   parameters), counted (`broadcasts_dispatch_retry_stamp_failed_total`: a
 *   stamp that fails every tick means endless retries) and the snapshot's stamp
 *   answers, else `now`. A failed bookkeeping write must never turn a retryable
 *   failure into a permanent one, and must never extend a spent budget either:
 *   a row whose snapshot carries a 61-minute-old stamp is still measured from
 *   it.
 */
export async function dispatchRetryEpoch(
  deps: RetryClockDeps,
  broadcastId: BroadcastId,
  broadcast: Broadcast,
  now: Date,
  /** The leg's own log event, so an operator can tell the two apart. */
  stampFailedEvent: string,
): Promise<Date | null> {
  try {
    return await deps.broadcastsRepo.withTx((tx) =>
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
    broadcastsMetrics.dispatchRetryStampFailed(deps.tenant.slug);
    return broadcast.dispatchFirstFailedAt ?? now;
  }
}

/**
 * Reset the FR-021 clock on a row still `approved` (a HOLD, or a successful
 * `sendBroadcast`) — best-effort. In its own transaction, outside any row lock.
 *
 * Called unconditionally, not gated on the Step-1 snapshot: the snapshot can be
 * stale in both directions (the L3 class), and the adapter's predicate
 * (`dispatch_first_failed_at IS NOT NULL`) already makes an unstamped row a
 * 0-row UPDATE.
 *
 * A failure is logged (`errKind` only) and swallowed: the caller's outcome —
 * held, or sent — is already decided and true, and a lost reset costs at most
 * a budget measured from an older failure, which the next hold or send retries.
 */
export async function resetDispatchRetryClock(
  deps: RetryClockDeps,
  broadcastId: BroadcastId,
  /** The leg's own log event, so an operator can tell the two apart. */
  clearFailedEvent: string,
): Promise<void> {
  try {
    await deps.broadcastsRepo.withTx((tx) =>
      deps.broadcastsRepo.clearDispatchRetryClock(tx, deps.tenant.slug, broadcastId),
    );
  } catch (e) {
    logger.warn(
      {
        err: errKind(e),
        tenantId: deps.tenant.slug,
        broadcastId: broadcastId as string,
      },
      clearFailedEvent,
    );
  }
}
