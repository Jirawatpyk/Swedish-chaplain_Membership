/**
 * F7 audit adapter — mirrors the F4 implementation pattern.
 *
 * Inserts into the `audit_log` table with an F7 event_type, the tenant
 * slug, structured payload, and explicit retention_years (always 5y for
 * F7 — no tax-document overlap). Reuses the F1/F2/F3/F4 audit
 * infrastructure (same `audit_log` table, same `audit_event_type`
 * enum extended by migration 0072).
 *
 * `tx` semantics:
 *   - non-null Drizzle tx → atomic with the caller's mutation
 *   - null tx → standalone INSERT on `db` (auto-commit), used for
 *     read-path probe audits (cross-tenant) where the outer path is
 *     read-only. Trail is best-effort: if the standalone INSERT fails,
 *     caller logs + continues — does NOT 5xx the request.
 */
import { sql } from 'drizzle-orm';
import {
  f7RetentionFor,
  type AuditEmitInput,
  type AuditPort,
} from '../application/ports/audit-port';
import { db, type TenantTx } from '@/lib/db';

export const f7AuditAdapter: AuditPort = {
  async emit(txUnknown: unknown, event: AuditEmitInput): Promise<void> {
    const tx = (txUnknown as TenantTx | null) ?? db;
    const requestId = event.requestId ?? 'no-request-id';
    const retentionYears = f7RetentionFor(event.eventType);

    await tx.execute(sql`
      INSERT INTO audit_log
        (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
      VALUES
        (${event.eventType}::audit_event_type,
         ${event.actorUserId},
         ${event.summary},
         ${requestId},
         ${JSON.stringify(event.payload)}::jsonb,
         ${event.tenantId},
         ${retentionYears})
    `);
  },
};
