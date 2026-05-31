/**
 * F9 US2 (T044) — keyset-paginated, filterable audit-log reader.
 *
 * Backs the insights `auditQuery` use-case (consumed via the auth barrel).
 * Read-only; separate from the append-only `auditRepo`. Tenant-scoped via
 * `runInTenant` + the composite indexes from migration 0190
 * (`(tenant_id, event_type, timestamp DESC)`, `(tenant_id, actor_user_id,
 * timestamp DESC)`, `(tenant_id, timestamp DESC)`) so the FR-008 p95 < 1 s @
 * 50k events target is index-backed.
 *
 * Two-layer isolation (Principle I): the `audit_log_tenant_isolation` RLS
 * policy is PERMISSIVE (`tenant_id IS NULL OR tenant_id = current_setting(...)`)
 * so legacy null-tenant_id F1 rows would otherwise surface to EVERY tenant. The
 * explicit `tenant_id = ctx.slug` predicate below is the app-layer half — it
 * excludes those null-tenant rows and cannot leak once a 2nd tenant onboards.
 * (Mirrors `audit-read-repo.ts`, the activity-feed reader.)
 */
import { and, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { auditLog } from './schema';
import type { AuditEventType } from '@/modules/auth/domain/audit-event';
import type {
  AuditQueryReadFilters,
  AuditQueryReadPort,
  AuditQueryReadRow,
} from '../../application/audit-query-read';

export const auditQueryReadAdapter: AuditQueryReadPort = {
  async query(
    ctx: TenantContext,
    filters: AuditQueryReadFilters,
  ): Promise<readonly AuditQueryReadRow[]> {
    return runInTenant(ctx, async (tx) => {
      // App-layer tenant predicate (excludes null-tenant F1 rows) + filters.
      const conds: SQL[] = [eq(auditLog.tenantId, ctx.slug)];

      if (filters.eventType && filters.eventType.length > 0) {
        conds.push(inArray(auditLog.eventType, filters.eventType));
      }
      if (filters.actorUserId) {
        conds.push(eq(auditLog.actorUserId, filters.actorUserId));
      }
      if (filters.targetUserId) {
        conds.push(eq(auditLog.targetUserId, filters.targetUserId));
      }
      // Cast the full-precision (µs) ISO bound to timestamptz — same precision
      // contract as the cursor below; a JS Date would truncate to ms and re-drop
      // the day's final-µs window. (code-review Round 2 — #14)
      if (filters.from) {
        conds.push(gte(auditLog.timestamp, sql`${filters.from}::timestamptz`));
      }
      if (filters.to) {
        conds.push(lte(auditLog.timestamp, sql`${filters.to}::timestamptz`));
      }
      // Keyset on `(timestamp DESC, id DESC)`: rows strictly "older" than the
      // cursor — (ts < c.ts) OR (ts = c.ts AND id < c.id). An offset-free scan
      // that stays O(page) regardless of how deep the operator paginates.
      // The cursor carries the FULL-PRECISION (µs) timestamp text and is cast
      // back to `timestamptz` here, so the equality arm matches exactly (a
      // ms-truncated cursor would never equal a µs-precise column value, and
      // same-millisecond rows straddling a page boundary would be dropped).
      if (filters.cursor) {
        const cursorTs = sql`${filters.cursor.iso}::timestamptz`;
        const keyset = or(
          lt(auditLog.timestamp, cursorTs),
          and(eq(auditLog.timestamp, cursorTs), lt(auditLog.id, filters.cursor.id)),
        );
        if (keyset) conds.push(keyset);
      }

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
        .limit(filters.limit);

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
