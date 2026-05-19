/**
 * B3 (F7.1a US1) — Drizzle `BroadcastsRetryRepo` adapter.
 *
 * Narrow port (ISP) for the 3 retry-loop persistence ops introduced
 * by F7.1a US1: findById / incrementManualRetryCount / acceptPartial.
 * Each method runs inside `runInTenant(ctx, tx => …)` so RLS+FORCE
 * (migration 0166) is the storage-layer guard.
 *
 * Atomicity contracts:
 *   - `incrementManualRetryCount` — single UPDATE with CHECK clause
 *     `WHERE manual_retry_count < 3 RETURNING manual_retry_count`.
 *     If 0 rows updated, the budget was already exhausted → return
 *     `check_violation` (port maps to MANUAL_RETRY_BUDGET_EXHAUSTED).
 *   - `acceptPartial` — single UPDATE with state guard `WHERE status =
 *     'partially_sent'`. Concurrent admin clicks serialise via DB row
 *     lock; the loser sees 0 rows updated → `INVALID_STATE_TRANSITION`.
 *
 * Not in barrel — Infrastructure adapter. Composition root wires
 * inline at Phase 3 (admin routes T050 + T051).
 */

import { and, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { errorChainMessage } from '@/lib/db-errors';
import { asTenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../domain/broadcast';
import { asBroadcastId } from '../domain/broadcast';
import type {
  AcceptPartialError,
  AcceptPartialInput,
  BroadcastRetrySnapshot,
  BroadcastRetryStatus,
  BroadcastsRetryRepo,
  IncrementError,
} from '../application/ports/broadcasts-retry-repo';
import { broadcasts } from './schema';

export function makeDrizzleBroadcastsRetryRepo(
  tenantId: string,
): BroadcastsRetryRepo {
  const ctx = asTenantContext(tenantId);

  /**
   * Phase 3E SC-007 hardening helper — when the caller passes a tx
   * (via the withTx wrapper around T047 retry use case body),
   * delegate directly so the read/write participates in the same
   * lock-protected tx. When omitted, open our own runInTenant tx.
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
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return runInTenant(ctx, async (tx) => fn(tx));
    },

    async findById(
      _tenantId: string,
      broadcastId: BroadcastId,
      txMaybe?: unknown,
    ): Promise<BroadcastRetrySnapshot | null> {
      return withTxOr(txMaybe, async (tx) => {
        const [row] = await tx
          .select({
            tenantId: broadcasts.tenantId,
            broadcastId: broadcasts.broadcastId,
            status: broadcasts.status,
            manualRetryCount: broadcasts.manualRetryCount,
          })
          .from(broadcasts)
          .where(
            and(
              eq(broadcasts.tenantId, ctx.slug),
              eq(broadcasts.broadcastId, broadcastId),
            ),
          )
          .limit(1);

        if (row === undefined) return null;

        return {
          tenantId: row.tenantId,
          broadcastId: asBroadcastId(row.broadcastId),
          status: row.status as BroadcastRetryStatus,
          manualRetryCount: row.manualRetryCount,
        };
      });
    },

    async incrementManualRetryCount(
      _tenantId: string,
      broadcastId: BroadcastId,
      txMaybe?: unknown,
    ): Promise<Result<number, IncrementError>> {
      try {
        return await withTxOr(txMaybe, async (tx) => {
          const [updated] = await tx
            .update(broadcasts)
            .set({
              manualRetryCount: sql`${broadcasts.manualRetryCount} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(broadcasts.tenantId, ctx.slug),
                eq(broadcasts.broadcastId, broadcastId),
                // Budget guard — DB CHECK constraint enforces this too,
                // but `WHERE` lets us distinguish `not_found` (no row)
                // from `check_violation` (row exists, budget exhausted).
                sql`${broadcasts.manualRetryCount} < 3`,
              ),
            )
            .returning({
              manualRetryCount: broadcasts.manualRetryCount,
            });

          if (updated === undefined) {
            // Either the row doesn't exist (RLS hides cross-tenant) OR
            // budget = 3. Probe to disambiguate.
            const [probe] = await tx
              .select({ id: broadcasts.broadcastId })
              .from(broadcasts)
              .where(
                and(
                  eq(broadcasts.tenantId, ctx.slug),
                  eq(broadcasts.broadcastId, broadcastId),
                ),
              )
              .limit(1);
            return err({
              kind: probe === undefined ? 'not_found' : 'check_violation',
            });
          }

          return ok(updated.manualRetryCount);
        });
      } catch (e) {
        return err({
          kind: 'storage_error',
          detail: errorChainMessage(e),
        });
      }
    },

    async acceptPartial(
      _tenantId: string,
      broadcastId: BroadcastId,
      input: AcceptPartialInput,
    ): Promise<Result<{ acceptedAt: Date }, AcceptPartialError>> {
      try {
        return await runInTenant(ctx, async (tx) => {
          // Phase 3F.7 (F-24 fix) — set quota fields on accept-partial.
          // Spec FR-008c: partial delivery IS real send activity →
          // quota MUST be consumed (matches F7 MVP `sent` path). The
          // one-active-broadcast-state invariant requires both fields
          // non-null in `partial_delivery_accepted` terminal state.
          // COALESCE preserves prior values if somehow already set
          // (idempotent re-call protection).
          const [updated] = await tx
            .update(broadcasts)
            .set({
              status: 'partial_delivery_accepted',
              partialDeliveryAcceptedAt: input.acceptedAt,
              partialDeliveryAcceptedByUserId: input.acceptedByUserId,
              quotaYearConsumed: sql`COALESCE(${broadcasts.quotaYearConsumed}, EXTRACT(YEAR FROM ${input.acceptedAt}::timestamptz AT TIME ZONE 'Asia/Bangkok')::int)`,
              quotaConsumedAt: sql`COALESCE(${broadcasts.quotaConsumedAt}, ${input.acceptedAt}::timestamptz)`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(broadcasts.tenantId, ctx.slug),
                eq(broadcasts.broadcastId, broadcastId),
                // Defence-in-depth — adapter enforces partially_sent
                // pre-condition as a WHERE clause so concurrent clicks
                // serialise via the row lock; the loser sees 0 rows
                // updated and we surface INVALID_STATE_TRANSITION.
                eq(broadcasts.status, 'partially_sent'),
              ),
            )
            .returning({
              partialDeliveryAcceptedAt: broadcasts.partialDeliveryAcceptedAt,
            });

          if (updated === undefined) {
            // Disambiguate not_found vs invalid_state_transition.
            const [probe] = await tx
              .select({ status: broadcasts.status })
              .from(broadcasts)
              .where(
                and(
                  eq(broadcasts.tenantId, ctx.slug),
                  eq(broadcasts.broadcastId, broadcastId),
                ),
              )
              .limit(1);
            return err({
              kind:
                probe === undefined ? 'not_found' : 'INVALID_STATE_TRANSITION',
            });
          }

          const acceptedAt = updated.partialDeliveryAcceptedAt;
          if (acceptedAt === null) {
            // Should be impossible — set above; defensive narrowing.
            return err({
              kind: 'storage_error',
              detail: 'acceptedAt unexpectedly null after UPDATE',
            });
          }

          return ok({ acceptedAt });
        });
      } catch (e) {
        return err({
          kind: 'storage_error',
          detail: errorChainMessage(e),
        });
      }
    },
  };
}
