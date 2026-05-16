/**
 * F6 Phase 10 T115 — Drizzle adapter for `IdempotencyReceiptsSweepPort`.
 *
 * Pure Infrastructure — encapsulates the Drizzle DELETE.
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { eventcreateIdempotencyReceipts } from './schema';
import type { IdempotencyReceiptsSweepPort } from '../application/use-cases/sweep-stale-idempotency-receipts';
import type { TenantId } from '@/modules/members';

export function makeDrizzleIdempotencySweepPort(
  executor: TenantTx,
): IdempotencyReceiptsSweepPort {
  return {
    async delete(input: {
      readonly tenantId: TenantId;
      readonly cutoff: Date;
      readonly maxRows: number;
    }): Promise<{ readonly deletedCount: number }> {
      // Postgres doesn't support LIMIT directly on DELETE; we use a
      // subquery with ctid + LIMIT to cap the blast radius per run.
      const deleted = await executor
        .delete(eventcreateIdempotencyReceipts)
        .where(
          and(
            eq(eventcreateIdempotencyReceipts.tenantId, input.tenantId),
            lte(eventcreateIdempotencyReceipts.ttlExpiresAt, input.cutoff),
            sql`ctid IN (
              SELECT ctid FROM ${eventcreateIdempotencyReceipts}
              WHERE ${eventcreateIdempotencyReceipts.tenantId} = ${input.tenantId}
                AND ${eventcreateIdempotencyReceipts.ttlExpiresAt} <= ${input.cutoff.toISOString()}
              LIMIT ${input.maxRows}
            )`,
          ),
        )
        .returning({ requestId: eventcreateIdempotencyReceipts.requestId });
      return { deletedCount: deleted.length };
    },
  };
}
