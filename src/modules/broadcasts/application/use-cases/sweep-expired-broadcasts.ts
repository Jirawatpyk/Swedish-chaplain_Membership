/**
 * F7 retention sweep (migration 0310) — `sweepExpiredBroadcasts`.
 *
 * The RoPA declares 5 years for `broadcasts` and everything that hangs off it
 * (deliveries, versions, decisions, batch manifests); before this use case
 * nothing deleted a closed E-Blast on age, so the declaration was a
 * classification rather than an enforced retention. The daily cron
 * (`/api/cron/broadcasts/retention-sweep`) calls this once per tenant.
 *
 * ONE BATCH = ONE TRANSACTION. Each batch deletes at most `batchSize` expired
 * rows (oldest anchor first) and stamps their `broadcast_images` in the same
 * transaction, so a delete never commits without its stamp (the bytes would be
 * unreachable at a public URL) and a stamp never commits without its delete.
 * The loop runs until a short batch or `timeBudgetMs`, checked BETWEEN
 * batches; a tick that stops early is not a failure — the rest go tomorrow.
 * Same shape as `pruneExpiredDrafts` (ROUND-2 R-M1).
 *
 * ORDER inside a batch: the repository DELETEs (RETURNING the ids), then the
 * images are stamped from those ids. The images carry no FK, so the order
 * within the one transaction is immaterial; the ids are simply not known
 * before the DELETE picks them.
 *
 * THE RUN ROW. Exactly one `broadcast_retention_swept` per run, COUNTS ONLY,
 * written in its own transaction after the loop — also when nothing expired,
 * because that row is the evidence the retention is being enforced, and also
 * when a batch threw (`completed: false`, with the count that DID commit).
 *
 * Pure Application — only Domain types + ports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';
import { markBroadcastBatchImagesRemoved } from './_mark-owner-images-removed';

export interface SweepExpiredBroadcastsDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx' | 'deleteExpiredForRetention'>;
  readonly imagesRepo: Pick<BroadcastImagesRepo, 'markDeletedByOwners'>;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /** Correlates the audit rows with this cron tick. */
  readonly requestId: string;
  /** Rows per DELETE, and so per transaction. Defaults to 200. */
  readonly batchSize?: number;
  /** Wall-clock ceiling for the tenant's run, checked between batches. Defaults to 60 s. */
  readonly timeBudgetMs?: number;
}

export interface SweepExpiredBroadcastsOutput {
  readonly sweptCount: number;
  readonly imagesMarked: number;
  readonly batches: number;
  /** True when the loop stopped on the time budget, i.e. expired rows remain for tomorrow. */
  readonly budgetExhausted: boolean;
}

export interface SweepExpiredBroadcastsError {
  readonly kind: 'retention_sweep.server_error';
  /** Truncated to 500 chars — a constraint message can quote row data. */
  readonly message: string;
  /** Rows that DID commit before the failure (they stay deleted). */
  readonly sweptCount: number;
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIME_BUDGET_MS = 60_000;
const MAX_MESSAGE_LENGTH = 500;

export async function sweepExpiredBroadcasts(
  deps: SweepExpiredBroadcastsDeps,
): Promise<Result<SweepExpiredBroadcastsOutput, SweepExpiredBroadcastsError>> {
  const now = deps.clock.now();
  const startedAtMs = now.getTime();
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const timeBudgetMs = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const slug = deps.tenant.slug;

  let sweptCount = 0;
  let imagesMarked = 0;
  let batches = 0;
  let budgetExhausted = false;
  let failure: string | null = null;

  try {
    for (;;) {
      const batch = await deps.broadcastsRepo.withTx(async (tx) => {
        const page = await deps.broadcastsRepo.deleteExpiredForRetention(slug, now, batchSize, tx);
        const marked = await markBroadcastBatchImagesRemoved(
          deps,
          { tenantId: slug, reason: 'retention_expired', at: now, requestId: deps.requestId, owners: page.swept },
          tx,
        );
        return { swept: page.swept.length, marked };
      });

      sweptCount += batch.swept;
      imagesMarked += batch.marked;
      batches += 1;

      if (batch.swept < batchSize) break;
      if (deps.clock.now().getTime() - startedAtMs >= timeBudgetMs) {
        budgetExhausted = true;
        break;
      }
    }
  } catch (e) {
    failure = safeMessage(e);
  }

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
          actor_role: 'system',
        },
      }),
    );
  } catch (e) {
    failure ??= safeMessage(e);
  }

  if (failure !== null) {
    return err({ kind: 'retention_sweep.server_error', message: failure, sweptCount });
  }
  return ok({ sweptCount, imagesMarked, batches, budgetExhausted });
}

function safeMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : 'unknown error';
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
}
