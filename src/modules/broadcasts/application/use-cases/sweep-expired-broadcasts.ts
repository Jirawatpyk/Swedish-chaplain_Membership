/**
 * F7 retention sweep (migration 0310) — `sweepExpiredBroadcasts`.
 *
 * The RoPA declares 5 years for `broadcasts` and everything that hangs off it
 * (deliveries, versions, decisions, batch manifests); before this use case
 * nothing deleted a closed E-Blast on age, so the declaration was a
 * classification rather than an enforced retention. The daily cron
 * (`/api/cron/broadcasts/retention-sweep`) calls this once per tenant.
 *
 * ONE BATCH = THREE PHASES (the `cleanup-orphaned-audiences` shape: no network
 * call inside a transaction that holds locks):
 *
 *   1. READ up to `batchSize` expired rows, oldest anchor first, WITHOUT a lock
 *      (`listExpiredForRetention`), each with every Resend broadcast id it owns
 *      — its own `resend_broadcast_id` and any per-batch manifest copy.
 *   2. DELETE THE RESEND COPIES, outside any transaction. The Resend object
 *      holds the E-Blast's HTML body and a name that identifies the member and
 *      the tenant; dropping our row first would leave it unreachable from our
 *      side for ever, so the delete is attempted first. Per copy:
 *        - resolved (deleted, or 404 / 410 — the adapter resolves "already
 *          gone") → gone;
 *        - `permanent` (a 4xx refusal — Resend documents that a queued or sent
 *          broadcast cannot be deleted) → the copy is RETAINED AT THE
 *          PROCESSOR, under Resend's own retention and the Resend DPA; our row
 *          is DELETED ANYWAY (maintainer decision, 2026-09-25) and the copy is
 *          counted `provider_copy_retained_at_processor`;
 *        - `retryable` (5xx, 429, network) — or a throw that is not a
 *          classified gateway error at all (a fault, not an answer from
 *          Resend) → the row is KEPT, the key with it, and a later run retries;
 *          counted `provider_copy_kept_transient`.
 *      A row goes when none of its copies was kept. Every copy left at Resend
 *      is logged with the error class and provider code only — never an id or
 *      the provider's free text. A row with no Resend id skips this phase.
 *   3. DELETE THE CONFIRMED ROWS in one transaction
 *      (`deleteExpiredForRetention`), which re-checks eligibility under
 *      `FOR UPDATE SKIP LOCKED` and starts with `SET LOCAL lock_timeout`, and
 *      stamp their `broadcast_images` in the same transaction — a delete never
 *      commits without its stamp, nor a stamp without its delete.
 *
 * NOT MEASURED: Resend's `DELETE /broadcasts/{id}` has been exercised only on a
 * DRAFT (2026-09-10). Resend's documentation says a broadcast that has been
 * queued or sent cannot be deleted, so an expired `sent` /
 * `partial_delivery_accepted` row is expected to take the `permanent` arm: our
 * row goes, Resend's copy stays under Resend's retention (a disclosed RoPA
 * residual). What status Resend actually answers — and so whether it lands in
 * `permanent` rather than `retryable` — is to be measured with a throwaway send
 * before the first E-Blast crosses its retention (2031); the cron runbook
 * (§ F7 retention-sweep, "Resend copies") carries the item.
 *
 * The loop runs until a short read or `timeBudgetMs`, checked between batches
 * and before every chunk of Resend calls (a Resend outage can hold one call
 * for ~31 s of retries); a tick that stops early is not a failure — the rest
 * go tomorrow. A kept row is not read again in the same run: each read starts
 * after the previous read's last row.
 *
 * THE RUN ROW. Exactly one `broadcast_retention_swept` per run, COUNTS ONLY
 * (plus the oldest / newest anchor of the rows deleted, so an auditor can see
 * nothing younger than the period went), written in its own transaction after
 * the loop — also when nothing expired, because that row is the evidence the
 * retention is being enforced, and also when a batch threw (`completed: false`,
 * with the count that DID commit).
 *
 * Pure Application — only Domain types + ports (+ the shared logger, as
 * `cleanup-orphaned-audiences`).
 */
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastsRepo, RetentionCandidate, RetentionCursor } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';
import { markBroadcastBatchImagesRemoved } from './_mark-owner-images-removed';
import { classifyThrown } from './_classify-thrown';

export interface SweepExpiredBroadcastsDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<
    BroadcastsRepo,
    'withTx' | 'listExpiredForRetention' | 'deleteExpiredForRetention'
  >;
  /** Deletes the Resend copy of an expired E-Blast before its row goes. */
  readonly broadcastsGateway: Pick<BroadcastsGatewayPort, 'deleteBroadcast'>;
  readonly imagesRepo: Pick<BroadcastImagesRepo, 'markDeletedByOwners'>;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /** Correlates the audit rows with this cron tick. */
  readonly requestId: string;
  /** Rows per read, and so at most per delete transaction. Defaults to 200. */
  readonly batchSize?: number;
  /** Wall-clock ceiling for the tenant's run. Defaults to 60 s. */
  readonly timeBudgetMs?: number;
}

export interface SweepExpiredBroadcastsOutput {
  readonly sweptCount: number;
  readonly imagesMarked: number;
  /** Candidate reads that returned (the last one may be empty or short). */
  readonly batches: number;
  /** True when the run stopped on the time budget, i.e. expired rows may remain for tomorrow. */
  readonly budgetExhausted: boolean;
  /** Rows KEPT because deleting a Resend copy failed transiently (retried next run). */
  readonly providerCopyKeptTransient: number;
  /**
   * Rows DELETED although Resend refused to delete a copy (`permanent` — a sent
   * broadcast cannot be deleted): the copy stays under Resend's own retention.
   */
  readonly providerCopyRetainedAtProcessor: number;
  /** The oldest / newest retention anchor among the rows deleted; `null` when none. */
  readonly oldestAnchor: Date | null;
  readonly newestAnchor: Date | null;
}

export interface SweepExpiredBroadcastsError {
  readonly kind: 'retention_sweep.server_error';
  /**
   * What was thrown. Deliberately no `message`: a Drizzle query error's
   * message quotes the statement's parameters, which can include a
   * `related_member_id`. Log `errKind(rootCause(error))` + the SQLSTATE.
   */
  readonly cause: unknown;
  /** Rows that DID commit before the failure (they stay deleted). */
  readonly sweptCount: number;
}

type ProviderOutcome = 'gone' | 'retained_at_processor' | 'transient';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIME_BUDGET_MS = 60_000;
/**
 * Resend deletes in flight at once — the `cleanup-orphaned-audiences`
 * precedent. The account limit is 10 req/s; a 429 is `retryable` and backs off
 * inside the adapter, so an overshoot costs time, never a row.
 */
const PROVIDER_CONCURRENCY = 5;

