/**
 * `RenewalAuditEmitter` — F8 audit port writing to F1's `audit_log`.
 *
 * 54 event types across 6 categories: lifecycle (20) · lapsed+bounce
 * (3) · at-risk (6) · tier-upgrade (10) · escalation (4) · cron+failure
 * (5) · admin-reactivation (6). All default to 5-year retention (F8 has
 * no tax-document overlap with F4's 10y retention).
 *
 * Enum-extension migrations co-ship with each use-case's first emit
 * site. The Drizzle adapter's `F8_ENUM_SHIPPED` set is the canonical
 * runtime list of currently-persistable event types; events outside it
 * fall through to pino-logging and loud-fail in production.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

// ---------------------------------------------------------------------------
// Event-type tuple + union
// ---------------------------------------------------------------------------

export const F8_AUDIT_EVENT_TYPES = [
  // --- Renewal lifecycle (20 — data-model.md § 4) -------------------------
  'renewal_cycle_created',
  'renewal_cycle_cancelled',
  'renewal_cycle_completed_offline',
  'renewal_lapsed',
  'renewal_reminder_sent',
  'renewal_reminder_skipped',
  'renewal_reminder_send_failed',
  'renewal_schedule_rescheduled',
  'renewal_schedule_policy_updated',
  'renewal_self_service_initiated',
  'renewal_invoice_created',
  'renewal_with_plan_change',
  'renewal_payment_failed',
  'renewal_completed',
  'renewal_completed_post_lapse',
  'renewal_token_invalid',
  'renewal_kill_switch_blocked',
  'renewal_cross_tenant_probe',
  'renewal_cross_member_probe',
  'renewal_reminder_deferred_read_only',
  // /speckit.clarify round 3 additions
  'renewal_cycle_price_frozen',
  'lapsed_member_admin_reactivated',
  'lapsed_member_admin_reactivation_rejected',
  'lapsed_member_admin_reactivation_timed_out',
  'member_auto_reactivation_blocked',
  'member_auto_reactivation_unblocked',
  // --- Lapsed + bounce (3) ------------------------------------------------
  'lapsed_member_action_blocked',
  'member_email_unverified_threshold_crossed',
  'f8_role_violation_blocked',
  // --- At-risk (6) ---------------------------------------------------------
  'at_risk_score_recomputed',
  'at_risk_score_threshold_crossed',
  'at_risk_snoozed',
  'at_risk_outreach_recorded',
  'at_risk_skipped_below_min_tenure',
  'at_risk_compute_partial_failure',
  // --- Tier upgrade (10) ---------------------------------------------------
  'tier_upgrade_suggested',
  'tier_upgrade_accepted',
  'tier_upgrade_pending_member_notified',
  'tier_upgrade_pending_admin_verification_due',
  'tier_upgrade_applied_at_renewal',
  'tier_upgrade_pending_superseded_by_manual_change',
  'tier_upgrade_dismissed',
  'tier_upgrade_already_at_target',
  'tier_upgrade_tenant_disabled',
  'tier_upgrade_skipped_no_thresholds_configured',
  // --- Escalation (4) ------------------------------------------------------
  'escalation_task_created',
  'escalation_task_completed',
  'escalation_task_skipped',
  'escalation_task_reassigned',
  // --- /speckit.critique 2026-05-03 round 1 additions (5) -----------------
  'cron_dispatch_orchestrated',
  'renewal_reminder_send_failed_permanent',
  'renewal_reminder_retried',
  'renewal_skipped_no_joined_at',
  'tier_upgrade_pending_orphan_detected',
] as const;

export type F8AuditEventType = (typeof F8_AUDIT_EVENT_TYPES)[number];

/**
 * Compile-time count check — pins the const tuple length so a typo or
 * accidental drop in `F8_AUDIT_EVENT_TYPES` becomes a build error.
 */
type _AssertF8AuditEventCount = (typeof F8_AUDIT_EVENT_TYPES)['length'] extends 54
  ? true
  : 'F8_AUDIT_EVENT_TYPES count mismatch — expected 54';
const _assertF8AuditEventCount: _AssertF8AuditEventCount = true;
// Reference the const so it isn't pruned + so future maintainers see the assertion is wired in.
void _assertF8AuditEventCount;

/** All F8 events ship with 5-year retention (no tax-doc overlap). */
export const F8_AUDIT_RETENTION_YEARS = 5 as const;

