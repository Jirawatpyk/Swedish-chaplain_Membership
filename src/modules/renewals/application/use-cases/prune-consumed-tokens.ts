/**
 * F8 Phase 9 retrofit (PR #25) — `pruneConsumedTokens` use-case.
 *
 * Weekly housekeeping cron that deletes rows from `consumed_link_tokens`
 * older than the retention window (60 days per `data-model.md § 2.8` +
 * migration 0093 header comment).
 *
 * Context (why this exists post-ship):
 *   F8 Phase 9 (Observability + Operations) authored the runbook
 *   section + table row for `prune-consumed-tokens` but the route +
 *   use-case were never implemented. The doc-vs-code drift was caught
 *   during post-merge runbook audit (2026-05-11) — surfaced by a
 *   user-led "F8 cron count" query that compared the
 *   `docs/runbooks/cron-jobs.md` table (7 F8 rows) against the
 *   `src/app/api/cron/renewals/` directory listing (6 routes).
 *
 * Token replay-protection table is append-only by design (no UPDATE
 * GRANT, immutable rows). Without periodic pruning the table grows
 * unbounded — small impact at SweCham scale (~1,572 rows/year) but
 * compounds over multi-tenant + multi-year operation. The verifier
 * still rejects expired tokens via the `expires_at` payload check
 * regardless of whether the consumed row exists, so this is purely a
 * storage-hygiene cron (no security regression if it never runs).
 *
 * Pattern mirrors `reconcile-pending-applications` (single-route
 * weekly housekeeping; MVP single-tenant; advisory-lock-protected
 * inside the route handler).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';

/**
 * Retention window per `data-model.md § 2.8` and migration 0093 header
 * comment. Kept as a constant so a future tenant-overridable setting
 * (F8.1) can swap the value without touching the use-case signature.
 */
export const PRUNE_RETENTION_DAYS = 60;

export const pruneConsumedTokensInputSchema = z.object({
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  /**
   * Caller-supplied wall-clock for deterministic testability. Routes
   * pass `new Date()`; tests pass a frozen value to assert the
   * 60-day cutoff math.
   */
  now: z.date(),
});

export type PruneConsumedTokensInput = z.infer<
  typeof pruneConsumedTokensInputSchema
>;

export interface PruneConsumedTokensOutput {
  readonly pruned: number;
  readonly cutoffIso: string;
  readonly durationMs: number;
}

export type PruneConsumedTokensError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

export async function pruneConsumedTokens(
  deps: RenewalsDeps,
  rawInput: PruneConsumedTokensInput,
): Promise<Result<PruneConsumedTokensOutput, PruneConsumedTokensError>> {
  const inputResult = parseInput(pruneConsumedTokensInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const startedAt = Date.now();

  // Cutoff = now - 60 days. Computed in UTC; rows are stored
  // timestamptz so the comparison is timezone-correct.
  const cutoff = new Date(
    input.now.getTime() - PRUNE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  try {
    // The adapter (`drizzle-consumed-link-tokens-repo.ts:pruneOlderThan`)
    // wraps the DELETE in its own `runInTenant` block — tenant scope +
    // RLS+FORCE policy enforce isolation at the DB layer. The use-case
    // simply forwards the cutoff; no Application-layer runInTenant wrap
    // is needed (matches the F8 adapter convention used by
    // `reconcile-pending-applications`, `confirm-renewal`, etc.).
    const { pruned } = await deps.consumedLinkTokensRepo.pruneOlderThan(
      cutoff,
    );
    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        tenantId: input.tenantId,
        correlationId: input.correlationId,
        pruned,
        cutoffIso: cutoff.toISOString(),
        retentionDays: PRUNE_RETENTION_DAYS,
        durationMs,
      },
      'renewals.prune_consumed_tokens.complete',
    );
    return ok({
      pruned,
      cutoffIso: cutoff.toISOString(),
      durationMs,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(
      {
        err: e instanceof Error ? e : new Error(message),
        tenantId: input.tenantId,
        correlationId: input.correlationId,
      },
      'renewals.prune_consumed_tokens.failed',
    );
    return err({ kind: 'server_error', message });
  }
}
