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
 * Type-only cross-module imports for branded IDs (zero runtime cost)
 * so emit sites construct payloads with type-safe IDs rather than bare
 * strings — silent ID swaps (member_id ↔ user_id) become compile errors.
 */
import type { TenantTx } from '@/lib/db';
import type { CycleId } from '../../domain/renewal-cycle';
import type { SuggestionId } from '../../domain/tier-upgrade-suggestion';
import type { Sha256Hex } from '../../domain/value-objects/sha256-hex';
import type { MemberId, MemberPlanId as PlanId } from '@/modules/members';
import type { UserId } from '@/modules/auth/domain/branded';
import type { InvoiceId } from '@/modules/invoicing';
import type { CreditNoteId } from '@/modules/invoicing';

// Re-export the moved Sha256Hex brand so existing callers via the
// audit-emitter port keep working until they migrate to the Domain
// import path.
export type { Sha256Hex } from '../../domain/value-objects/sha256-hex';
export {
  asSha256Hex,
  parseSha256Hex,
} from '../../domain/value-objects/sha256-hex';

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
// ---------------------------------------------------------------------------
// Audit-payload value-object brands
// ---------------------------------------------------------------------------

/**
 * `at_risk_score_threshold_crossed` requires `previous_band !== new_band`
 * — emitting "low → low" would be forensic noise. The DU below encodes
 * the 12 valid 4×4-with-self-excluded transitions at compile time, so
 * `{ previous_band: 'low', new_band: 'low' }` is a TS error rather than
 * a runtime invariant probe.
 */
export type AtRiskBand = 'low' | 'medium' | 'high' | 'critical';

export type BandTransition =
  | { readonly previous_band: 'low'; readonly new_band: 'medium' | 'high' | 'critical' }
  | { readonly previous_band: 'medium'; readonly new_band: 'low' | 'high' | 'critical' }
  | { readonly previous_band: 'high'; readonly new_band: 'low' | 'medium' | 'critical' }
  | { readonly previous_band: 'critical'; readonly new_band: 'low' | 'medium' | 'high' };

