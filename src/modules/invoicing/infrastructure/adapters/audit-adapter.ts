/**
 * T032/F3-style audit adapter for F4.
 *
 * Inserts into the `audit_log` table with an F4 event_type, the tenant
 * slug, and a structured payload. Reuses the F1/F2/F3 audit infrastructure.
 */
import { sql } from 'drizzle-orm';
import {
  f4RetentionFor,
  type AuditPort,
  type F4AuditEvent,
} from '../../application/ports/audit-port';
import { db, type TenantTx } from '@/lib/db';
import { invoicingMetrics } from '@/lib/metrics';

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
    // T135 fix (2026-04-27): MUST set retention_years explicitly per F4
    // event-type mapping (data-model 009 § 7.2). Migration 0039 backfilled
    // EXISTING rows once; without this column on every new INSERT, post-
    // migration F4 emissions land at DB DEFAULT 5 — a silent compliance
    // regression for tax-document event types (Thai RD §87/3 statutory
    // 10y minimum). Caught by `tests/integration/payments/audit-retention-backfill.test.ts`.
    const retentionYears = f4RetentionFor(event.eventType);

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

    // T113 — cross-tenant-probe counter (alert: any non-zero rate
    // over 5 min signals an enumeration attack). Bumped for the 3
    // F4 probe event types only; every other audit type is
    // operational / transactional and doesn't need a metric tail.
    if (event.eventType === 'invoice_cross_tenant_probe') {
      invoicingMetrics.crossTenantProbe('invoice');
    } else if (event.eventType === 'credit_note_cross_tenant_probe') {
      invoicingMetrics.crossTenantProbe('credit_note');
    } else if (event.eventType === 'tenant_invoice_settings_cross_tenant_probe') {
      invoicingMetrics.crossTenantProbe('tenant_invoice_settings');
    }
  },
};
