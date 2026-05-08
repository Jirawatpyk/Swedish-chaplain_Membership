/**
 * Drizzle adapter for F8 `RenewalAuditEmitter`.
 *
 * Persists F8 events to F1's `audit_log` for event types present in
 * the `audit_event_type` pgEnum (see `F8_ENUM_SHIPPED` below — the
 * canonical runtime list, kept in sync with enum-extension migrations).
 * Events outside that set fall through to pino-logging via
 * `pinoFallback` and loud-fail in production so a misconfigured emit
 * site never silently drops audit data.
 *
 * Behaviour:
 *   - `emit(event, ctx)`: own runInTenant tx; never throws to caller
 *     (fire-and-forget; probe audits depend on this contract).
 *   - `emitInTx(tx, event, ctx)`: writes inside supplied tx so state
 *     + audit commit atomically (Constitution Principle VIII).
 *
 * NULL `retention_years` lets the DB trigger apply the F8 default of
 * 5 years — we don't override.
 */
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { logger } from '@/lib/logger';
import {
  isF8AuditEventType,
  type AuditContext,
  type F8AuditEvent,
  type F8AuditEventType,
  type RenewalAuditEmitter,
} from '../../application/ports/renewal-audit-emitter';
import type { AuditLogInsert } from '@/modules/auth/infrastructure/db/schema';

/**
 * F8 event types whose pgEnum value exists today. Each entry MUST
 * have a corresponding `ALTER TYPE "audit_event_type" ADD VALUE` in a
 * shipped migration. Events not in this set fall through to pino-
 * logging (loud-fail in production).
 *
 * Migration 0099 ships the 4 events emitted by Phase 3 use-cases:
 *   - `renewal_cycle_cancelled`            (cancel-cycle.ts)
 *   - `renewal_cycle_completed_offline`    (mark-paid-offline.ts)
 *   - `renewal_cross_tenant_probe`         (3 use-cases probe path)
 *   - `f8_role_violation_blocked`          (renewals-route-helpers)
 *   - `renewal_schedule_policy_updated`    (update-schedule-policy.ts —
 *                                           Phase 4 Wave I1a, migration 0101)
 *   - `escalation_task_completed`          (reset-email-unverified.ts —
 *                                           Phase 4 Wave I2b, migration 0102;
 *                                           also emitted by Wave I8+ admin
 *                                           task-queue UI)
 *   - 8 dispatcher events                   (dispatch-one-cycle.ts —
 *                                           Phase 4 Wave I2c, migration 0103):
 *       - `renewal_reminder_sent`
 *       - `renewal_reminder_skipped`
 *       - `renewal_reminder_send_failed`
 *       - `renewal_reminder_send_failed_permanent`
 *       - `renewal_reminder_retried` (emitted by `retry-failed-reminders.ts`)
 *       - `renewal_reminder_deferred_read_only`
 *       - `renewal_skipped_no_joined_at`
 *       - `escalation_task_created` (also second emit site = task channel)
 *
 * `renewal_cycle_created` is RESERVED for a future cycle-creation
 * hook (F4 invoice-paid callback wiring — `markCycleCompleteFromInvoicePaid`
 * use-case in `f8OnPaidCallbacks`). NOT in `F8_ENUM_SHIPPED` until
 * that emit site + ADD VALUE migration lands; see the spec backlog
 * (FR-006) for the deferral target.
 */