export async function sweepExpiredBroadcasts(
  deps: SweepExpiredBroadcastsDeps,
): Promise<Result<SweepExpiredBroadcastsOutput, SweepExpiredBroadcastsError>> {
  const now = deps.clock.now();
  const startedAtMs = now.getTime();
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const timeBudgetMs = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const slug = deps.tenant.slug;
  const overBudget = (): boolean => deps.clock.now().getTime() - startedAtMs >= timeBudgetMs;

  let sweptCount = 0;
  let imagesMarked = 0;
  let batches = 0;
  let budgetExhausted = false;
  let keptTransient = 0;
  let retainedAtProcessor = 0;
  let oldestAnchor: Date | null = null;
  let newestAnchor: Date | null = null;
  let after: RetentionCursor | null = null;
  let failure: { readonly cause: unknown } | null = null;

  async function deleteProviderCopies(candidate: RetentionCandidate): Promise<ProviderOutcome> {
    let retained = false;
    for (const resendId of candidate.resendBroadcastIds) {
      try {
        await deps.broadcastsGateway.deleteBroadcast(resendId);
      } catch (e) {
        const shape = classifyThrown(e);
        // Only Resend's own refusal lets the row go without its copy; a
        // retryable error or an unclassified throw keeps the row and its key.
        const outcome: ProviderOutcome =
          shape.kind === 'permanent' ? 'retained_at_processor' : 'transient';
        logger.warn(
          {
            tenantId: slug,
            outcome,
            errorKind: shape.kind,
            ...(shape.subKind !== undefined ? { subKind: shape.subKind } : {}),
            ...(shape.code !== undefined ? { code: shape.code } : {}),
          },
          'broadcasts.retention_sweep.provider_copy_kept',
        );
        if (outcome === 'transient') return 'transient';
        // Keep going: the row's other copies can still be deleted.
        retained = true;
      }
    }
    return retained ? 'retained_at_processor' : 'gone';
  }

  try {
    for (;;) {
      const candidates = await deps.broadcastsRepo.listExpiredForRetention(slug, now, batchSize, after);
      batches += 1;
      const last = candidates.at(-1);
      if (last !== undefined) after = { anchorKey: last.anchorKey, broadcastId: last.broadcastId };

      // Phase 2 — outside any transaction. A row with no Resend copy is gone
      // at the provider already.
      const gone = new Set(candidates.filter((c) => c.resendBroadcastIds.length === 0).map((c) => c.broadcastId));
      const withCopies = candidates.filter((c) => c.resendBroadcastIds.length > 0);
      for (let i = 0; i < withCopies.length; i += PROVIDER_CONCURRENCY) {
        if (overBudget()) {
          budgetExhausted = true;
          break;
        }
        const chunk = withCopies.slice(i, i + PROVIDER_CONCURRENCY);
        const outcomes = await Promise.all(chunk.map(deleteProviderCopies));
        outcomes.forEach((outcome, n) => {
          if (outcome === 'transient') {
            keptTransient += 1;
            return;
          }
          if (outcome === 'retained_at_processor') retainedAtProcessor += 1;
          gone.add(chunk[n]!.broadcastId);
        });
      }
      // In read order (oldest anchor first), so the delete is deterministic.
      const confirmed = candidates.filter((c) => gone.has(c.broadcastId)).map((c) => c.broadcastId);

      // Phase 3 — the confirmed rows, one transaction.
      if (confirmed.length > 0) {
        const batch = await deps.broadcastsRepo.withTx(async (tx) => {
          const page = await deps.broadcastsRepo.deleteExpiredForRetention(slug, now, confirmed, tx);
          const marked = await markBroadcastBatchImagesRemoved(
            deps,
            { tenantId: slug, reason: 'retention_expired', at: now, requestId: deps.requestId, owners: page.swept },
            tx,
          );
          return { swept: page.swept, marked };
        });
        sweptCount += batch.swept.length;
        imagesMarked += batch.marked;
        for (const { anchor } of batch.swept) {
          if (oldestAnchor === null || anchor < oldestAnchor) oldestAnchor = anchor;
          if (newestAnchor === null || anchor > newestAnchor) newestAnchor = anchor;
        }
      }

      if (budgetExhausted || candidates.length < batchSize) break;
      if (overBudget()) {
        budgetExhausted = true;
        break;
      }
    }
  } catch (e) {
    failure = { cause: e };
  }

  const oldest: Date | null = oldestAnchor;
  const newest: Date | null = newestAnchor;
  try {
    await deps.broadcastsRepo.withTx(async (tx) =>
      deps.audit.emitTyped(tx, {
        eventType: 'broadcast_retention_swept',
        tenantId: slug,
        requestId: deps.requestId,
        actorUserId: 'system',
        summary: `E-Blast retention sweep: ${sweptCount} expired E-Blast(s) deleted`,
        payload: {
          swept_count: sweptCount,
          images_marked: imagesMarked,
          batches,
          budget_exhausted: budgetExhausted,
          completed: failure === null,
          provider_copy_kept_transient: keptTransient,
          provider_copy_retained_at_processor: retainedAtProcessor,
          oldest_anchor: oldest === null ? null : oldest.toISOString(),
          newest_anchor: newest === null ? null : newest.toISOString(),
          actor_role: 'system',
        },
      }),
    );
  } catch (e) {
    failure ??= { cause: e };
  }

  if (failure !== null) {
    return err({ kind: 'retention_sweep.server_error', cause: failure.cause, sweptCount });
  }
  return ok({
    sweptCount,
    imagesMarked,
    batches,
    budgetExhausted,
    providerCopyKeptTransient: keptTransient,
    providerCopyRetainedAtProcessor: retainedAtProcessor,
    oldestAnchor: oldest,
    newestAnchor: newest,
  });
}
