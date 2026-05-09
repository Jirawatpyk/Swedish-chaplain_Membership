/**
 * `RenewalAuditEmitter` — F8 audit port writing to F1's `audit_log`.
 *
 * The canonical event-type list is `F8_AUDIT_EVENT_TYPES` below — its
 * `length` is pinned by `_AssertF8AuditEventCount`, so the count
 * stays compile-enforced rather than narrative. All F8 events default
 * to 5-year retention (no tax-document overlap with F4's 10y).
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
import type { RiskBand } from '../../domain/value-objects/risk-band';
import type {
  AT_RISK_FACTOR_WEIGHTS,
  F6_ACTIVE_MAX,
  F6_INACTIVE_MAX,
} from '../../domain/at-risk-score';
import type { OutreachId } from '../../domain/at-risk-outreach';
import type { MemberId, PlanId } from '@/modules/members';
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
  // Round 4 verify-fix (D1) / Round 5 staff-review (R004): RESERVED but
  // currently NOT EMITTED by any production code path. F8 listens only
  // to F4's `invoice_marked_paid` event via `f8OnPaidCallbacks`; the
  // F5 payment_failed branch leaves the F4 invoice in `issued` so the
  // callback never fires (cycle stays in `awaiting_payment` and the
  // reminder schedule resumes — verified by
  // `tests/integration/renewals/self-service-renewal-tx.test.ts` D1
  // case). Tracked as **OOS-18** in `specs/011-renewal-reminders/spec.md`
  // — F5 → F8 payment_failed listener bridge is post-MVP. When the
  // bridge ships, the catalogue reservation is forward-compatible (no
  // audit-counts migration needed). NEVER remove without bumping the
  // F8 audit catalogue count + updating `pnpm check:audit-counts`.
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
  // --- K6 / spec.md taxonomy line 365 add (1) -----------------------------
  // K6: previously listed in spec.md FR-052b taxonomy but the const
  // tuple was missing it. The coordinator route emits this when an
  // inbound Bearer fails verifyCronBearer — pre-K6 the route returned
  // 401 without a forensic record, so a sustained CRON_SECRET-rotation
  // incident or external probe was invisible in audit_log.
  'cron_bearer_auth_rejected',
  // --- Phase 5 (US3 Member Self-Service) additions (4) --------------------
  // T120 race-window forensic event (research.md R1 § Token re-issuance,
  // spec.md § Edge Cases CHK033). Emitted when a token verifies on a
  // cycle that's already in `completed` state (e.g. T-30 reminder fires
  // mid-completion race; member clicks T-30 link AFTER T-90 completed
  // the cycle). Idempotent no-op response per FR-027 step 8.
  'renewal_token_clicked_on_completed_cycle',
  // T138 pending-reactivation reminder ladder (research.md FR-005c).
  // Cron fires three reminders before 30-day auto-timeout: day 23, 27, 29
  // measured from `entered_pending_at`. Distinct event types let
  // dashboards count by stage (vs a single generic event with payload).
  'lapsed_member_admin_reactivation_reminder_t-7',
  'lapsed_member_admin_reactivation_reminder_t-3',
  'lapsed_member_admin_reactivation_reminder_t-1',
] as const;

export type F8AuditEventType = (typeof F8_AUDIT_EVENT_TYPES)[number];

/**
 * Compile-time count check — pins the const tuple length so a typo or
 * accidental drop in `F8_AUDIT_EVENT_TYPES` becomes a build error.
 */
