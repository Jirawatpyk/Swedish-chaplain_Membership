/**
 * COMP-1 US3-D — the SECURITY-CRITICAL DPO erasure-evidence reader.
 *
 * Mirrors `audit-query-repo.ts` (the F9 reader): `runInTenant` + a column
 * projection + `(timestamp DESC, id DESC)` order. For ONE erased member it
 * UNIONs the tenant-scoped erasure lifecycle events (matched by
 * `payload->>'member_id'`) with the tenant-NULL F1 `user_erased` identity
 * proof (matched by `target_user_id`).
 *
 * Two-layer isolation (Principle I) — the PERMISSIVE-RLS hazard:
 * `audit_log_tenant_isolation` is PERMISSIVE (`tenant_id IS NULL OR tenant_id
 * = current_setting('app.current_tenant')`, migration 0007) so tenant-NULL
 * rows (the F1 `user_erased` events) are DB-visible to EVERY tenant — the
 * ONLY cross-tenant wall is the app-layer `tenant_id = ctx.slug` predicate
 * (Arm A). This reader DELIBERATELY removes that wall for ONE event
 * (`user_erased`, Arm B) to surface the member's own credential-erasure
 * proof. It re-imposes a strict bound — `target_user_id = ANY(<member's own
 * linked users>)` — and DROPS Arm B ENTIRELY when that set is empty (FIX-1).
 * Get the bound wrong → cross-tenant PII leak; the FIX-1 omission is the
 * auditable contract the security review reads, NOT "Drizzle neutralises an
 * empty `inArray`".
 *
 * INDEX (drizzle R-1, accepted): Arm A is backed by the 0190 `(tenant_id,
 * event_type, timestamp DESC)` composite. Arm B (`tenant_id IS NULL AND
 * event_type='user_erased' AND target_user_id = ANY(...)`) cannot use those
 * composites (they lead with `tenant_id`, unusable for `IS NULL`); it relies
 * on the single-col `audit_log_target_idx`. Acceptable for this read-only,
 * low-volume (per-member, ≤ a handful of linked users) evidence query.
 */
import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { auditLog } from './schema';
import {
  ERASURE_EVIDENCE_EVENTS,
  type ErasureEvidenceReadPort,
  type ErasureEvidenceRow,
} from '../../application/erasure-evidence-read';

/**
 * The tenant-scoped erasure lifecycle event types (Arm A). This allow-list is
 * the single source of WHICH events the query fetches; each name references a
 * shared `ERASURE_EVIDENCE_EVENTS` constant (S-2) so a typo is a compile error.
 */
const TENANT_SCOPED_ERASURE_EVENTS = [
  ERASURE_EVIDENCE_EVENTS.requested,
  ERASURE_EVIDENCE_EVENTS.erased,
  ERASURE_EVIDENCE_EVENTS.taxRedacted,
  ERASURE_EVIDENCE_EVENTS.subprocessorPropagated,
] as const;

/**
 * Build the `WHERE` for one member's erasure evidence.
 *
 * Exported as a pure helper so the FIX-1 structural unit test can assert the
 * built SQL directly via `.toSQL()` (params + text) AND the adapter consumes
 * the SAME builder — there is no second code path that could drift.
 *
 * FIX-1: `memberLinkedUserIds.length > 0 ? or(armA, armB) : armA`. When the
 * set is EMPTY, Arm B is NEVER BUILT — no `tenant_id IS NULL AND
 * event_type='user_erased'` SQL is emitted. Do NOT rely on Drizzle
 * neutralising an empty `inArray`/`ANY`; the explicit structural omission is
 * the auditable contract.
 */
export function buildErasureEvidenceWhere(
  ctx: TenantContext,
  memberId: string,
  memberLinkedUserIds: readonly string[],
): SQL {
  // Arm A — tenant-scoped erasure lifecycle events for THIS member. The
  // `tenant_id = ctx.slug` predicate is the app-layer cross-tenant wall.
  const armA = and(
    eq(auditLog.tenantId, ctx.slug),
    inArray(auditLog.eventType, [...TENANT_SCOPED_ERASURE_EVENTS]),
    sql`${auditLog.payload}->>'member_id' = ${memberId}`,
  ) as SQL;

  if (memberLinkedUserIds.length === 0) {
    // FIX-1 — no linked login → NO tenant-NULL read is even built.
    return armA;
  }

  // Arm B — the tenant-NULL `user_erased` proof, bounded by the member's own
  // linked user ids. B-1 (drizzle): bind as `= ANY(ARRAY[...]::uuid[])`, NOT
  // `inArray(uuidCol, jsArray)`, which trips the Neon serverless "argument
  // must be of type string" class (the US3-C lesson). Cast `::uuid[]` (the
  // column is uuid); NO lower-case (it's a uuid, not an email).
  const armB = and(
    sql`${auditLog.tenantId} IS NULL`,
    eq(auditLog.eventType, ERASURE_EVIDENCE_EVENTS.userErased),
    sql`${auditLog.targetUserId} = ANY(ARRAY[${sql.join(
      memberLinkedUserIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[])`,
  ) as SQL;

  return or(armA, armB) as SQL;
}

export const erasureEvidenceReadAdapter: ErasureEvidenceReadPort = {
  async readForMember(
    ctx: TenantContext,
    memberId: string,
    memberLinkedUserIds: readonly string[],
  ): Promise<readonly ErasureEvidenceRow[]> {
    return runInTenant(ctx, async (tx) => {
      const where = buildErasureEvidenceWhere(ctx, memberId, memberLinkedUserIds);

      const rows = await tx
        .select({
          id: auditLog.id,
          eventType: auditLog.eventType,
          occurredAtIso: sql<string>`${auditLog.timestamp}::text`,
          actorUserId: auditLog.actorUserId,
          targetUserId: auditLog.targetUserId,
          payload: auditLog.payload,
        })
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.timestamp), desc(auditLog.id));

      return rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        occurredAtIso: r.occurredAtIso,
        actorUserId: r.actorUserId,
        targetUserId: r.targetUserId,
        payload: (r.payload as Record<string, unknown> | null) ?? null,
      }));
    });
  },
};