export function isF8AuditEventType(
  eventType: unknown,
): eventType is F8AuditEventType {
  return (
    typeof eventType === 'string' &&
    (F8_AUDIT_EVENT_TYPES as readonly string[]).includes(eventType)
  );
}

// ---------------------------------------------------------------------------
// Event payload + emit input
// ---------------------------------------------------------------------------

/**
 * Per-event payload shape map (F7 pattern). Typed shapes are listed for
 * the security/forensics-critical events that have stable contracts in
 * `specs/011-renewal-reminders/contracts/audit-port.md`; events not in
 * this map default to the permissive `Record<string, unknown>` so
 * use-cases that ship in later phases can refine their entries
 * incrementally without churning this file.
 *
 * The cross-tenant + cross-member probe shapes are load-bearing for
 * Constitution Principle I clause 4 (every cross-tenant access attempt
 * must be auditable) — keep them typed.
 */
export interface F8AuditPayloadShapes {
  readonly renewal_cycle_created: {
    readonly cycle_id: string;
    readonly member_id: string;
    readonly tier_bucket: string;
    readonly period_from: string;
    readonly period_to: string;
  };
  readonly renewal_cycle_cancelled: {
    readonly cycle_id: string;
    readonly member_id: string;
    readonly reason: string;
    readonly previous_status: string;
  };
  readonly renewal_cycle_completed_offline: {
    readonly cycle_id: string;
    readonly member_id: string;
    readonly invoice_id: string;
    readonly payment_method: 'bank_transfer' | 'cash' | 'cheque';
    readonly payment_reference: string;
    readonly payment_date: string;
    readonly new_expires_at: string;
  };
  readonly renewal_cross_tenant_probe: {
    readonly attempted_cycle_id: string;
    readonly route: string;
  };
  readonly renewal_cross_member_probe: {
    readonly actor_member_id: string;
    readonly attempted_member_id: string;
  };
  readonly f8_role_violation_blocked: {
    readonly resource: string;
    readonly action: 'read' | 'write';
    readonly attempted_role: 'admin' | 'manager' | 'member';
    readonly route: string;
  };
  readonly renewal_token_invalid: {
    readonly reason:
      | 'malformed_token'
      | 'mac_mismatch'
      | 'expired'
      | 'replayed'
      | 'cross_tenant'
      | 'member_not_found_in_tenant';
  };
  readonly renewal_kill_switch_blocked: {
    readonly route: string;
  };
}

/**
 * Mapped type — `F8AuditPayloadFor<'renewal_cross_tenant_probe'>`
 * resolves to the typed shape; events outside the typed-shapes map fall
 * back to `Record<string, unknown>`.
 */
export type F8AuditPayloadFor<E extends F8AuditEventType> =
  E extends keyof F8AuditPayloadShapes
    ? F8AuditPayloadShapes[E]
    : Record<string, unknown>;

export interface F8AuditEvent<E extends F8AuditEventType = F8AuditEventType> {
  readonly type: E;
  readonly payload: F8AuditPayloadFor<E>;
}

export interface AuditContext {
  readonly tenantId: string;
  /** Null for cron / system actors per audit-port.md. */
  readonly actorUserId: string | null;
  readonly actorRole:
    | 'admin'
    | 'manager'
    | 'member'
    | 'cron'
    | 'webhook'
    | 'system';
  /** OTel trace id for log+trace correlation. */
  readonly correlationId: string;
  readonly requestId?: string | null;
  /** Optional human-readable summary (truncated to 500 chars by adapter). */
  readonly summary?: string;
}

/**
 * Renewal audit emitter. Two flavours:
 *
 *   - `emit(event, ctx)` — fire-and-forget; adapter handles its own
 *     retry/swallow internally + never throws into the caller. Used
 *     by side-effects that must NOT block the use-case (e.g. probe
 *     audits inside cross-tenant detection paths).
 *
 *   - `emitInTx(tx, event, ctx)` — atomic with the surrounding state
 *     mutation per Constitution Principle VIII. Throws on failure
 *     so the caller's tx rolls back. Used by every use-case that
 *     mutates state + must guarantee state ↔ audit consistency.
 */
export interface RenewalAuditEmitter {
  emit<E extends F8AuditEventType>(
    event: F8AuditEvent<E>,
    ctx: AuditContext,
  ): Promise<void>;

  emitInTx<E extends F8AuditEventType>(
    tx: unknown,
    event: F8AuditEvent<E>,
    ctx: AuditContext,
  ): Promise<void>;
}
