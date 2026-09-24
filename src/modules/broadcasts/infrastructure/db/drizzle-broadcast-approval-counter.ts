/**
 * Drizzle `BroadcastApprovalCounter` — counts the E-Blasts waiting on
 * marketing for the tenant. Tenant-scoped via `runInTenant` + an explicit
 * `tenant_id` predicate (two-layer isolation, Principle I).
 *
 * F119 T132 — the set is the Domain's `MARKETING_TURN_STATUSES` (it was the
 * literal `status = 'submitted'`), compared on the ENUM column so the planner
 * can use `broadcasts_stage_queue_idx (tenant_id, status, stage_entered_at)`:
 * a live indexed `count(*)` at render, not the gauge's 5-minute snapshot.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { broadcasts } from '../schema';
import { MARKETING_TURN_STATUSES } from '../../domain/stage/whose-turn';
import { APPROVAL_ROUND_STATUSES } from '../../domain/stage/in-progress-statuses';
import type {
  BroadcastApprovalCounter,
  MarketingQueueCounts,
} from '../../application/ports/broadcast-approval-counter';

/** Every status either count reads — the WHERE, so the scan never leaves the index. */
const COUNTED_STATUSES = [...new Set([...MARKETING_TURN_STATUSES, ...APPROVAL_ROUND_STATUSES])];

export function makeDrizzleBroadcastApprovalCounter(
  tenantId: string,
): BroadcastApprovalCounter {
  async function countMarketingQueue(ctx: TenantContext): Promise<MarketingQueueCounts> {
    return runInTenant(ctx, async (tx) => {
      const rows = await tx
        .select({
          marketingTurn: sql<number>`COUNT(*) FILTER (WHERE ${inArray(broadcasts.status, [...MARKETING_TURN_STATUSES])})::int`,
          inApprovalRound: sql<number>`COUNT(*) FILTER (WHERE ${inArray(broadcasts.status, [...APPROVAL_ROUND_STATUSES])})::int`,
        })
        .from(broadcasts)
        .where(and(eq(broadcasts.tenantId, tenantId), inArray(broadcasts.status, COUNTED_STATUSES)));
      return { marketingTurn: rows[0]?.marketingTurn ?? 0, inApprovalRound: rows[0]?.inApprovalRound ?? 0 };
    });
  }
  return {
    async countAwaitingApproval(ctx: TenantContext): Promise<number> {
      return (await countMarketingQueue(ctx)).marketingTurn;
    },
    countMarketingQueue,
  };
}
