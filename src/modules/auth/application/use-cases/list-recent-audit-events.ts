/**
 * Auth `listRecentAuditEvents` read use-case.
 *
 * Returns the last N audit events for the current tenant, newest-first — the
 * data behind F9's near-real-time dashboard activity feed (FR-003). Read-only;
 * kept separate from the deliberately append-only `auditRepo`. Tenant isolation
 * is enforced by the `audit_log_tenant_isolation` RLS policy inside the reader's
 * `runInTenant`. (US2's richer filterable `auditQuery` will coexist / generalise.)
 */
import { ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditEventType } from '../../domain/audit-event';

export interface RecentAuditEvent {
  readonly id: string;
  readonly eventType: AuditEventType;
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly summary: string;
  readonly occurredAt: Date;
  readonly requestId: string;
}

export interface AuditReadPort {
  listRecent(ctx: TenantContext, limit: number): Promise<readonly RecentAuditEvent[]>;
}

export interface ListRecentAuditEventsDeps {
  readonly auditRead: AuditReadPort;
}

export async function listRecentAuditEvents(
  input: { readonly limit?: number },
  ctx: TenantContext,
  deps: ListRecentAuditEventsDeps,
): Promise<Result<readonly RecentAuditEvent[], never>> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  return ok(await deps.auditRead.listRecent(ctx, limit));
}
