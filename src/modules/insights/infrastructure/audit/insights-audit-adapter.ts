/**
 * F9 Drizzle audit adapter (T013) — implements `InsightsAuditPort`.
 *
 * Writes to F1's shared `audit_log` table via raw SQL (same pattern as the
 * F4/F5 adapters — the Drizzle `auditLog` table def does not include the
 * `retention_years` column, added by migration 0039). The F9 event types were
 * added to the `audit_event_type` enum by migration 0191 (+ 0193 added
 * `member_timeline_viewed`).
 *
 *   - `recordInTx(tx, event)` → atomic with the caller's tenant-scoped tx;
 *     bubbles any failure so the caller's tx rolls back.
 *   - `record(event)`         → best-effort auto-commit (read-side / probe);
 *     failure is logged + swallowed so it never masks the primary Result.
 *
 * No PII in payloads (FR-036 / research R12) — enforced by the typed
 * `F9AuditPayloadByType` on the port.
 */
import { sql } from 'drizzle-orm';
import { db, runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { insightsMetrics } from '@/lib/metrics';
import type {
  F9AuditEvent,
  InsightsAuditPort,
} from '../../application/ports/audit-port';

async function insertAuditRow(
  executor: TenantTx | typeof db,
  event: F9AuditEvent,
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

export const insightsAuditAdapter: InsightsAuditPort = {
  async recordInTx(txUnknown: unknown, event: F9AuditEvent): Promise<void> {
    // Atomic path — narrow the ORM-free `unknown` handle to a Drizzle tx and
    // let any failure bubble so the caller's transaction rolls back. Guard the
    // handle so an accidental null/undefined (or a non-executor object) fails
    // loudly here rather than mid-INSERT; callers MUST pass the `tx` from
    // `runInTenant` (never the global `db`) or the row escapes RLS context.
    if (
      txUnknown == null ||
      typeof (txUnknown as { execute?: unknown }).execute !== 'function'
    ) {
      throw new TypeError(
        'insightsAuditAdapter.recordInTx: expected a tenant-scoped tx executor',
      );
    }
    const tx = txUnknown as TenantTx;
    await insertAuditRow(tx, event);
  },

  async record(event: F9AuditEvent): Promise<void> {
    // Best-effort / read-side / probe path — log-and-swallow; never mask the
    // primary operation's Result with an audit-write failure. Use
    // `e.constructor.name` (not `e.message`) so Postgres errors carrying SQL
    // params / table names never reach the log (forbidden-fields hygiene). The
    // metric is the durable alert signal — pino logs roll off long before the
    // 5-year audit retention, so a swallowed write would otherwise be invisible.
    try {
      // Tenant-scoped even on the best-effort path: `runInTenant` gets a
      // connection carrying `SET LOCAL app.current_tenant`, so the row is
      // written under RLS like every other query in this module. This used to
      // reach for the pool-global `db` singleton — the one connection in
      // insights without tenant context — which is exactly what `recordInTx`
      // above forbids. The row still landed under the right tenant because
      // `tenant_id` is bound from the event, but with no second layer behind
      // it. Safe to open a transaction here: every caller is a read-side or
      // probe path, none holds a row lock (nesting under one would risk the
      // FK-child deadlock class).
      //
      // A tenant-less event has no context to set, so it keeps the plain
      // auto-commit path.
      if (event.tenantId === null) {
        await insertAuditRow(db, event);
      } else {
        await runInTenant(asTenantContext(event.tenantId), (tx) => insertAuditRow(tx, event));
      }
    } catch (e) {
      logger.error(
        {
          eventType: event.eventType,
          tenantId: event.tenantId,
          errKind: errKind(e),
        },
        'insights-audit-adapter: best-effort audit write failed (suppressed)',
      );
      insightsMetrics.auditEmitFailed(event.eventType, event.tenantId);
    }
  },
};
