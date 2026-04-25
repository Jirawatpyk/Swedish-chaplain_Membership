/**
 * T067 — F5 Drizzle audit adapter.
 *
 * Implements the F5 `AuditPort`. Writes to F1's shared `audit_log`
 * table (schema in `src/modules/auth/infrastructure/db/schema.ts`
 * line 278) via raw SQL — same pattern as F4's audit-adapter (which
 * also writes raw SQL because the Drizzle `auditLog` table
 * definition does not include the F5-added `retention_years`
 * column, added by migration 0039).
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
  F5AuditEventType,
} from '../../application/ports/audit-port';
import { db, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Retention-year mapping for all 19 F5 audit event types — 17 from
 * the original migration 0040 + 2 webhook ops-visibility events from
 * migration 0046 (audit 2026-04-25 findings #10/#13).
 *
 * (data-model.md § 7.1). Used for assertion + documentation — the
 * `emit` caller passes `retentionYears` on the event object, but
 * the `F5AuditEvent.retentionYears` field is authoritative. This
 * table lets a unit/contract test verify the union is exhaustive
 * and helps future reviewers spot a mis-categorised event.
 *
 * Audit 2026-04-25 finding #17: Record<F5AuditEventType, ...> exhaustiveness
 * gives compile-time enforcement that every union member has a retention
 * mapping — adding a new event type to the union forces this map to
 * grow in lockstep.
 */
export const F5_AUDIT_RETENTION_YEARS: Record<F5AuditEventType, 5 | 10> = {
  // 10-year: mutations on payment/refund state + stale-refund trail.
  // Each of these either creates or modifies a tax-document-adjacent
  // record (the invoice or CN the payment settles against).
  payment_initiated: 10,
  payment_succeeded: 10,
  payment_failed: 10,
  payment_canceled: 10,
  payment_auto_refunded_stale_invoice: 10,
  payment_auto_refunded_concurrent_manual_mark: 10,
  refund_initiated: 10,
  refund_succeeded: 10,
  refund_failed: 10,
  out_of_band_refund_detected: 10,
  dispute_created: 10,

  // 5-year: operational + probe + environment + config surfaces
  // (no direct tax-document touch).
  payment_environment_mismatch: 5,
  payment_cross_tenant_probe: 5,
  webhook_signature_rejected: 5,
  webhook_api_version_mismatch: 5,
  tenant_payment_settings_updated: 5,
  online_payment_toggled: 5,
  // Audit 2026-04-25 findings #10 + #13 — webhook ops-visibility events
  // (migration 0046). Operational signals only, no tax-document touch.
  webhook_unknown_intent: 5,
  webhook_payment_already_canceled: 5,
  // Review I-14 (migration 0047) — confirmPayment retrievePaymentIntent
  // failure trail. Operational only.
  payment_processor_retrieve_failed: 5,
  // Review S5 (migration 0048) — confirmPayment invoice_not_found trail.
  payment_invoice_not_found: 5,
};

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
    try {
      await insertAuditRow(db, event);
    } catch (e) {
      logger.error(
        {
          eventType: event.eventType,
          tenantId: event.tenantId,
          err: e instanceof Error ? e.message : String(e),
        },
        'f5-audit-adapter: probe-path audit write failed (suppressed)',
      );
    }
  },
};
