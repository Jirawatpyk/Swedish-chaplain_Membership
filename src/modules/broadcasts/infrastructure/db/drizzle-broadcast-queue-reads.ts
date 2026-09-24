/**
 * Drizzle `BroadcastQueueReads` — the staff dashboard's per-stage counts and
 * batched delivery results (F119 T116 / T119). Tenant-scoped via
 * `runInTenant` + an explicit `tenant_id` predicate (two-layer isolation,
 * Principle I).
 *
 * The status count groups on the ENUM column, so the planner may serve it
 * from `broadcasts_stage_queue_idx (tenant_id, status, …)`; with one tenant
 * owning the table it rightly prefers one sequential pass — at SC-008's
 * 1,000 rows that is well inside the budget (T114 measures it).
 *
 * The delivery read selects `broadcast_id`, `status` and a count — never
 * `recipient_email_lower` or any other contact-level column (FR-036) — over
 * `broadcast_deliveries_broadcast_status_idx (tenant_id, broadcast_id,
 * status)`, and buckets each E-Blast with the SAME reducer the per-broadcast
 * aggregate uses, so the dashboard and the detail page cannot disagree.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { broadcastDeliveries, broadcasts } from '../schema';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
} from '../../domain/value-objects/broadcast-status';
import type {
  BroadcastQueueReads,
  DeliveryResult,
} from '../../application/ports/broadcast-queue-reads';
import { reduceDeliveryAggregateRows } from './drizzle-broadcasts-repo';

/** The grouped per-status count. */
function stageCountsQuery(tx: TenantTx, tenantId: string) {
  return tx
    .select({ status: broadcasts.status, n: sql<number>`COUNT(*)::int` })
    .from(broadcasts)
    .where(eq(broadcasts.tenantId, tenantId))
    .groupBy(broadcasts.status);
}

export function makeDrizzleBroadcastQueueReads(tenantId: string): BroadcastQueueReads {
  return {
    async countByStatus(ctx: TenantContext) {
      const rows = await runInTenant(ctx, (tx) => stageCountsQuery(tx, tenantId));
      const counts = Object.fromEntries(BROADCAST_STATUSES.map((s) => [s, 0])) as Record<BroadcastStatus, number>;
      for (const r of rows) counts[r.status] = r.n;
      return counts;
    },

    async deliveryCountsFor(ctx: TenantContext, broadcastIds: readonly string[]) {
      const out = new Map<string, DeliveryResult>();
      if (broadcastIds.length === 0) return out;
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select({
            broadcastId: broadcastDeliveries.broadcastId,
            status: broadcastDeliveries.status,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(broadcastDeliveries)
          .where(
            and(
              eq(broadcastDeliveries.tenantId, tenantId),
              inArray(broadcastDeliveries.broadcastId, [...broadcastIds]),
            ),
          )
          .groupBy(broadcastDeliveries.broadcastId, broadcastDeliveries.status),
      );
      const byBroadcast = new Map<string, Array<{ status: string; count: number }>>();
      for (const r of rows) {
        const list = byBroadcast.get(r.broadcastId) ?? [];
        list.push({ status: r.status, count: r.count });
        byBroadcast.set(r.broadcastId, list);
      }
      for (const [broadcastId, statusRows] of byBroadcast) {
        const a = reduceDeliveryAggregateRows(statusRows, { tenantId, broadcastId });
        out.set(broadcastId, {
          recipients: a.sent + a.delivered + a.bounced + a.softBounced + a.complained,
          delivered: a.delivered,
          bounced: a.bounced + a.softBounced,
          complained: a.complained,
        });
      }
      return out;
    },
  };
}
