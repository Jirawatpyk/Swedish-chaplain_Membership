/**
 * T032/F3-style audit adapter for F4.
 *
 * Inserts into the `audit_log` table with an F4 event_type, the tenant
 * slug, and a structured payload. Reuses the F1/F2/F3 audit infrastructure.
 */
import { sql } from 'drizzle-orm';
import type { AuditPort, F4AuditEvent } from '../../application/ports/audit-port';
import { db, type TenantTx } from '@/lib/db';

export const f4AuditAdapter: AuditPort = {
  async emit(
    txUnknown: unknown,
    event: F4AuditEvent & { tenantId: string; requestId: string | null },
  ): Promise<void> {
    // Null-tx means "emit standalone" — used by read-path cross-tenant
    // probe audit where the outer path is read-only and we just want
    // the trail. We still write with the app role, not BYPASSRLS.
    const tx = (txUnknown as TenantTx | null) ?? db;

    const requestId = event.requestId ?? 'no-request-id';

    await tx.execute(sql`
      INSERT INTO audit_log
        (event_type, actor_user_id, summary, request_id, payload, tenant_id)
      VALUES
        (${event.eventType}::audit_event_type,
         ${event.actorUserId},
         ${event.summary},
         ${requestId},
         ${JSON.stringify(event.payload)}::jsonb,
         ${event.tenantId})
    `);
  },
};