export interface F8AuditPayloadShapes {
  readonly renewal_cycle_created: {
    readonly cycle_id: CycleId;
    readonly member_id: MemberId;
    readonly tier_bucket: string;
    readonly period_from: string;
    readonly period_to: string;
  };
  readonly renewal_cycle_cancelled: {
    readonly cycle_id: CycleId;
    readonly member_id: MemberId;
    readonly reason: string;
    readonly previous_status: string;
  };
  readonly renewal_cycle_completed_offline: {
    readonly cycle_id: CycleId;
    readonly member_id: MemberId;
    readonly invoice_id: InvoiceId;
    readonly payment_method: 'bank_transfer' | 'cash' | 'cheque';
    readonly payment_reference: string;
    readonly payment_date: string;
    readonly new_expires_at: string;
  };
  readonly renewal_cross_tenant_probe: {
    readonly attempted_cycle_id: CycleId;
    readonly route: string;
  };
  readonly renewal_cross_member_probe: {
    readonly actor_member_id: MemberId;
    readonly attempted_member_id: MemberId;
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
  readonly tier_upgrade_suggested: {
    readonly suggestion_id: SuggestionId;
    readonly member_id: MemberId;
    readonly from_plan_id: PlanId;
    readonly to_plan_id: PlanId;
    readonly reason_code:
      | 'declared_turnover_above_threshold'
      | 'paid_invoice_volume_above_threshold'
      | 'multi_signal';
  };
  readonly tier_upgrade_pending_superseded_by_manual_change: {
    readonly suggestion_id: SuggestionId;
    readonly superseded_from_status: 'open' | 'accepted_pending_apply';
    readonly manual_change_actor_user_id: UserId;
    readonly superseding_plan_id: PlanId;
  };
  /**
   * The `BandTransition` DU prevents emitting same-band "transitions"
   * at compile time (e.g. `{ previous_band: 'low', new_band: 'low' }`
   * would be a TS error — there's no arm matching that pair). `score`
   * is the absolute new score, not a delta.
   */
  readonly at_risk_score_threshold_crossed: BandTransition & {
    readonly member_id: MemberId;
    readonly score: number;
  };
  /**
   * Discriminated union — `renewal_reminder_send_failed_permanent`
   * fires from THREE distinct emit sites, each with its own payload
   * shape:
   *
   *   1. **Bounce-classification path** — F1 webhook → T090 detect-
   *      bounce-threshold → permanent flag flip. Carries
   *      `bounce_class` from Resend's classification.
   *
   *   2. **Dispatcher 4xx path** — `dispatchOneCycle` (T088/T089)
   *      gateway returns 4xx / recipient-unsubscribed / unverified
   *      / template-vars-missing → permanent first-attempt failure.
   *      Carries `via_retry_exhaustion: false`.
   *
   *   3. **Retry-exhaustion path** — Wave I2e `retryFailedReminders`
   *      transitions an event to permanent after the 24h budget
   *      expires (Pass 2) OR a retry attempt itself returns a
   *      permanent gateway error (Pass 1 became_permanent). Carries
   *      `via_retry_exhaustion: true`.
   *
   * Consumers can discriminate on the presence of `bounce_class`
   * (path 1) vs `via_retry_exhaustion` (paths 2+3).
   */
  readonly renewal_reminder_send_failed_permanent:
    | {
        // Path 1 — bounce-detected (T090 → permanent flag flip)
        readonly cycle_id: CycleId;
        readonly step_id: string;
        readonly recipient_email_hashed: Sha256Hex;
        readonly bounce_class:
          | 'hard_bounce'
          | 'spam_complaint'
          | 'invalid_address';
        readonly provider_message_id: string | null;
      }
    | {
        // Paths 2 + 3 — dispatcher 4xx OR retry exhaustion (Wave I2c+I2e)
        readonly cycle_id: CycleId;
        readonly member_id: MemberId;
        readonly step_id: string;
        readonly channel: 'email' | 'task';
        readonly template_id: string | null;
        /**
         * J9-M17: closed set of gateway-error classifiers.
         * Previously typed as bare `string` which silently accepted
         * typos (e.g. `'gateway_500'`) + made forensic queries
         * unreliable. Mirrors `DispatchFailureKind` from
         * dispatch-one-cycle.ts.
         */
        readonly failure_kind:
          | 'gateway_5xx'
          | 'gateway_4xx'
          | 'recipient_unsubscribed'
          | 'recipient_email_unverified'
          | 'template_variables_missing'
          | 'dispatcher_crash';
        readonly failure_message: string | null;
        readonly via_retry_exhaustion: boolean;
        readonly retry_until?: string | null;
        readonly escalation_task_id?: string | null;
      };
  readonly lapsed_member_admin_reactivation_rejected: {
    readonly cycle_id: CycleId;
    readonly actor_user_id: UserId;
    readonly refund_credit_note_id: CreditNoteId | null;
  };
  readonly lapsed_member_admin_reactivation_timed_out: {
    readonly cycle_id: CycleId;
    /** Null because the actor is the cron, not a human admin. */
    readonly actor_user_id: null;
  };
  /**
   * J9-M14 — `cron_dispatch_orchestrated` audit shape (previously fell
   * through to `Record<string, unknown>`). This is the single
   * operational record of every daily F8 cron run: SLO calculations,
   * compliance trail, dashboards all read from it. Pinning the shape
   * makes typo-driven divergence (e.g. someone emitting
   * `tenants_succeded` with one s) a compile error.
   *
   * `per_tenant_summaries` carries bounded-cardinality outcome rows
   * (≤ MVP single tenant; post-F10 multi-tenant ≤ ~hundreds). Two
   * variants per tenant: success (with metric counters) or error (with
   * a string error code from the failure-kind enum). Discriminate on
   * the presence of `error` (lookup the literal first).
   */
  readonly cron_dispatch_orchestrated: {
    readonly tenants_enqueued: number;
    readonly tenants_succeeded: number;
    readonly tenants_failed: number;
    readonly duration_ms: number;
    readonly per_tenant_summaries: ReadonlyArray<
      | {
          readonly tenant_id: string;
          readonly error: string;
        }
      | {
          readonly tenant_id: string;
          readonly skipped: boolean;
          readonly reminders_dispatched: number;
          readonly tasks_created: number;
          readonly duration_ms: number;
        }
    >;
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

/**
 * J9-M15 — single source-of-truth for the F8 actor-role enum.
 * Previously duplicated in three sites (`AuditContext.actorRole` 6
 * values; `DispatchContext.actorRole` 2 values; `DetectBounceThreshold
 * Input.actorRole` 2 values). Each narrower context defines its own
 * subset by intersecting/picking from this union — no single source of
 * truth meant a 7th value (e.g. `'service-account'` for a future
 * non-human SaaS-provisioning actor) would have to be added in three
 * places, easy to miss.
 *
 * The union covers every observed F8 actor:
 *   - `admin` / `manager` / `member` — F1 RBAC roles
 *   - `cron` — daily dispatch / retry-pass / coordinator (no UserId)
 *   - `webhook` — F1 Resend webhook → F8 bounce hook (no UserId)
 *   - `system` — replays + bookkeeping + tests
 */
export type RenewalActorRole =
  | 'admin'
  | 'manager'
  | 'member'
  | 'cron'
  | 'webhook'
  | 'system';

export interface AuditContext {
  readonly tenantId: string;
  /** Null for cron / system actors per audit-port.md. */
  readonly actorUserId: string | null;
  readonly actorRole: RenewalActorRole;
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
    tx: TenantTx,
    event: F8AuditEvent<E>,
    ctx: AuditContext,
  ): Promise<void>;
}
