/**
 * F9 US2 — `AuditEventSource` adapter (binds to the auth-owned reader).
 *
 * Reads `audit_log` via the auth PUBLIC BARREL (`auditQueryReadAdapter`) — no
 * deep/foreign-table imports (Principle III). The auth reader self-scopes
 * (`runInTenant`) + enforces the two-layer tenant isolation; this adapter only
 * maps the public input filters onto the reader's contract.
 */
import { auditQueryReadAdapter, type AuditEventType } from '@/modules/auth';
import type { TenantContext } from '@/modules/tenants';
import type {
  AuditEventSource,
  AuditSourceFilters,
  AuditSourceRow,
} from '../../application/ports/audit-source';

export const auditEventSourceAdapter: AuditEventSource = {
  async query(
    ctx: TenantContext,
    filters: AuditSourceFilters,
  ): Promise<readonly AuditSourceRow[]> {
    // `eventType` arrives as `string[]` from the query string; the reader types
    // it as `AuditEventType[]`. Cast at this boundary — an unknown label simply
    // matches no rows (the inArray predicate), it cannot widen the result set.
    const rows = await auditQueryReadAdapter.query(ctx, {
      limit: filters.limit,
      ...(filters.eventType
        ? { eventType: filters.eventType as readonly AuditEventType[] }
        : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.targetUserId ? { targetUserId: filters.targetUserId } : {}),
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      ...(filters.cursor ? { cursor: filters.cursor } : {}),
      ...(filters.direction ? { direction: filters.direction } : {}),
    });
    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      actorUserId: r.actorUserId,
      targetUserId: r.targetUserId,
      summary: r.summary,
      occurredAt: r.occurredAt,
      occurredAtIso: r.occurredAtIso,
      requestId: r.requestId,
      payload: r.payload,
    }));
  },
};
