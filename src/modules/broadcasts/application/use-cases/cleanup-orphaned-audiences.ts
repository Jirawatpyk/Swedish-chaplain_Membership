/**
 * PR-2 Task 3 — `cleanup-orphaned-audiences.ts` Application use-case (defect #5).
 *
 * Deletes the ephemeral per-broadcast Resend audiences created during dispatch
 * for broadcasts that have reached a terminal status (sent / cancelled /
 * failed_to_dispatch / rejected / partial_delivery_accepted). Without this
 * cleanup, Resend audiences accumulate indefinitely, wasting sub-processor
 * storage and obscuring the active-audience count in the Resend dashboard.
 *
 * Design:
 *   - Lists terminal broadcasts whose audience has not yet been deleted
 *     (`audience_deleted_at IS NULL`) and whose `updated_at` is before the
 *     grace cutoff (so a very recently terminal broadcast doesn't race with
 *     Resend's own post-send processing).
 *   - For each candidate: calls `gateway.deleteAudience` (best-effort; 404
 *     resolves — already gone; 5xx / network throws `GatewayThrowable`).
 *   - On success: stamps `audience_deleted_at` via `markAudienceDeletedInTx`
 *     inside a per-item `broadcastsRepo.withTx(fn)` so the mark is
 *     tenant-scoped (RLS via the `withTx` Drizzle adapter's `runInTenant`
 *     seam — Constitution Principle I). This mirrors the pattern used by
 *     `reconcile-stuck-sending.ts` (the reference cron use-case).
 *   - On throw: logs a structured warning and leaves the row for the next
 *     cron tick. `failed` counter increments; the batch continues.
 *
 * Tenant-tx approach: `broadcastsRepo.withTx` is the Application-layer seam
 * for opening a tenant-bound Drizzle transaction without importing the
 * Infrastructure `runInTenant` directly (Clean Architecture Principle III).
 * Matches `reconcile-stuck-sending.ts` which uses `deps.broadcastsRepo.withTx`
 * for every per-broadcast DB write.
 *
 * ClockPort: `graceCutoff = new Date(deps.clock.now() - graceMs)`. Injected
 * for deterministic unit testing; production cron passes a `SystemClock`.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';

import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupOrphanedAudiencesDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly broadcastsGateway: BroadcastsGatewayPort;
  readonly clock: ClockPort;
}

export interface CleanupOrphanedAudiencesInput {
  /**
   * Grace window in milliseconds. Only broadcasts whose `updated_at` is older
   * than `clock.now() - graceMs` are eligible. Prevents racing with Resend's
   * own post-send processing on very recently terminal broadcasts.
   */
  readonly graceMs: number;
  /**
   * Maximum candidates to process per invocation. Keeps cron execution time
   * bounded. Production value: 200 (configured at the route layer).
   */
  readonly limit: number;
}

export interface CleanupOrphanedAudiencesOutput {
  /** Total candidates retrieved from the list query. */
  readonly processed: number;
  /** Audiences successfully deleted and marked. */
  readonly deleted: number;
  /** Candidates whose delete threw (left for next cron tick). */
  readonly failed: number;
}

export type CleanupOrphanedAudiencesError = {
  readonly kind: 'cleanup.server_error';
  readonly message: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function cleanupOrphanedAudiences(
  deps: CleanupOrphanedAudiencesDeps,
  input: CleanupOrphanedAudiencesInput,
): Promise<Result<CleanupOrphanedAudiencesOutput, CleanupOrphanedAudiencesError>> {
  const tenantId = deps.tenant.slug;
  // Nit carried from Task 2 review: derive cutoff from the injected clock,
  // never from `new Date()` directly (deterministic unit testing).
  const graceCutoff = new Date(deps.clock.now().getTime() - input.graceMs);

  let candidates: ReadonlyArray<{ broadcastId: string; resendAudienceId: string }>;
  try {
    candidates = await deps.broadcastsRepo.listTerminalBroadcastsWithLiveAudience(
      tenantId,
      graceCutoff,
      input.limit,
    );
  } catch (e) {
    // List failure is unexpected (Neon outage, RLS misconfiguration, etc.)
    // Surface as cleanup.server_error so the cron route can return 500 and
    // cron-job.org will retry on the next tick.
    const message = e instanceof Error ? e.message : 'unknown error';
    const safeMessage = message.length > 500 ? message.slice(0, 500) + '…' : message;
    return err({ kind: 'cleanup.server_error', message: safeMessage });
  }

  let deleted = 0;
  let failed = 0;

  for (const candidate of candidates) {
    // Best-effort per-item: a single failed delete must NOT abort the batch.
    // Per project memory `mock-only-tests-miss-throw-paths`: per-item try/catch
    // is MANDATORY and the throw-path test (2 candidates, #2 throws) verifies
    // this invariant at the unit level.
    try {
      // 1. Delete the Resend audience. 404 → resolves (already gone);
      //    5xx / network → throws GatewayThrowable (caught below).
      await deps.broadcastsGateway.deleteAudience(candidate.resendAudienceId);

      // 2. Stamp audience_deleted_at inside a per-item tenant-bound tx.
      //    `withTx` is the Application-layer port seam for opening a Drizzle
      //    tx with `app.current_tenant` GUC set (mirrors reconcile-stuck-sending).
      await deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.markAudienceDeletedInTx(tx, candidate.broadcastId);
      });

      deleted++;
    } catch (e) {
      failed++;
      logger.warn(
        {
          broadcastId: candidate.broadcastId,
          cause: e instanceof Error ? e.message : 'unknown error',
        },
        'broadcasts.audience_cleanup.delete_failed',
      );
      // Row stays with audience_deleted_at IS NULL → eligible for retry on
      // next cron tick (cron-job.org polls every N minutes).
    }
  }

  return ok({ processed: candidates.length, deleted, failed });
}
