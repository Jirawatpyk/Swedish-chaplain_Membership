/**
 * PR-2 Task 3 — `reclaim-orphaned-audiences.ts` Application use-case.
 *
 * Deletes Resend audiences whose corresponding local broadcast row no longer
 * exists in the database. These "deep orphans" arise when:
 *   - A broadcast row was hard-deleted (e.g. GDPR erasure or manual purge)
 *     after a Resend audience was already created during dispatch.
 *   - A dispatch crashed mid-flight AFTER `gateway.createAudience` but BEFORE
 *     `broadcastsRepo.attachAudienceId`, leaving a Resend audience with no
 *     tracked DB reference.
 *   - An earlier `cleanup-orphaned-audiences` run partially failed and the
 *     corresponding local row was subsequently deleted before the next tick.
 *
 * Design:
 *   - Calls `gateway.listAudiences()` to enumerate ALL Resend audiences for
 *     the configured Broadcasts API key.
 *   - Filters candidates by matching audience names against the naming
 *     convention `broadcast-{tenantSlug}-{uuid}` (optional `-batch-N` suffix
 *     for split dispatches). Audiences that don't match (e.g. `General`, or
 *     another tenant's audiences that share the same Resend account) are
 *     counted as `skippedNonMatching` and ignored.
 *   - Applies a grace window (`graceMs`) to avoid racing with audiences created
 *     by an in-flight dispatch — a very fresh audience may not yet have its
 *     broadcast row committed or even created.
 *   - Calls `broadcastsRepo.existingBroadcastIds()` (tenant-scoped) to
 *     determine which extracted broadcast IDs still have live DB rows.
 *   - Deletes orphaned audiences (those whose broadcastId is NOT in the DB)
 *     via `gateway.deleteAudience`, in chunks of CONCURRENCY=5 via
 *     `Promise.allSettled` (mirrors `cleanup-orphaned-audiences.ts` and
 *     `reconcile-stuck-sending.ts`).
 *   - Per-item try/catch: a single delete failure does NOT abort the batch.
 *     "Cannot delete last audience" (Resend 403 validation) is treated as a
 *     benign skip rather than a failure — the audience cannot be removed while
 *     it is the account's sole audience, and will be eligible once a new
 *     audience is created by the next dispatch.
 *   - NO DB write on success: this use-case operates entirely on the Resend
 *     side. There is no broadcast row to update (that is the whole point — the
 *     row is gone). Compare with `cleanup-orphaned-audiences` which stamps
 *     `audience_deleted_at` on the surviving broadcast row.
 *
 * Relationship to `cleanup-orphaned-audiences`:
 *   These two use-cases are complementary, not overlapping:
 *   - `cleanup-orphaned-audiences` → broadcast row EXISTS, is terminal,
 *     audience_deleted_at IS NULL → delete audience + stamp row.
 *   - `reclaim-orphaned-audiences` (this file) → broadcast row is GONE (or
 *     never written) → delete the dangling Resend audience.
 *   Run BOTH cron jobs to achieve full audience hygiene.
 *
 * Pure Application — no framework/Drizzle/Resend imports (Constitution
 * Principle III). Only Domain types + port interfaces + `@/lib/*` utilities.
 *
 * ClockPort: `graceCutoff = clock.now() - graceMs`. Injected for deterministic
 * unit testing; production cron passes a `SystemClock`.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import { asBroadcastId, type BroadcastId } from '../../domain/broadcast';

import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReclaimOrphanedAudiencesDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly broadcastsGateway: BroadcastsGatewayPort;
  readonly clock: ClockPort;
}

export interface ReclaimOrphanedAudiencesInput {
  /**
   * Grace window in milliseconds. Audiences whose `createdAt` is MORE RECENT
   * than `clock.now() - graceMs` are not yet candidates — they may belong to
   * an in-flight dispatch that hasn't committed its broadcast row yet.
   * Recommended production value: 24 hours (86_400_000 ms).
   * Must be positive (graceMs > 0).
   */
  readonly graceMs: number;
  /**
   * Maximum number of candidates to process per invocation. Applied AFTER
   * name-matching and grace filtering, BEFORE the DB existence check.
   * Keeps per-tick Resend delete throughput bounded. Production value: 200.
   * Must be positive (limit > 0).
   */
  readonly limit: number;
}

