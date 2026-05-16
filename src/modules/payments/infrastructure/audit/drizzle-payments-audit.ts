/**
 * T067 — F5 Drizzle audit adapter.
 *
 * Implements the F5 `AuditPort`. Writes to F1's shared `audit_log`
 * table (see `auditLog` pgTable in
 * `src/modules/auth/infrastructure/db/schema.ts`) via raw SQL —
 * same pattern as F4's audit-adapter (which also writes raw SQL
 * because the Drizzle `auditLog` table definition does not include
 * the F5-added `retention_years` column, added by migration 0039).
 * (R3 comment-rot fix: symbolic ref replaces precise line number
 * that rotted past F1+F4+F5 schema additions.)
 *
 * tx semantics (mirror F4):
 *   - `tx != null` → write inside caller's tenant-scoped tx so the
 *     audit row commits atomically with the state change.
 *   - `tx === null` → probe/best-effort path (e.g. cross-tenant
 *     probe attempted from a read-only surface). Writes on the
 *     root `db` connection; any error is logged but re-throw is
 *     suppressed so the primary operation's Result is preserved.
 *
 * retention_years:
 *   - 10 years for events that touch Thai tax documents or refund
 *     records (statutory retention per Thai RD §87/3 + §86/10).
 *   - 5 years for environmental, probe, webhook-reject, and
 *     operational-only events (PDPA default).
 *   - See data-model.md § 7.1 + migration 0039 for full mapping.
 */
import { sql } from 'drizzle-orm';
import type {
  AuditPort,
  F5AuditEvent,
} from '../../application/ports/audit-port';
import {
  F5_AUDIT_RETENTION_YEARS,
  retentionFor,
} from '../../application/ports/audit-port';
import { db, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { paymentsMetrics } from '@/lib/metrics';

// Re-export so existing callers/tests that import these from the
// infrastructure adapter keep working. Authoritative source lives in
// `application/ports/audit-port.ts` (Clean Architecture: pure data on
// the port, no Drizzle/SQL imports needed to consume it).
export { F5_AUDIT_RETENTION_YEARS, retentionFor };


async function insertAuditRow(
  executor: TenantTx | typeof db,
  event: F5AuditEvent,
): Promise<void> {
  const requestId = event.requestId ?? 'no-request-id';
  await executor.execute(sql`
    INSERT INTO audit_log
      (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
    VALUES
      (${event.eventType}::audit_event_type,
       ${event.actorUserId},
       ${event.summary},
       ${requestId},
       ${JSON.stringify(event.payload)}::jsonb,
       ${event.tenantId},
       ${event.retentionYears})
  `);
}

export const f5AuditAdapter: AuditPort = {
  async emit(txUnknown: unknown, event: F5AuditEvent): Promise<void> {
    const tx = (txUnknown as TenantTx | null) ?? null;

    if (tx !== null) {
      // Atomic path — bubble any failure so the caller's tx rolls back.
      await insertAuditRow(tx, event);
      return;
    }

    // Probe / best-effort path — log-and-swallow; never mask the
    // primary Result with an audit-write failure.
    //
    // F5R2-SF-5 — bump `useCaseAuditEmitFailed` counter so SRE can
    // alert on chronic audit-rail outages affecting the 11+
    // Application-layer null-tx call sites (cross-tenant probes,
    // give-up forensic, cancel-attempt-failed). Pre-fix only the
    // pino log fired; pino rolls off in 30 days so a sustained
    // outage silently dropped the 5/10y forensic compliance trail.
    // F5R2-H3 — `e.message` from Postgres can carry SQL params /
    // table names. Use `e.constructor.name` instead.
    try {
      await insertAuditRow(db, event);
    } catch (e) {
      paymentsMetrics.useCaseAuditEmitFailed(event.eventType);
      logger.error(
        {
          eventType: event.eventType,
          tenantId: event.tenantId,
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
        },
        'f5-audit-adapter: probe-path audit write failed (suppressed)',
      );
    }
  },
};
