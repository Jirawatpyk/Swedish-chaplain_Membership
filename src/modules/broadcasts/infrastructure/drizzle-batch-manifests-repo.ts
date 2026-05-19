/**
 * T029/B3 (F7.1a US1) — Drizzle `BatchManifestsPort` adapter.
 *
 * Real implementation. Each method runs inside `runInTenant(ctx, tx
 * => …)` so Postgres RLS+FORCE (migration 0166) confines visibility
 * to the matching tenant_id slice. The composite FK to broadcasts
 * (migration 0163) cascades on broadcast deletion → no orphan rows.
 *
 * IMPORTANT — advisory-lock contract (data-model § 4):
 * `pg_advisory_xact_lock('broadcasts-batch:' || tenantId || ':' ||
 * broadcastId || ':' || batchIndex)` is acquired by the USE CASE
 * (Phase 3 T045 `dispatchBroadcastBatch`), NOT by this adapter — the
 * tx that holds the lock IS the use case's tx, not a fresh one
 * created here.
 *
 * Bulk-insert collision mapping (per port docs):
 *   - Unique violation on `idempotency_key_uniq` → `duplicate_idempotency_key`
 *   - Unique violation on `tenant_broadcast_batch_uniq` → `duplicate_batch_index`
 *   - Other Postgres error → `storage_error` with chain-message detail
 *
 * Not in barrel — Infrastructure adapter. Composition root wires
 * inline at Phase 3 (cron handler T055 + admin retry route T050).
 */

