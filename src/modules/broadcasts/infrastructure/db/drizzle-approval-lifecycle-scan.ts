/**
 * F119 T130 — Drizzle `ApprovalLifecycleScanPort`: the daily reminder /
 * expiry candidates (contracts/dashboard-and-notifications.md § 5).
 *
 * `status = 'awaiting_member_approval'` compared on the ENUM column, not
 * `status::text` — the cast would stop the planner matching the partial index
 * `broadcasts_awaiting_member_idx (tenant_id, stage_entered_at) WHERE status =
 * 'awaiting_member_approval'` (migration 0305), which is what serves this
 * scan. Explicit `tenant_id` predicate on top of RLS (two-layer isolation,
 * Principle I), and the caller's `runInTenant` tx — never the pool-global
 * `db`, which would read without `app.current_tenant`.
 */
import { and, asc, eq, gt, lte, sql, type SQL } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { TenantSlug } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type {
  ApprovalLifecycleScanPort,
  AwaitingApprovalCandidate,
  AwaitingApprovalScanQuery,
} from '../../application/ports/approval-lifecycle-scan-port';
import { broadcasts } from '../schema';
import { assertTenantBoundTx } from './drizzle-broadcasts-repo';

export const drizzleApprovalLifecycleScan: ApprovalLifecycleScanPort = {
  async listAwaitingMemberApprovalInTx(
    txUnknown: unknown,
    tenantId: TenantSlug,
    query: AwaitingApprovalScanQuery,
  ): Promise<readonly AwaitingApprovalCandidate[]> {
    const tx = txUnknown as TenantTx;
    await assertTenantBoundTx(tx, tenantId as string, 'listAwaitingMemberApprovalInTx');
    const conditions: SQL[] = [
      eq(broadcasts.tenantId, tenantId as string),
      eq(broadcasts.status, 'awaiting_member_approval'),
      lte(broadcasts.stageEnteredAt, query.enteredAtOrBefore),
    ];
    if (query.enteredAfter !== undefined) conditions.push(gt(broadcasts.stageEnteredAt, query.enteredAfter));
    const rows = await tx
      .select({ broadcastId: broadcasts.broadcastId, stageEnteredAt: broadcasts.stageEnteredAt })
      .from(broadcasts)
      .where(and(...conditions))
      .orderBy(asc(broadcasts.stageEnteredAt))
      .limit(query.limit);
    return rows.map((r) => ({ broadcastId: r.broadcastId as BroadcastId, stageEnteredAt: r.stageEnteredAt }));
  },

  /**
   * `SET` takes no bind parameters, so the value is interpolated — clamped to
   * a sane integer first (the images repo's shape); a bare integer is
   * milliseconds to Postgres.
   */
  async setStatementTimeoutInTx(txUnknown: unknown, ms: number): Promise<void> {
    const bounded = Number.isFinite(ms) ? Math.min(60_000, Math.max(1, Math.trunc(ms))) : 5_000;
    await (txUnknown as TenantTx).execute(sql.raw(`SET LOCAL statement_timeout = ${bounded}`));
  },
};