type _AssertF8AuditEventCount = (typeof F8_AUDIT_EVENT_TYPES)['length'] extends 59
  ? true
  : 'F8_AUDIT_EVENT_TYPES count mismatch — expected 59';
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
 * — emitting "healthy → healthy" would be forensic noise. The DU below
 * encodes the 12 valid 4×4-with-self-excluded transitions at compile
 * time, so `{ previous_band: 'healthy', new_band: 'healthy' }` is a TS
 * error rather than a runtime invariant probe.
 *
 * **Wave A2 alignment** (Phase 6): band labels were `low | medium | high
 * | critical` in Wave D shipping. Re-aligned to `healthy | warning | at-
 * risk | critical` to match the audit-port contract at
 * `specs/011-renewal-reminders/contracts/audit-port.md` line 296+302+303
 * AND the Domain `RiskBand` type (`src/modules/renewals/domain/value-
 * objects/risk-band.ts`). Type alias re-exports the Domain `RiskBand`
 * so the audit catalogue stays the single canonical band-label source
 * across Domain + audit-payload + DB CHECK (`members.risk_score_band`).
 */
export type AtRiskBand = RiskBand;

/**
 * Phase 6 review S2 — UP-only band transitions (FR-031). Previously
 * the DU also admitted DOWN arms (e.g. `critical → healthy`), enforcing
 * UP-only at runtime via `BAND_ORDER`. Now compile-time-enforced: the
 * 6 valid UP arms are explicit; any attempt to construct a DOWN
 * transition is a TS error.
 *
 * `'critical'` has no UP arm (top of band ladder) so it is intentionally
 * absent from `previous_band`.
 */