const F8_ENUM_SHIPPED: ReadonlySet<F8AuditEventType> = new Set([
  'renewal_cycle_cancelled',
  'renewal_cycle_completed_offline',
  'renewal_cross_tenant_probe',
  'f8_role_violation_blocked',
  'renewal_schedule_policy_updated',
  'escalation_task_completed',
  'renewal_reminder_sent',
  'renewal_reminder_skipped',
  'renewal_reminder_send_failed',
  'renewal_reminder_send_failed_permanent',
  'renewal_reminder_retried',
  'renewal_reminder_deferred_read_only',
  'renewal_skipped_no_joined_at',
  'escalation_task_created',
  // --- Wave I2d (migration 0104) ----------------------------------------
  'member_email_unverified_threshold_crossed',
  // --- Wave I5 (migration 0107) -----------------------------------------
  'cron_dispatch_orchestrated',
  // --- Phase 5 Wave A.5 US3 emit sites (T120) ----------------------------
  // Migration 0109 adds 21 enum values to the DB so future Phase 5 tasks
  // can emit without a per-task migration. F8_ENUM_SHIPPED only lists
  // values whose emit site EXISTS in code today.
  'renewal_token_invalid',
  'renewal_token_clicked_on_completed_cycle',
  'renewal_self_service_initiated',
  // --- Phase 5 Wave A US3 emit sites (T135 + T136) -----------------------
  // T135 block/unblock-auto-reactivation use-cases emit on actual flag
  // change (idempotent re-toggle skips the audit row). T136 emits on
  // pending → completed admin approval transition.
  'member_auto_reactivation_blocked',
  'member_auto_reactivation_unblocked',
  'lapsed_member_admin_reactivated',
  // --- Phase 5 Wave A.5 US3 emit sites (T137) ---------------------------
  // T137 admin-reject-reactivation transitions pending → cancelled with
  // closed_reason='admin_rejected_with_refund' + cascades F5 refund +
  // F4 credit-note via the F5RefundBridge port. Audit payload carries
  // the credit-note ID for forensic chain (null when no payment to
  // refund). Companion T138 reuses the same emit site for cron-driven
  // 30-day auto-timeout cancellations (different actor=cron / null userId).
  'lapsed_member_admin_reactivation_rejected',
  // --- Phase 5 Wave B US3 emit sites (T123 + T138) ----------------------
  // T123 markCycleCompleteFromInvoicePaid emits `renewal_completed`
  // (default auto-complete) or `renewal_completed_post_lapse` (admin-
  // blocked → held in pending_admin_reactivation). T138 cron emits the
  // 3 reminder ladder events + the timed_out cancel event.
  'renewal_completed',
  'renewal_completed_post_lapse',
  'lapsed_member_admin_reactivation_timed_out',
  'lapsed_member_admin_reactivation_reminder_t-7',
  'lapsed_member_admin_reactivation_reminder_t-3',
  'lapsed_member_admin_reactivation_reminder_t-1',
  // --- Phase 5 Wave B US3 emit sites (T122 confirm-renewal) -------------
  // confirm-renewal emits `renewal_invoice_created` on every successful
  // F4 invoice issue, plus `renewal_with_plan_change` +
  // `renewal_cycle_price_frozen` when the optional plan-change branch
  // fires (FR-021b atomic frozen-price update).
  'renewal_invoice_created',
  'renewal_with_plan_change',
  'renewal_cycle_price_frozen',
  // --- Phase 5 Wave K24 US3 emit site (T115a lapseCyclesOnGraceExpiry) ---
  // Daily cron transitions awaiting_payment → lapsed once
  // `expires_at + grace_period_days < now`. Decision branch picks
  // `closed_reason='grace_expired'` (zero F5 failed attempts) vs
  // `payment_failed` (>=1 F5 row with status='failed'). Typed payload
  // carries `closed_reason` discriminant + `failed_payment_attempts`
  // forensic count. pgEnum value 'renewal_lapsed' was added in F8 phase
  // setup migrations (Phase 1-2); no new ADD VALUE migration needed.
  'renewal_lapsed',
  // --- Phase 6 Wave F US4 emit sites (T154-T156, T161) -----------------
  // Migration 0111 adds these 6 enum values to the DB so the Phase 6
  // at-risk surfaces persist their audits instead of falling through
  // to pino. All 6 events were already in the F8_AUDIT_EVENT_TYPES
  // const tuple (count 59 unchanged) per Phase 2 Wave A2.
  'at_risk_score_recomputed',
  'at_risk_score_threshold_crossed',
  'at_risk_snoozed',
  'at_risk_outreach_recorded',
  'at_risk_skipped_below_min_tenure',
  'at_risk_compute_partial_failure',
]);

function buildSummary<E extends F8AuditEventType>(
  event: F8AuditEvent<E>,
  ctx: AuditContext,
): string {
  const base = ctx.summary?.trim();
  if (base && base.length > 0) {
    return base.slice(0, 500);
  }
  // Default summary mirrors F4 audit-adapter convention.
  return `F8 ${event.type} (tenant=${ctx.tenantId})`.slice(0, 500);
}

/**
 * Defensive `Object.keys` for audit payloads. `Object.keys(null)` and
 * `Object.keys(undefined)` throw TypeError; the audit-emit catch path
 * MUST NOT throw inside its own diagnostic logging or it masks the
 * original signal. Returns `[]` for null/undefined/non-object payloads.
 */
function payloadKeysOf(payload: unknown): readonly string[] {
  if (payload == null || typeof payload !== 'object') return [];
  return Object.keys(payload as Record<string, unknown>);
}

