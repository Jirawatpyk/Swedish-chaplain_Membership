/**
 * Read-only audit reader (separate from the append-only `auditRepo`).
 *
 * Backs `listRecentAuditEvents`. Tenant-scoped via `runInTenant` + the
 * `(tenant_id, timestamp DESC)` index (migration 0190). Two-layer isolation
 * (Principle I): the `audit_log_tenant_isolation` RLS policy is PERMISSIVE
 * (`tenant_id IS NULL OR tenant_id = current_setting(...)`), so legacy
 * null-tenant_id rows (F1 auth events) would surface to EVERY tenant's feed.
 * The explicit `tenant_id = ctx.slug` predicate below is the app-layer half of
 * the isolation: it excludes those null-tenant rows so the dashboard activity
 * feed shows only this tenant's events (and cannot leak once a 2nd tenant
 * onboards).
 */
import { desc, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { auditLog } from './schema';
import type { AuditEventType } from '@/modules/auth/domain/audit-event';
import type {
  AuditReadPort,
  RecentAuditEvent,
} from '../../application/use-cases/list-recent-audit-events';

export const auditReadAdapter: AuditReadPort = {
  async listRecent(ctx: TenantContext, limit: number): Promise<readonly RecentAuditEvent[]> {
    return runInTenant(ctx, async (tx) => {
      const rows = await tx
        .select({
          id: auditLog.id,
          eventType: auditLog.eventType,
          actorUserId: auditLog.actorUserId,
          targetUserId: auditLog.targetUserId,
          summary: auditLog.summary,
          occurredAt: auditLog.timestamp,
          requestId: auditLog.requestId,
        })
        .from(auditLog)
        .where(eq(auditLog.tenantId, ctx.slug))
        .orderBy(desc(auditLog.timestamp), desc(auditLog.id))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        eventType: r.eventType as AuditEventType,
        actorUserId: r.actorUserId,
        targetUserId: r.targetUserId,
        summary: r.summary,
        occurredAt: r.occurredAt,
        requestId: r.requestId,
      }));
    });
  },
};
