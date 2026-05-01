/**
 * T159 — Drizzle `BroadcastDeliveriesRepo` adapter (F7 US5).
 *
 * Insert-only repo. Idempotency via UNIQUE
 * `(tenant_id, resend_event_id)` (FR-025): re-delivered webhook events
 * are silently dropped — caller distinguishes "first write" from
 * "replay" via the `inserted` flag and skips downstream side effects
 * (audit emit, suppression cascade) on replay.
 *
 * Tenant scoping: read paths go through `runInTenant(ctx, fn)`. Write
 * path receives `tx` from the caller (`process-webhook-event.ts` opens
 * `broadcastsRepo.withTx` then threads the same handle here so the
 * delivery upsert + status flip + audit emit land atomically).
 */
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '../../domain/broadcast';
import {
  asBroadcastDeliveryId,
  type BounceType,
  type BroadcastDelivery,
} from '../../domain/broadcast-delivery';
import { unsafeBrandEmailLower } from '../../domain/value-objects/email-lower';
import type {
  BroadcastDeliveriesRepo,
  NewBroadcastDeliveryInput,
} from '../../application/ports/broadcast-deliveries-repo';
import { broadcastDeliveries, type BroadcastDeliveryRow } from '../schema';

function rowToDelivery(row: BroadcastDeliveryRow): BroadcastDelivery {
  return {
    tenantId: row.tenantId,
    deliveryId: asBroadcastDeliveryId(row.deliveryId),
    broadcastId: asBroadcastId(row.broadcastId),
    resendEventId: row.resendEventId,
    resendMessageId: row.resendMessageId,
    recipientEmailLower: unsafeBrandEmailLower(row.recipientEmailLower),
    recipientMemberId: row.recipientMemberId,
    recipientMemberLookupAttemptedAt: row.recipientMemberLookupAttemptedAt,
    status: row.status,
    eventTimestamp: row.eventTimestamp,
    errorMessage: row.errorMessage,
    bounceType: (row.bounceType as BounceType | null) ?? null,
    createdAt: row.createdAt,
  };
}

export function makeDrizzleBroadcastDeliveriesRepo(
  tenantId: string,
): BroadcastDeliveriesRepo {
  const ctx = asTenantContext(tenantId);
  return {
    async upsertByResendEventId(txUnknown, input: NewBroadcastDeliveryInput) {
      const tx = txUnknown as TenantTx;
      const inserted = await tx
        .insert(broadcastDeliveries)
        .values({
          tenantId: input.tenantId,
          deliveryId: input.deliveryId,
          broadcastId: input.broadcastId,
          resendEventId: input.resendEventId,
          resendMessageId: input.resendMessageId,
          recipientEmailLower: input.recipientEmailLower,
          recipientMemberId: input.recipientMemberId,
          recipientMemberLookupAttemptedAt:
            input.recipientMemberLookupAttemptedAt,
          status: input.status,
          eventTimestamp: input.eventTimestamp,
          errorMessage: input.errorMessage,
          bounceType: input.bounceType,
        })
        .onConflictDoNothing({
          target: [
            broadcastDeliveries.tenantId,
            broadcastDeliveries.resendEventId,
          ],
        })
        .returning();

      if (inserted.length > 0) {
        const row = inserted[0]!;
        return {
          inserted: true,
          delivery: rowToDelivery(row as BroadcastDeliveryRow),
        };
      }

      // Conflict path — re-fetch the existing row so caller sees the
      // canonical persisted shape (delivery_id may differ from the
      // attempted insert).
      const [existing] = await tx
        .select()
        .from(broadcastDeliveries)
        .where(
          and(
            eq(broadcastDeliveries.tenantId, input.tenantId),
            eq(broadcastDeliveries.resendEventId, input.resendEventId),
          ),
        )
        .limit(1);
      if (existing === undefined) {
        throw new Error(
          'upsertByResendEventId: ON CONFLICT DO NOTHING returned 0 rows but no existing row was found',
        );
      }
      return {
        inserted: false,
        delivery: rowToDelivery(existing as BroadcastDeliveryRow),
      };
    },

    async findByBroadcastId(tenantIdArg, broadcastId) {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(broadcastDeliveries)
          .where(
            and(
              eq(broadcastDeliveries.tenantId, tenantIdArg),
              eq(broadcastDeliveries.broadcastId, broadcastId),
            ),
          );
        return rows.map((r) => rowToDelivery(r as BroadcastDeliveryRow));
      });
    },

    async aggregateByBroadcast(tenantIdArg, broadcastId, txUnknown) {
      // Review PR #19 stale-read fix: when caller threads its in-flight
      // tx (writes from `broadcastsRepo.withTx`), join that tx so the
      // SELECT sees the just-upserted delivery row. Without the
      // threaded tx, Postgres READ COMMITTED isolation hides the
      // uncommitted INSERT from a fresh connection — the
      // per-broadcast >5% complaint-rate auto-halt and the
      // `terminalCount >= estimatedRecipientCount` completion check
      // would silently undershoot by one event each time.
      const runQuery = async (tx: TenantTx) => {
        const rows = (await tx
          .select({
            status: broadcastDeliveries.status,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(broadcastDeliveries)
          .where(
            and(
              eq(broadcastDeliveries.tenantId, tenantIdArg),
              eq(broadcastDeliveries.broadcastId, broadcastId),
            ),
          )
          .groupBy(broadcastDeliveries.status)) as ReadonlyArray<{
          status: string;
          count: number;
        }>;
        return rows;
      };

      const rows =
        txUnknown !== null && txUnknown !== undefined
          ? await runQuery(txUnknown as TenantTx)
          : await runInTenant(ctx, runQuery);

      // Inline the bucketing logic (was previously inside runInTenant).
      return await aggregateRows(rows, tenantIdArg, broadcastId);
    },
  };
}

function aggregateRows(
  rows: ReadonlyArray<{ status: string; count: number }>,
  tenantIdArg: string,
  broadcastId: import('../../domain/broadcast').BroadcastId,
) {
  // Explicit switch: each status enum value maps to ONE counter — no
  // intermediate mutable type, no Record-key indirection, and
  // TypeScript exhaustiveness on the BroadcastDeliveryStatus union
  // via the unknown-status fallthrough below.
  let sent = 0;
  let delivered = 0;
  let bounced = 0;
  let softBounced = 0;
  let complained = 0;
  for (const r of rows) {
    switch (r.status) {
      case 'sent':
        sent = r.count;
        break;
      case 'delivered':
        delivered = r.count;
        break;
      case 'bounced':
        bounced = r.count;
        break;
      case 'soft_bounced':
        softBounced = r.count;
        break;
      case 'complained':
        complained = r.count;
        break;
      default:
        // Review ERR-M5: schema/code drift surface — a future enum
        // value (queued, opened, …) silently dropping out of the
        // aggregate corrupts the completion-check arithmetic. Log at
        // error so the alert pipeline fires (per docs/observability.md).
        // Mirrors `reduceDeliveryAggregateRows` in the sibling
        // broadcasts repo.
        logger.error(
          {
            tenantId: tenantIdArg,
            broadcastId,
            status: r.status,
            count: r.count,
          },
          'broadcasts.deliveries.aggregate.unknown_status',
        );
        break;
    }
  }
  return {
    broadcastId,
    sent,
    delivered,
    bounced,
    softBounced,
    complained,
  };
}