function pinoFallback<E extends F8AuditEventType>(
  event: F8AuditEvent<E>,
  ctx: AuditContext,
  reason: 'not_in_pgenum' | 'unknown_event_type',
): void {
  // Production guard — same property the stub asserts. F8 ships dark
  // behind FEATURE_F8_RENEWALS=false until MVP-wide go-live; if we ever
  // emit a non-enum event in production the audit-trail invariant
  // (Principle VIII) silently breaks.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `F8 audit emit fell through to pino in production (event=${event.type}, reason=${reason}). ` +
        'Add the event to the audit_event_type pgEnum migration before flipping FEATURE_F8_RENEWALS=true.',
    );
  }
  // Emit at WARN so CI / staging log-based alerts trip on emit-site drift
  // (an INFO log would blend into normal traffic). Log payload KEYS only
  // — never values — so a future PII-bearing event never leaks raw.
  logger.warn(
    {
      f8AuditFallthrough: true,
      reason,
      eventType: event.type,
      tenantId: ctx.tenantId,
      actorRole: ctx.actorRole,
      correlationId: ctx.correlationId,
      payloadKeys: payloadKeysOf(event.payload),
    },
    'F8 audit emit fell back to pino — event type not in pgEnum yet',
  );
}

function buildInsertValues<E extends F8AuditEventType>(
  event: F8AuditEvent<E>,
  ctx: AuditContext,
): AuditLogInsert {
  return {
    // event.type narrows to the F8AuditEventType union; the
    // auditEventTypeEnum union in the Drizzle schema includes these
    // values after migration 0099. Cast through the canonical enum
    // type for safety.
    eventType: event.type as AuditLogInsert['eventType'],
    actorUserId: ctx.actorUserId ?? `system:${ctx.actorRole}`,
    summary: buildSummary(event, ctx),
    requestId: ctx.requestId ?? ctx.correlationId,
    tenantId: ctx.tenantId,
    payload: event.payload,
    // timestamp + id default at DB layer (defaultRandom + defaultNow).
  };
}

export function makeDrizzleRenewalAuditEmitter(
  tenant: TenantContext,
): RenewalAuditEmitter {
  return {
    async emit<E extends F8AuditEventType>(
      event: F8AuditEvent<E>,
      ctx: AuditContext,
    ): Promise<void> {
      // Pre-flight enum checks run OUTSIDE the try/catch so the
      // production-mode loud-fail in `pinoFallback` propagates to the
      // caller — that throw exists specifically to detect emit-site
      // drift before flag-flip and MUST NOT be swallowed.
      // The fire-and-forget contract still applies to runtime DB faults
      // (RLS misconfig, infra outage), which are caught + logged below.
      if (!isF8AuditEventType(event.type)) {
        pinoFallback(event, ctx, 'unknown_event_type');
        return;
      }
      if (!F8_ENUM_SHIPPED.has(event.type)) {
        pinoFallback(event, ctx, 'not_in_pgenum');
        return;
      }
      try {
        await runInTenant(tenant, async (tx) => {
          await tx.insert(auditLog).values(buildInsertValues(event, ctx));
        });
      } catch (e) {
        // Forensic log — fire-and-forget contract swallows the throw,
        // but the log line is the ONLY signal that audit data was lost,
        // so capture full diagnostic context (Sentry triage 6 months
        // later depends on it). Never include raw event.payload here —
        // payload keys only.
        logger.error(
          {
            err: e,
            errCode:
              e instanceof Error && 'code' in e
                ? (e as { code?: string }).code
                : undefined,
            eventType: event.type,
            tenantId: ctx.tenantId,
            actorUserId: ctx.actorUserId,
            actorRole: ctx.actorRole,
            correlationId: ctx.correlationId,
            requestId: ctx.requestId,
            payloadKeys: payloadKeysOf(event.payload),
          },
          'F8 audit emit DB insert failed (fire-and-forget swallowed)',
        );
      }
    },

    async emitInTx<E extends F8AuditEventType>(
      tx: unknown,
      event: F8AuditEvent<E>,
      ctx: AuditContext,
    ): Promise<void> {
      // emitInTx MUST throw on any failure mode — caller relies on the
      // throw to roll back the surrounding state mutation (Principle VIII).
      // Both pre-flight enum checks throw explicitly here (NOT just via
      // pinoFallback's prod-only throw) so a misconfigured emit site
      // also rolls back atomically — the alternative (pinoFallback;
      // return) would silently commit the state mutation without an
      // audit row in dev/staging where pinoFallback warns rather than
      // throws, breaking the state↔audit invariant.
      if (!isF8AuditEventType(event.type)) {
        pinoFallback(event, ctx, 'unknown_event_type');
        throw new Error(
          `emitInTx: event type '${event.type}' is not a known F8 audit event — refusing to commit state mutation without atomic audit row`,
        );
      }
      if (!F8_ENUM_SHIPPED.has(event.type)) {
        pinoFallback(event, ctx, 'not_in_pgenum');
        throw new Error(
          `emitInTx: event type '${event.type}' is not yet in the audit_event_type pgEnum — ship its migration before atomic emit`,
        );
      }
      const txDb = tx as typeof db;
      await txDb.insert(auditLog).values(buildInsertValues(event, ctx));
    },
  };
}