import { eq, and, inArray, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { errorChainMessage, isUniqueViolation } from '@/lib/db-errors';
import { asTenantContext, type TenantSlug } from '@/modules/tenants';
import type { BroadcastId } from '../domain/broadcast';
import { asBroadcastId } from '../domain/broadcast';
import type {
  BatchInsertError,
  BatchManifest,
  BatchManifestsPort,
  BatchStatus,
  BatchStatusUpdate,
  BatchUpdateError,
  NewBatchManifestInput,
} from '../application/ports/batch-manifests-port';
import {
  broadcastBatchManifests,
  type BroadcastBatchManifestRow,
} from './schema';

/**
 * Postgres unique-index constraint names. The string-equals check
 * surfaces in the chain-message because `postgres-js` puts the
 * constraint name inside the error message (e.g. "duplicate key value
 * violates unique constraint "broadcast_batch_manifests_idempotency_key_uniq"").
 */
const IDEMPOTENCY_KEY_INDEX =
  'broadcast_batch_manifests_idempotency_key_uniq';
const TENANT_BROADCAST_BATCH_INDEX =
  'broadcast_batch_manifests_tenant_broadcast_batch_uniq';

function rowToManifest(row: BroadcastBatchManifestRow): BatchManifest {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantSlug,
    broadcastId: asBroadcastId(row.broadcastId),
    batchIndex: row.batchIndex,
    recipientCount: row.recipientCount,
    recipientRangeStart: row.recipientRangeStart,
    recipientRangeEnd: row.recipientRangeEnd,
    status: row.status as BatchStatus,
    providerAudienceId: row.providerAudienceId,
    idempotencyKey: row.idempotencyKey,
    retryCount: row.retryCount,
    deliveredCount: row.deliveredCount,
    bouncedCount: row.bouncedCount,
    complainedCount: row.complainedCount,
    unsubscribedCount: row.unsubscribedCount,
    dispatchedAt: row.dispatchedAt,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function classifyInsertError(error: unknown): BatchInsertError {
  if (isUniqueViolation(error)) {
    const message = errorChainMessage(error);
    if (message.includes(IDEMPOTENCY_KEY_INDEX)) {
      return { kind: 'duplicate_idempotency_key' };
    }
    if (message.includes(TENANT_BROADCAST_BATCH_INDEX)) {
      return { kind: 'duplicate_batch_index' };
    }
    return {
      kind: 'storage_error',
      detail: `unexpected unique violation: ${message}`,
    };
  }
  return {
    kind: 'storage_error',
    detail: errorChainMessage(error),
  };
}

/**
 * State machine — mirrors the DB CHECK constraint from migration 0163
 * (pending → sending → sent | failed; pending → cancelled). Adapter
 * enforces here too so the application Domain transitions cleanly
 * before the SQL fires (port returns `invalid_state_transition`
 * without round-tripping through the DB).
 */
const ALLOWED_TRANSITIONS: Record<BatchStatus, readonly BatchStatus[]> = {
  pending: ['sending', 'cancelled'],
  sending: ['sent', 'failed'],
  sent: [],
  failed: ['pending'], // retryFailedBatches re-queues failed → pending
  cancelled: [],
};

export function makeDrizzleBatchManifestsRepo(
  tenantId: string,
): BatchManifestsPort {
  const ctx = asTenantContext(tenantId);

  return {
    async findByBroadcast(
      _tenantId: TenantSlug,
      broadcastId: BroadcastId,
    ): Promise<readonly BatchManifest[]> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(broadcastBatchManifests)
          .where(
            and(
              eq(broadcastBatchManifests.tenantId, ctx.slug),
              eq(broadcastBatchManifests.broadcastId, broadcastId),
            ),
          )
          .orderBy(broadcastBatchManifests.batchIndex);
        return rows.map(rowToManifest);
      });
    },

    async findPendingByBroadcast(
      _tenantId: TenantSlug,
      broadcastId: BroadcastId,
    ): Promise<readonly BatchManifest[]> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(broadcastBatchManifests)
          .where(
            and(
              eq(broadcastBatchManifests.tenantId, ctx.slug),
              eq(broadcastBatchManifests.broadcastId, broadcastId),
              eq(broadcastBatchManifests.status, 'pending'),
            ),
          )
          .orderBy(broadcastBatchManifests.batchIndex);
        return rows.map(rowToManifest);
      });
    },

    async bulkInsert(
      _tenantId: TenantSlug,
      inputs: readonly NewBatchManifestInput[],
    ): Promise<Result<readonly BatchManifest[], BatchInsertError>> {
      if (inputs.length === 0) return ok([]);

      // Defensive caller-bug check — port docs allow `recipient_count >
      // 10000` to bubble as `invalid_recipient_range` but the DB CHECK
      // would also reject. Surface the typed error here so the use case
      // doesn't have to interpret a `storage_error` to find this.
      for (const input of inputs) {
        if (input.recipientCount > 10_000) {
          return err({
            kind: 'invalid_recipient_range',
            detail: `recipientCount ${input.recipientCount} exceeds Resend per-audience cap (10000) for batch ${input.batchIndex}`,
          });
        }
        if (input.recipientRangeEnd < input.recipientRangeStart) {
          return err({
            kind: 'invalid_recipient_range',
            detail: `range end ${input.recipientRangeEnd} < start ${input.recipientRangeStart} for batch ${input.batchIndex}`,
          });
        }
      }

      try {
        return await runInTenant(ctx, async (tx) => {
          const inserted = await tx
            .insert(broadcastBatchManifests)
            .values(
              inputs.map((input) => ({
                tenantId: ctx.slug,
                broadcastId: input.broadcastId as unknown as string,
                batchIndex: input.batchIndex,
                recipientCount: input.recipientCount,
                recipientRangeStart: input.recipientRangeStart,
                recipientRangeEnd: input.recipientRangeEnd,
                idempotencyKey: input.idempotencyKey,
                status: 'pending' as const,
              })),
            )
            .returning();
          return ok(inserted.map(rowToManifest));
        });
      } catch (e) {
        return err(classifyInsertError(e));
      }
    },

    async updateStatus(
      _tenantId: TenantSlug,
      batchManifestId: string,
      update: BatchStatusUpdate,
    ): Promise<Result<BatchManifest, BatchUpdateError>> {
      return runInTenant(ctx, async (tx) => {
        // Read the current row (RLS scopes by tenant_id automatically)
        const [current] = await tx
          .select()
          .from(broadcastBatchManifests)
          .where(
            and(
              eq(broadcastBatchManifests.id, batchManifestId),
              eq(broadcastBatchManifests.tenantId, ctx.slug),
            ),
          )
          .limit(1);

        if (current === undefined) {
          return err({ kind: 'not_found' });
        }

        const fromStatus = current.status as BatchStatus;
        const toStatus = update.status;

        if (fromStatus !== toStatus) {
          const allowed = ALLOWED_TRANSITIONS[fromStatus];
          if (!allowed.includes(toStatus)) {
            return err({
              kind: 'invalid_state_transition',
              from: fromStatus,
              to: toStatus,
            });
          }
        }

        const patch: Partial<typeof broadcastBatchManifests.$inferInsert> = {
          status: toStatus,
          updatedAt: new Date(),
        };
        if (update.providerAudienceId !== undefined) {
          patch.providerAudienceId = update.providerAudienceId;
        }
        if (update.dispatchedAt !== undefined) {
          patch.dispatchedAt = update.dispatchedAt;
        }
        if (update.failedAt !== undefined) {
          patch.failedAt = update.failedAt;
        }
        if (update.failureReason !== undefined) {
          patch.failureReason = update.failureReason;
        }
        if (update.retryCount !== undefined) {
          patch.retryCount = update.retryCount;
        }

        try {
          const [updated] = await tx
            .update(broadcastBatchManifests)
            .set(patch)
            .where(
              and(
                eq(broadcastBatchManifests.id, batchManifestId),
                eq(broadcastBatchManifests.tenantId, ctx.slug),
                // Defensive: ensure status hasn't drifted since the read
                eq(broadcastBatchManifests.status, fromStatus),
              ),
            )
            .returning();

          if (updated === undefined) {
            // Concurrent update raced — re-read to surface accurate state
            return err({
              kind: 'invalid_state_transition',
              from: fromStatus,
              to: toStatus,
            });
          }

          return ok(rowToManifest(updated));
        } catch (e) {
          return err({ kind: 'storage_error', detail: errorChainMessage(e) });
        }
      });
    },

    async markCancelled(
      _tenantId: TenantSlug,
      batchManifestIds: readonly string[],
    ): Promise<number> {
      if (batchManifestIds.length === 0) return 0;

      return runInTenant(ctx, async (tx) => {
        const updated = await tx
          .update(broadcastBatchManifests)
          .set({
            status: 'cancelled',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(broadcastBatchManifests.tenantId, ctx.slug),
              inArray(
                broadcastBatchManifests.id,
                batchManifestIds as readonly string[],
              ),
              // Only flip pending → cancelled; ignores rows already in
              // terminal states or already in flight (sending/sent/failed).
              eq(broadcastBatchManifests.status, 'pending'),
            ),
          )
          .returning({ id: broadcastBatchManifests.id });
        return updated.length;
      });
    },
  };
}

/**
 * Acquire the per-batch advisory lock for `dispatchBroadcastBatch`
 * (Phase 3 T045). Caller MUST be inside an active tx; this returns
 * the lock-acquire result without releasing (auto-release at commit).
 *
 * Exported as a standalone helper since the use case owns the tx
 * boundary, not the adapter — matches F4 invoicing `acquireSeqLock`
 * + F5 payments TOCTOU-lock patterns.
 */
export async function acquirePerBatchDispatchLock(
  tx: unknown,
  tenantSlug: string,
  broadcastId: BroadcastId,
  batchIndex: number,
): Promise<boolean> {
  const lockKey = `broadcasts-batch:${tenantSlug}:${broadcastId}:${batchIndex}`;
  const result = (await (tx as { execute: (q: unknown) => unknown }).execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired`,
  )) as unknown as Array<{ acquired: boolean }>;
  return result[0]?.acquired ?? false;
}
