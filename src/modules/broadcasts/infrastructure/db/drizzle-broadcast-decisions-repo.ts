/**
 * F119 T055 — Drizzle adapter for `BroadcastDecisionsRepo` (migration 0305).
 *
 * Append-only: `insert` and `listByBroadcast`, nothing else — no UPDATE and
 * no DELETE statement exists in this file, and the table's trigger refuses
 * both anyway. Every query runs on the caller's `runInTenant` `tx` (never the
 * pool-global `db`) and names `tenant_id` in its WHERE.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { TenantSlug } from '@/modules/tenants';
import { asBroadcastId, type BroadcastId } from '../../domain/broadcast';
import type { MemberDecision } from '../../domain/approval/member-decision';
import type {
  BroadcastDecisionsRepo,
  BroadcastDecisionsTx,
  NewMemberDecision,
} from '../../application/ports/broadcast-decisions-repo';
import { broadcastMemberDecisions, type BroadcastMemberDecisionRow } from '../schema';

function toDecision(row: BroadcastMemberDecisionRow): MemberDecision {
  return {
    id: row.id,
    tenantId: row.tenantId,
    broadcastId: asBroadcastId(row.broadcastId),
    versionId: row.versionId,
    round: row.round,
    decision: row.decision,
    reason: row.reason,
    decidedByUserId: row.decidedByUserId,
    decidedByContactId: row.decidedByContactId,
    decidedAt: row.decidedAt,
  };
}

export const drizzleBroadcastDecisionsRepo: BroadcastDecisionsRepo = {
  async insert(
    tenantId: TenantSlug,
    input: NewMemberDecision,
    tx: BroadcastDecisionsTx,
  ): Promise<MemberDecision> {
    const rows = await (tx as TenantTx)
      .insert(broadcastMemberDecisions)
      .values({
        tenantId: tenantId as string,
        broadcastId: input.broadcastId as string,
        versionId: input.versionId,
        round: input.round,
        decision: input.decision,
        reason: input.reason,
        decidedByUserId: input.decidedByUserId,
        decidedByContactId: input.decidedByContactId,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('broadcast_member_decisions_insert_returned_no_row');
    return toDecision(row);
  },

  async listByBroadcast(
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    tx: BroadcastDecisionsTx,
  ): Promise<readonly MemberDecision[]> {
    const rows = await (tx as TenantTx)
      .select()
      .from(broadcastMemberDecisions)
      .where(
        and(
          eq(broadcastMemberDecisions.tenantId, tenantId as string),
          eq(broadcastMemberDecisions.broadcastId, broadcastId as string),
        ),
      )
      .orderBy(asc(broadcastMemberDecisions.decidedAt), asc(broadcastMemberDecisions.id));
    return rows.map(toDecision);
  },
};
