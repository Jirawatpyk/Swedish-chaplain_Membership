/**
 * F9 US6 (T091) — GDPR audit-subset reader (Drizzle).
 *
 * Backs the insights GDPR archive builder (consumed via the auth barrel). Reads
 * `audit_log` with the member-scoping union predicate (member-performed ∪
 * member-targeted), bounded by `LIMIT`. Tenant-scoped via `runInTenant` + an
 * explicit `tenant_id = ctx.slug` predicate (mirrors `audit-query-repo.ts`).
 *
 * The `payload->>'member_id'` / `subject_member_id` arms are JSONB text
 * extractions; they are not index-backed, but the `(tenant_id, timestamp DESC)`
 * index + the hard `LIMIT` keep the scan bounded to the tenant's audit slice —
 * acceptable for the low-volume, async GDPR path (research R5).
 */
import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { auditLog } from './schema';
import type { AuditEventType } from '@/modules/auth/domain/audit-event';
import type { AuditQueryReadRow } from '../../application/audit-query-read';
import type {
  GdprAuditSubsetReadInput,
  GdprAuditSubsetReadPort,
} from '../../application/gdpr-audit-subset-read';

export const gdprAuditSubsetReadAdapter: GdprAuditSubsetReadPort = {
  async query(
    ctx: TenantContext,
    input: GdprAuditSubsetReadInput,
  ): Promise<readonly AuditQueryReadRow[]> {
    return runInTenant(ctx, async (tx) => {
      // Union arms: payload member-id arms always apply; actor/target arms only
      // when the member has a linked user account.
      const arms: SQL[] = [
        sql`${auditLog.payload}->>'member_id' = ${input.memberId}`,
        sql`${auditLog.payload}->>'subject_member_id' = ${input.memberId}`,
      ];
      if (input.memberUserIds.length > 0) {
        arms.push(inArray(auditLog.actorUserId, [...input.memberUserIds]));
        arms.push(inArray(auditLog.targetUserId, [...input.memberUserIds]));
      }
      const union = or(...arms);

      const conds: SQL[] = [eq(auditLog.tenantId, ctx.slug)];
      if (union) conds.push(union);

      const rows = await tx
        .select({
          id: auditLog.id,
          eventType: auditLog.eventType,
          actorUserId: auditLog.actorUserId,
          targetUserId: auditLog.targetUserId,
          summary: auditLog.summary,
          occurredAt: auditLog.timestamp,
          occurredAtIso: sql<string>`${auditLog.timestamp}::text`,
          requestId: auditLog.requestId,
          payload: auditLog.payload,
        })
        .from(auditLog)
        .where(and(...conds))
        .orderBy(desc(auditLog.timestamp), desc(auditLog.id))
        .limit(input.limit);

      return rows.map((r) => ({
        id: r.id,
        eventType: r.eventType as AuditEventType,
        actorUserId: r.actorUserId,
        targetUserId: r.targetUserId,
        summary: r.summary,
        occurredAt: r.occurredAt,
        occurredAtIso: r.occurredAtIso,
        requestId: r.requestId,
        payload: (r.payload as Record<string, unknown> | null) ?? null,
      }));
    });
  },
};