export interface ReclaimOrphanedAudiencesOutput {
  /** Total Resend audiences returned by `listAudiences`. */
  readonly scanned: number;
  /** Candidates confirmed to have no DB row (after grace + name filter). */
  readonly orphaned: number;
  /** Orphaned audiences successfully deleted via `deleteAudience`. */
  readonly deleted: number;
  /** Orphans whose delete threw a non-benign error (left for next tick). */
  readonly failed: number;
  /**
   * Orphans skipped because Resend refused to delete the account's last
   * audience (403 "Cannot delete last audience"). These will become eligible
   * once a new audience is created by the next broadcast dispatch.
   * Invariant: `orphaned === deleted + failed + skippedLastAudience`.
   */
  readonly skippedLastAudience: number;
  /**
   * Audiences whose name did not match the tenant's naming convention
   * (`General`, other-tenant audiences, malformed names). NOT counted when
   * a name matches but the audience is within the grace window.
   */
  readonly skippedNonMatching: number;
}

export type ReclaimOrphanedAudiencesError = {
  readonly kind: 'reclaim.server_error';
  readonly message: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape regex metacharacters in a string. Tenant slugs are `[a-z0-9-]` so
 * the risk is low (only `-` is a metaChar in a character class, but we use
 * it outside one here), but escaping is unconditional for safety.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Truncate an unknown thrown value to a safe log message (≤500 chars).
 * Used in catch blocks to build `reclaim.server_error` results.
 */
function toSafeMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : 'unknown error';
  return msg.length > 500 ? msg.slice(0, 500) + '…' : msg;
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

const RECLAIM_CONCURRENCY = 5;

/** Resend 403 error message for the account's last audience. */
const LAST_AUDIENCE_PATTERN = /cannot delete last audience/i;

export async function reclaimOrphanedAudiences(
  deps: ReclaimOrphanedAudiencesDeps,
  input: ReclaimOrphanedAudiencesInput,
): Promise<Result<ReclaimOrphanedAudiencesOutput, ReclaimOrphanedAudiencesError>> {
  // -------------------------------------------------------------------------
  // Step 1: List all Resend audiences for this API key.
  // -------------------------------------------------------------------------
  let audiences: Awaited<ReturnType<BroadcastsGatewayPort['listAudiences']>>;
  try {
    audiences = await deps.broadcastsGateway.listAudiences();
  } catch (e) {
    return err({ kind: 'reclaim.server_error', message: toSafeMessage(e) });
  }

  const scanned = audiences.length;

  // -------------------------------------------------------------------------
  // Step 2: Derive grace cutoff from the injected clock (deterministic).
  // -------------------------------------------------------------------------
  const graceCutoff = new Date(deps.clock.now().getTime() - input.graceMs);

  // -------------------------------------------------------------------------
  // Step 3: Name-match → grace-filter → cap at limit.
  //
  // Convention: `broadcast-{tenantSlug}-{uuid}` with optional `-batch-N` suffix.
  // The UUID capture group is strict: exactly `[0-9a-f]{8}-...-[0-9a-f]{12}`
  // (lowercase hex segments, standard UUID layout).
  // -------------------------------------------------------------------------
  const namePattern = new RegExp(
    `^broadcast-${escapeRegex(deps.tenant.slug)}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-batch-\\d+)?$`,
    'i',
  );

  let skippedNonMatching = 0;
  const candidates: Array<{ audienceId: string; broadcastId: BroadcastId }> = [];

  for (const audience of audiences) {
    // Run name-match first (single exec per audience — cap check comes after
    // so we avoid a second exec in the already-capped branch).
    const match = namePattern.exec(audience.name);
    if (match === null) {
      // Does not match the tenant naming convention (e.g. `General`, or an
      // audience belonging to a different tenant sharing the same Resend key).
      skippedNonMatching++;
      continue;
    }

    // Name matched. If the per-tick cap is already reached, drop silently.
    // Matched-but-capped audiences are NOT counted as skippedNonMatching
    // (skippedNonMatching is reserved for name-mismatches only).
    if (candidates.length >= input.limit) continue;

    const capturedBroadcastId = asBroadcastId(match[1]!);

    // `createdAt` is a Date parsed at the gateway boundary. An invalid API
    // date yields an Invalid Date whose `getTime()` returns NaN. NaN
    // comparisons are always false, so the audience is treated as NOT-fresh
    // (eligible for the grace filter). This is the safe choice: an audience
    // with an unreadable timestamp is more likely to be old than brand-new,
    // and the DB existence check below still gates deletion (we only delete
    // if the broadcast row is absent).
    const createdAtMs = audience.createdAt.getTime();
    const isFreshEnoughToSkip = !Number.isNaN(createdAtMs) && createdAtMs > graceCutoff.getTime();
    if (isFreshEnoughToSkip) {
      // Matched the pattern but is within the grace window.
      // Do NOT count as skippedNonMatching.
      continue;
    }

    candidates.push({ audienceId: audience.id, broadcastId: capturedBroadcastId });
  }

  // -------------------------------------------------------------------------
  // Step 4: Check which extracted broadcast IDs still exist in the DB.
  // -------------------------------------------------------------------------
  if (candidates.length === 0) {
    return ok({ scanned, orphaned: 0, deleted: 0, failed: 0, skippedLastAudience: 0, skippedNonMatching });
  }

  const uniqueIds: ReadonlyArray<BroadcastId> = [...new Set(candidates.map((c) => c.broadcastId))];

  let orphans: Array<{ audienceId: string; broadcastId: BroadcastId }>;
  if (deps.broadcastsRepo.referencedAudienceIdsForBroadcasts) {
    // Bug #16 fix (2026-07-10, revised after code-review): an audience is
    // orphaned when EITHER (a) its broadcast row is GONE, OR (b) the row exists
    // but references this audience NOWHERE — not in broadcasts.resend_audience_id
    // AND not in any of the broadcast's batch_manifests.provider_audience_id.
    // The old row-existence-only check kept the crash-before-attach orphan
    // forever (row survived with a NULL/stale audience ref while the next tick
    // minted + persisted a new audience). CRITICAL: the referenced set MUST
    // include the per-batch (F7.1a US1 split) audiences — on the split path
    // broadcasts.resend_audience_id stays NULL and the real audience ids live
    // only in the manifests, so comparing against a single id would delete a
    // live split broadcast's in-use batch audiences. The grace window still
    // protects any freshly-created (in-flight) audience.
    let referencedByBroadcast: ReadonlyMap<BroadcastId, ReadonlySet<string>>;
    try {
      referencedByBroadcast =
        await deps.broadcastsRepo.referencedAudienceIdsForBroadcasts(
          deps.tenant.slug,
          uniqueIds,
        );
    } catch (e) {
      return err({ kind: 'reclaim.server_error', message: toSafeMessage(e) });
    }
    orphans = candidates.filter((c) => {
      const referenced = referencedByBroadcast.get(c.broadcastId);
      if (referenced === undefined) return true; // broadcast row is gone
      return !referenced.has(c.audienceId); // row references this audience nowhere
    });
  } else {
    // Legacy fallback (row-existence only) — misses the crash-before-attach
    // orphans above. Retained for BroadcastsRepo fixtures that don't stub the
    // new method; production always wires it.
    let existing: ReadonlySet<BroadcastId>;
    try {
      existing = await deps.broadcastsRepo.existingBroadcastIds(deps.tenant.slug, uniqueIds);
    } catch (e) {
      return err({ kind: 'reclaim.server_error', message: toSafeMessage(e) });
    }
    orphans = candidates.filter((c) => !existing.has(c.broadcastId));
  }
  const orphaned = orphans.length;

  // -------------------------------------------------------------------------
  // Step 5: Delete orphaned audiences in chunks of RECLAIM_CONCURRENCY via
  // Promise.allSettled. Per-item try/catch ensures one failure does NOT abort
  // the batch (project memory: `mock-only-tests-miss-throw-paths`).
  // -------------------------------------------------------------------------
  let deleted = 0;
  let failed = 0;
  let skippedLastAudience = 0;

  async function handleOne(orphan: { audienceId: string; broadcastId: BroadcastId }): Promise<void> {
    try {
      await deps.broadcastsGateway.deleteAudience(orphan.audienceId);
      deleted++;
    } catch (e) {
      // "Cannot delete last audience" — Resend 403 validation meaning this
      // audience is the account's sole audience and Resend forbids removing it.
      // Treat as a benign skip: NOT a failure (don't increment `failed`), NOT
      // deleted. The audience will become eligible once another audience is
      // created by the next broadcast dispatch.
      if (e instanceof Error && LAST_AUDIENCE_PATTERN.test(e.message)) {
        skippedLastAudience++;
        logger.info(
          { audienceId: orphan.audienceId },
          'broadcasts.audience_reclaim.skip_last_audience',
        );
        return;
      }

      failed++;
      logger.warn(
        {
          audienceId: orphan.audienceId,
          broadcastId: orphan.broadcastId,
          cause: e instanceof Error ? e.message : 'unknown error',
        },
        'broadcasts.audience_reclaim.delete_failed',
      );
    }
  }

  for (let i = 0; i < orphans.length; i += RECLAIM_CONCURRENCY) {
    const chunk = orphans.slice(i, i + RECLAIM_CONCURRENCY);
    await Promise.allSettled(chunk.map(handleOne));
  }

  return ok({ scanned, orphaned, deleted, failed, skippedLastAudience, skippedNonMatching });
}
