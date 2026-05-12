/**
 * T050 — Drizzle idempotency store (F6 Infrastructure).
 *
 * Implements `IdempotencyStore` port. Writes to F6-owned table
 * `eventcreate_idempotency_receipts` (migration 0134). ON CONFLICT
 * (tenant_id, source, request_id) DO NOTHING returns wasFresh=true on
 * insert, wasFresh=false when the row already exists.
 *
 * The 7-day TTL is enforced at the DB layer via the column-default
 * `now() + INTERVAL '7 days'` (migration 0134). Daily cron sweeps
 * expired rows per Phase 10 T115.
 *
 * Inside the strict-transactional ACID unit (FR-037) — the use-case
 * `ingest-webhook-attendee.ts` (T047) calls this FIRST. On conflict,
 * the use-case short-circuits to duplicate-rejected audit + 409
 * without persisting any other side effects.
 */
import { and, eq } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import type { TenantTx } from '@/lib/db';
import { eventcreateIdempotencyReceipts } from './schema';
import { wrapRepoError } from './sanitize-db-error';
import type {
  IdempotencyStore,
  TryInsertReceiptInput,
  TryInsertReceiptResult,
  IdempotencyStoreError,
} from '../application/ports/idempotency-store';

export function makeDrizzleIdempotencyStore(executor: TenantTx): IdempotencyStore {
  return {
    async tryInsert(
      input: TryInsertReceiptInput,
    ): Promise<Result<TryInsertReceiptResult, IdempotencyStoreError>> {
      try {
        const inserted = await executor
          .insert(eventcreateIdempotencyReceipts)
          .values({
            tenantId: input.tenantId,
            source: input.source,
            requestId: input.requestId,
            ...(input.ttlExpiresAt ? { ttlExpiresAt: input.ttlExpiresAt } : {}),
          })
          .onConflictDoNothing({
            target: [
              eventcreateIdempotencyReceipts.tenantId,
              eventcreateIdempotencyReceipts.source,
              eventcreateIdempotencyReceipts.requestId,
            ],
          })
          .returning({ processedAt: eventcreateIdempotencyReceipts.processedAt });

        if (inserted.length > 0) {
          return ok({
            wasFresh: true,
            originalProcessedAt: null,
          });
        }

        // Conflict — read the existing row's processedAt for the
        // duplicate-rejected audit payload.
        const existing = await executor
          .select({ processedAt: eventcreateIdempotencyReceipts.processedAt })
          .from(eventcreateIdempotencyReceipts)
          .where(
            and(
              eq(eventcreateIdempotencyReceipts.tenantId, input.tenantId),
              eq(eventcreateIdempotencyReceipts.source, input.source),
              eq(eventcreateIdempotencyReceipts.requestId, input.requestId),
            ),
          )
          .limit(1);

        return ok({
          wasFresh: false,
          originalProcessedAt: existing.length > 0 ? new Date(existing[0]!.processedAt) : null,
        });
      } catch (e) {
        return err(wrapRepoError('idempotency', e));
      }
    },
  };
}