export type BandTransition =
  | { readonly previous_band: 'healthy'; readonly new_band: 'warning' | 'at-risk' | 'critical' }
  | { readonly previous_band: 'warning'; readonly new_band: 'at-risk' | 'critical' }
  | { readonly previous_band: 'at-risk'; readonly new_band: 'critical' };

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
  /**
   * T115a Phase 5 wave K24 — typed payload for the `awaiting_payment`
   * → `lapsed` transition driven by the daily `lapseCyclesOnGraceExpiry`
   * cron (FR-004 + AS3 closed-reason differentiation).
   *
   * `closed_reason` discriminator picks between the two real-world
   * causes the AS3 lapsed-tab badge differentiates:
   *   - `'grace_expired'` — `now > expires_at + grace_period_days`,
   *     no F5 payment attempts (member silently let it expire)
   *   - `'payment_failed'` — `>= 1` F5 attempt ended `status='failed'`
   *     before the grace window expired (payment problem, not apathy)
   *
   * `'lapsed'` (legacy catch-all) is intentionally NOT in this union —
   * after K24, every `awaiting_payment → lapsed` transition writes a
   * specific reason. The catch-all stays in `CLOSED_REASONS` for
   * backward-compat with rows written before K24 ships.
   */
  readonly renewal_lapsed: {
    readonly cycle_id: CycleId;
    readonly member_id: MemberId;
    readonly closed_reason: 'grace_expired' | 'payment_failed';
    readonly expires_at: string;
    readonly grace_period_days: number;
    readonly failed_payment_attempts: number;
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
    /**
     * Phase 6 review I5 — `'manager_exception'` extended action label
     * for FR-052a's outreach-write-permitted-on-manager exception.
     * Dashboards distinguish a true read from a manager-permitted write
     * via this discriminator.
     */
    readonly action: 'read' | 'write' | 'manager_exception';
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
  /**
   * K12-9 (CON-K-3): typed payload for the cron-coordinator 401 path
   * Bearer-rejection audit. Previously fell back to generic
   * `Record<string, unknown>` because no entry existed here, which
   * meant a future caller typo (e.g. `path` instead of `route`) would
   * not be caught at compile time. Aligns with `renewal_kill_switch_
   * blocked` shape — `route` is the request path so dashboards can
   * group rejections by surface (currently only the coordinator
   * emits this; per-tenant + housekeeping crons would extend the
   * pattern in future waves).
   */
  readonly cron_bearer_auth_rejected: {
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
   * at compile time (e.g. `{ previous_band: 'healthy', new_band: 'healthy' }`
   * would be a TS error — there's no arm matching that pair). `score`
   * is the absolute new score, not a delta.
   */
  readonly at_risk_score_threshold_crossed: BandTransition & {
    readonly member_id: MemberId;
    readonly score: number;
  };
  /**
   * Phase 6 Wave A2 — `at_risk_score_recomputed` typed payload per
   * audit-port contract `AtRiskScoreRecomputedPayload` (line 292-298).
   *
   * `factors` is a per-key contribution map (e.g. `{
   * events_attended_last_12mo_zero: 25, invoices_overdue_count_gt_zero:
   * 25, days_since_last_payment_gt_180: 10 }`) — keys MUST be drawn
   * from the FR-029 weight table (Domain `AT_RISK_FACTOR_WEIGHTS`) so
   * dashboards can attribute score changes per factor.
   *
   * `active_max` is the literal 100 (F6 active) or 70 (F6 inactive) per
   * FR-029a + FR-030 + audit-port `active_max: 70 | 100`.
   *
   * `threshold_band` is the band derived from `score / active_max` per
   * `bandForScoreProportional` (FR-030).
   */
  readonly at_risk_score_recomputed: {
    readonly member_id: MemberId;
    readonly score: number;
    readonly factors: Partial<
      Record<keyof typeof AT_RISK_FACTOR_WEIGHTS, number>
    >;
    readonly threshold_band: RiskBand;
    readonly active_max: typeof F6_ACTIVE_MAX | typeof F6_INACTIVE_MAX;
    readonly f6_active: boolean;
  };
  /**
   * Phase 6 Wave A2 — `at_risk_snoozed` typed payload per audit-port
   * `AtRiskSnoozedPayload` (line 306-310). `snooze_duration_days` is a
   * literal-union (FR-032 enumerates 7 / 30 / 90 only). `snoozed_until`
   * is ISO 8601 UTC.
   */
  readonly at_risk_snoozed: {
    readonly member_id: MemberId;
    readonly snooze_duration_days: 7 | 30 | 90;
    readonly snoozed_until: string;
  };
  /**
   * Phase 6 Wave A2 — `at_risk_outreach_recorded` typed payload per
   * audit-port `AtRiskOutreachRecordedPayload` (line 312-317). The
   * `template_id: string | null` discriminator mirrors migration 0090's
   * CHECK: email channel must carry template_id; phone/meeting must not.
   *
   * `actor_role` is captured because FR-033 + FR-052a allow BOTH
   * admin and manager to record outreach (manager exception for
   * board-level relationship tracking). Dashboards differentiate the
   * two source roles via this field.
   */
  readonly at_risk_outreach_recorded: {
    readonly member_id: MemberId;
    readonly outreach_id: OutreachId;
    readonly channel: 'email' | 'phone' | 'meeting';
    readonly template_id: string | null;
    readonly actor_role: 'admin' | 'manager';
  };
  /**
   * Phase 6 Wave A2 — `at_risk_skipped_below_min_tenure` typed payload
   * per audit-port `AtRiskSkippedBelowMinTenurePayload` (line 319-322).
   * Emits per-member when the FR-035 min-tenure gate trips.
   * `threshold_days` is the per-tenant `min_tenure_days_for_at_risk`
   * setting in effect at recompute time.
   */
  readonly at_risk_skipped_below_min_tenure: {
    readonly member_id: MemberId;
    readonly tenure_days: number;
    readonly threshold_days: number;
  };
  /**
   * Phase 6 Wave A2 — `at_risk_compute_partial_failure` typed payload
   * per audit-port `AtRiskComputePartialFailurePayload` (line 324-328).
   *
   * Emitted by the per-tenant recompute cron (Phase 6 Wave C T161) when
   * one or more members raised a non-fatal exception during factor-
   * gathering — surfaces as observability signal so partial-data
   * recompute is detectable rather than silently degrading scores.
   *
   * `error_class` is a coarse classifier (e.g. `'db_timeout'` /
   * `'cross_module_unavailable'` / `'unknown'`); detailed error message
   * lives in pino logs (forbidden in audit per `docs/observability.md`).
   *
   * `members_processed + members_failed = total members in the cron
   * batch`. Fault-isolation contract: cron continues to next tenant on
   * any partial failure (per FR-052b spirit).
   */
  readonly at_risk_compute_partial_failure: {
    readonly error_class: string;
    readonly members_processed: number;
    readonly members_failed: number;
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
    /**
     * Phase 6 review I3 — discriminator added so dashboards can tell
     * `dispatch` runs (daily T-90/-30/-7 reminders) apart from
     * `at_risk_recompute` runs (weekly Sunday score recompute) and
     * `tier_upgrade_evaluate` (Phase 7+). Without this, the daily-
     * dispatch alert "no reminders in 24h" used to false-match every
     * Sunday at-risk run because the at-risk coordinator re-purposed
     * the `reminders_dispatched` slot. Optional for backward compat
     * with rows written before this field landed.
     */
    readonly cron_kind?:
      | 'dispatch'
      | 'at_risk_recompute'
      | 'lapse'
      | 'reconcile'
      | 'tier_upgrade_evaluate';
    readonly tenants_enqueued: number;
    readonly tenants_succeeded: number;
    readonly tenants_failed: number;
    /**
     * K5: tenants whose per-tenant route short-circuited via the F8
     * kill-switch (`FEATURE_F8_RENEWALS=false` returns `{skipped: true,
     * reason: 'feature_flag_disabled'}`) or read-only mode. Surfaced
     * separately from `tenants_succeeded` so a dark-launched tenant
     * flag-flap doesn't silently appear as "100% healthy" on
     * dashboards. Optional for backward compat with audit rows
     * written before this field landed.
     */
    readonly tenants_skipped_kill_switch?: number;
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
          /**
           * Round-5 review-finding M3: this slot was re-purposed for
           * three different counters across coordinators
           * (`dispatch`=tasks created · `lapse`=per-cycle errors ·
           * `reconcile`=F5 refund failures · `at_risk_recompute`=
           * members failed). SRE dashboards aggregating on it got
           * nonsense values. The new `kind_specific` discriminator
           * field below carries the per-cron-kind counters in a
           * named shape; `tasks_created` stays for backward compat
           * (existing dashboards keep working) and is reserved for
           * the dispatch coordinator's literal "tasks created" usage
           * going forward — other coordinators set it to 0 and
           * populate `kind_specific` instead.
           */
          readonly tasks_created: number;
          readonly duration_ms: number;
          /**
           * Round-5 review-finding M3 — per-cron-kind discriminated
           * counters that replace the `tasks_created` slot reuse.
           * Optional for backward-compat (audit rows written before
           * this field landed don't have it). Each variant carries
           * the counters specific to its cron run; consumers narrow
           * via the parent `cron_kind` field.
           */
          readonly kind_specific?:
            | { readonly kind: 'dispatch'; readonly tasks_created: number }
            | { readonly kind: 'lapse'; readonly errors: number; readonly grace_expired?: number; readonly payment_failed?: number }
            | { readonly kind: 'reconcile'; readonly refund_failures: number; readonly timed_out?: number }
            | { readonly kind: 'at_risk_recompute'; readonly members_failed: number; readonly members_skipped_below_tenure?: number };
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

  /**
   * Phase 6 Wave G T159b — bulk-emit N events in one INSERT … VALUES
   * (…),(…) round-trip. All events share the same `baseCtx` (tenantId,
   * actorUserId, actorRole, correlationId, requestId); only the
   * `event` discriminant + payload varies per row. Used by the
   * batched at-risk recompute use-case to collapse N audit-INSERTs
   * into 1 (FR-036 SLO).
   *
   * Atomic with the surrounding `runInTenant` tx — failure rolls back
   * the bulk UPDATE that landed alongside (Constitution Principle
   * VIII). Empty `events` is a no-op.
   */
  bulkEmitInTx(
    tx: TenantTx,
    events: ReadonlyArray<F8AuditEvent<F8AuditEventType>>,
    baseCtx: AuditContext,
  ): Promise<void>;
}
