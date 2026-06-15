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
import { db, runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { errorChainMessage, isUniqueViolation } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { asTenantContext, type TenantSlug } from '@/modules/tenants';
import type { BroadcastId } from '../domain/broadcast';
import { asBroadcastId } from '../domain/broadcast';
import { asIdempotencyKey } from '../domain/value-objects/idempotency-key';
import type {
  BatchCounterField,
  BatchCounterIncrementError,
  BatchInsertError,
  BatchManifest,
  BatchManifestsPort,
  BatchProviderLookup,
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
    providerBroadcastId: row.providerBroadcastId,
    // Phase 3F.11.15 — brand at the infra→domain boundary. The DB
    // stores plain text; this `asIdempotencyKey` cast is the documented
    // re-hydration escape from the brand barrier in the inbound
    // direction (see domain/value-objects/idempotency-key.ts).
    idempotencyKey: asIdempotencyKey(row.idempotencyKey),
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

  /**
   * Phase 3E SC-007 hardening helper — when the caller passes a tx
   * (via T047's `broadcasts.withTx(async tx => …)` wrapper), delegate
   * to it so the read/write participates in the same advisory-lock-
   * protected scope. When omitted, open our own runInTenant tx.
   */
  async function withTxOr<T>(
    txMaybe: unknown,
    fn: (tx: import('@/lib/db').TenantTx) => Promise<T>,
  ): Promise<T> {
    if (txMaybe !== undefined && txMaybe !== null) {
      return fn(txMaybe as import('@/lib/db').TenantTx);
    }
    return runInTenant(ctx, async (tx) => fn(tx));
  }

  return {
    async findByBroadcast(
      _tenantId: TenantSlug,
      broadcastId: BroadcastId,
      txMaybe?: unknown,
    ): Promise<readonly BatchManifest[]> {
      return withTxOr(txMaybe, async (tx) => {
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
      txMaybe?: unknown,
    ): Promise<Result<BatchManifest, BatchUpdateError>> {
      return withTxOr(txMaybe, async (tx) => {
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
        if (update.providerBroadcastId !== undefined) {
          patch.providerBroadcastId = update.providerBroadcastId;
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
        if (update.idempotencyKey !== undefined) {
          // Phase 3F.1 (F-04 fix) — rotate the idempotency key when
          // the auto-retry path re-queues a failed batch. Without
          // this, Resend's deduper short-circuits the retry → 5-
          // attempt budget = 5 no-ops.
          patch.idempotencyKey = update.idempotencyKey;
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

    async incrementCounter(
      _tenantId: TenantSlug,
      batchManifestId: string,
      field: BatchCounterField,
      resendEventId: string,
    ): Promise<
      Result<{ readonly duplicate: boolean }, BatchCounterIncrementError>
    > {
      // Map TypeScript camelCase → DB column. Fixed mapping keeps the
      // raw SQL safe from injection (no user-controlled column names).
      const columnMap: Record<BatchCounterField, string> = {
        deliveredCount: 'delivered_count',
        bouncedCount: 'bounced_count',
        complainedCount: 'complained_count',
        unsubscribedCount: 'unsubscribed_count',
      };
      const dbColumn = columnMap[field];
      try {
        return await runInTenant(ctx, async (tx) => {
          // F7-SF-1 — idempotency gate. Record the Resend event id FIRST;
          // ON CONFLICT means a Svix/Resend redelivery → the counter was
          // already bumped for this event, so skip the increment. Same tx
          // as the UPDATE so the ledger row + counter move atomically (a
          // crash between them rolls back both). The FK to
          // broadcast_batch_manifests means a missing batch surfaces here
          // as an FK violation (mapped to not_found below) — the same race
          // the bare UPDATE-0-rows path caught before.
          const dedup = (await tx.execute(sql`
            INSERT INTO broadcast_batch_delivery_events
              (tenant_id, resend_event_id, batch_manifest_id, counter_field)
            VALUES (${ctx.slug}, ${resendEventId}, ${batchManifestId}::uuid, ${dbColumn})
            ON CONFLICT (tenant_id, resend_event_id) DO NOTHING
            RETURNING resend_event_id
          `)) as unknown as Array<{ resend_event_id: string }>;
          if (dedup.length === 0) {
            return ok({ duplicate: true });
          }
          const result = (await tx.execute(sql`
            UPDATE broadcast_batch_manifests
            SET ${sql.raw(dbColumn)} = ${sql.raw(dbColumn)} + 1,
                updated_at = now()
            WHERE tenant_id = ${ctx.slug}
              AND id = ${batchManifestId}
            RETURNING id
          `)) as unknown as Array<{ id: string }>;
          if (result.length === 0) {
            // Defensive: the FK already validated the batch at INSERT, so
            // within this tx the UPDATE finds it. Throw to roll back the
            // ledger row so a later legitimate retry is not blocked.
            throw new Error('F7SF1_BATCH_GONE');
          }
          return ok({ duplicate: false });
        });
      } catch (e) {
        const chain = errorChainMessage(e);
        // Batch deleted between the BYPASSRLS lookup and now → FK violation
        // on the ledger INSERT (or the defensive throw). Map to not_found
        // so the webhook handler keeps its forensic-audit + 200-OK path.
        if (
          chain.includes('broadcast_batch_delivery_events_batch_fkey') ||
          chain.includes('F7SF1_BATCH_GONE')
        ) {
          return err({ kind: 'not_found' });
        }
        return err({
          kind: 'storage_error',
          detail: chain,
        });
      }
    },

    async findFailedRetryEligible(
      _tenantId: TenantSlug,
      opts: {
        readonly retryBudget: number;
        readonly cooloffSeconds: number;
        readonly limit: number;
      },
    ): Promise<readonly BatchManifest[]> {
      return runInTenant(ctx, async (tx) => {
        const rows = (await tx.execute(sql`
          SELECT * FROM broadcast_batch_manifests
          WHERE tenant_id = ${ctx.slug}
            AND status = 'failed'
            AND retry_count < ${opts.retryBudget}
            AND failed_at IS NOT NULL
            AND failed_at < now() - (${opts.cooloffSeconds}::int * INTERVAL '1 second')
          ORDER BY failed_at ASC
          LIMIT ${opts.limit}
        `)) as unknown as Array<BroadcastBatchManifestRow>;
        return rows.map(rowToManifest);
      });
    },

    async findBatchByProviderBroadcastIdBypassRls(
      providerBroadcastId: string,
    ): Promise<BatchProviderLookup | null> {
      // BYPASSRLS path — webhook handler resolves tenant ctx BEFORE
      // `app.current_tenant` is bound. Uses module-level `db` (the
      // schema-owner-bound client) NOT `runInTenant`. Mirrors F7 MVP
      // `findByResendBroadcastIdBypassRls` pattern.
      try {
        const rows = (await db.execute(sql`
          SELECT
            tenant_id,
            broadcast_id::text AS broadcast_id,
            id::text AS batch_manifest_id,
            batch_index,
            recipient_count
          FROM broadcast_batch_manifests
          WHERE provider_broadcast_id = ${providerBroadcastId}
          LIMIT 1
        `)) as unknown as Array<{
          tenant_id: string;
          broadcast_id: string;
          batch_manifest_id: string;
          batch_index: number;
          recipient_count: number;
        }>;
        if (rows.length === 0) return null;
        const row = rows[0]!;
        return {
          tenantId: row.tenant_id,
          broadcastId: asBroadcastId(row.broadcast_id),
          batchManifestId: row.batch_manifest_id,
          batchIndex: row.batch_index,
          recipientCount: row.recipient_count,
        };
      } catch (e) {
        // Phase 3F.1 (F-1 silent-fail fix) — previous bare `catch { return
        // null }` mapped EVERY DB error (Neon outage, schema-owner
        // credential issue, query syntax regression) to "unknown
        // broadcast id", which the webhook route then audited as a
        // forensic security signal. That mis-classification created a
        // dangerous blind spot during DB-outage incidents. We now log
        // the actual error and rethrow — the webhook route's outer
        // catch maps to `tenant_resolve_failed` 500 + Svix retries
        // (correct behavior when the DB is genuinely unreachable).
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            providerBroadcastId,
          },
          'broadcasts.batch.find_by_provider_id_failed',
        );
        throw e;
      }
    },

    async markCancelled(
      _tenantId: TenantSlug,
      batchManifestIds: readonly string[],
      txMaybe?: unknown,
    ): Promise<number> {
      if (batchManifestIds.length === 0) return 0;

      // Phase 3F.1 (F-21 fix) — when caller passes its own tx (from
      // cancel-broadcast's withTx scope), share atomicity so the
      // batch halt + broadcast-row transition commit/rollback together.
      return withTxOr(txMaybe, async (tx) => {
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
