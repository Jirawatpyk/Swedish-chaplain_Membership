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
import type { TaskId } from '../../domain/renewal-escalation-task';
import type { TierBucket } from '../../domain/value-objects/tier-bucket';
// Round 3 IMP-7 — type-link to gateway error kind for audit
// `tier_upgrade_pending_member_notify_failed.failure_kind`. Audit +
// port unions stay in lock-step at compile time.
//
// Round 5 SUG-3 — alias kept module-local (unexported); no current
// external consumer needs it. If a future emit site wants the alias,
// either re-add `export` or import `SendRenewalEmailError['kind']`
// directly. Round 4 IMP-9 — same pattern back-ported to
// `DispatchFailureKind` (consumed by
// `renewal_reminder_send_failed_permanent.failure_kind` below) so all
// hand-mirrored gateway-kind unions in F8 are now type-linked to a
// single source of truth.
import type { SendRenewalEmailError } from './renewal-gateway';
import type { DispatchFailureKind } from '../use-cases/_lib/dispatch-one-cycle';
type NotifyEmailErrorKind = SendRenewalEmailError['kind'];
import type { Sha256Hex } from '../../domain/value-objects/sha256-hex';
import type { RiskBand } from '../../domain/value-objects/risk-band';
import type {
  AT_RISK_FACTOR_WEIGHTS,
  F6_ACTIVE_MAX,
  F6_INACTIVE_MAX,
} from '../../domain/at-risk-score';
import type { OutreachId } from '../../domain/at-risk-outreach';
import type { MemberId, PlanId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
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
  // --- Renewal rolling-anchor refactor (design 2026-07-08, migration
  // 0238) — emitted by the shared payment classifier's settlement sites
  // when a first-payment (or zero-cycle "heal") cycle is re-anchored to
  // the actual payment date instead of completed. See docs/superpowers/
  // specs/2026-07-08-renewal-rolling-anchor-design.md § 5.
  'renewal_cycle_reanchored',
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
  // --- F8 Phase 7 review-fix Round 1 (3) — silent-skip closure --------------
  // Migration 0119 adds the 3 pgEnum values. Emit sites:
  //   - tier_upgrade_pending_member_notify_skipped → accept-tier-upgrade.ts
  //     when dispatch-candidate primaryContact.email is missing
  //   - tier_upgrade_pending_member_notify_failed → accept-tier-upgrade.ts
  //     when sendTierUpgradeApprovalEmail returns err after retries OR throws
  //   - renewal_schedule_reschedule_skipped → reschedule-on-plan-change.ts
  //     when plan-lookup-port returns not_found for old or new plan
  'tier_upgrade_pending_member_notify_skipped',
  'tier_upgrade_pending_member_notify_failed',
  'renewal_schedule_reschedule_skipped',
  // --- F8 Phase 7 review-fix Round 2 (2) — silent-failure closure -----------
  // Migration 0120 adds the 2 pgEnum values. Emit sites:
  //   - tier_upgrade_catalogue_row_dropped (Round 2 IMP-6) → drizzle-plan-
  //     catalog.ts when a row's renewal_tier_bucket fails parseTierBucket
  //   - tier_upgrade_apply_post_invoice_paid_failed (Round 2 SUG-6) →
  //     renewals-deps.ts when the F4 onPaidCallback INVALID_TX fallback
  //     throws on apply-pending after F4 has committed the paid invoice
  'tier_upgrade_catalogue_row_dropped',
  'tier_upgrade_apply_post_invoice_paid_failed',
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
  // --- F8-completion slice 2 — T-0 payability flip (1) --------------------
  // Migration 0215 adds the pgEnum value. Emitted when a cycle flips
  // `upcoming|reminded` → `awaiting_payment` (becomes payable). Two
  // writers carry the `source` discriminator (Resolved #3): the T-0
  // expiry cron (`enter-awaiting-payment-on-expiry.ts`, `source:'cron'`)
  // and the lazy confirm-renewal self-transition (slice 2.5,
  // `source:'confirm'`). The timeline surfaces which writer made the
  // cycle payable.
  'renewal_entered_awaiting_payment',
  // --- 059-membership-suspension Task 8 (2) — membership benefit-access
  // forensic events emitted by `src/lib/lapsed-portal-scope.ts`
  // (`checkPortalAccess`). Migration adds the 2 pgEnum values.
  //
  //   - `membership_suspended_action_blocked` — the SUSPENDED-member
  //     counterpart of `lapsed_member_action_blocked` (which continues to
  //     cover the TERMINATED-member block). Discriminating the two lets
  //     dashboards separate "unpaid, still on allow-by-default denylist"
  //     blocks from "grace-expired, deny-by-default allowlist" blocks —
  //     previously both branches emitted the same event, hiding which
  //     policy actually fired.
  //   - `membership_access_fail_open` — emitted when `cyclesRepo.
  //     findLatestCycleForMember` throws (DB blip) and the resolver fails
  //     OPEN (allows the request rather than locking every member out).
  //     Previously this path only pino-logged; a sustained fail-open
  //     storm (e.g. a partial Neon outage) was invisible in audit_log.
  'membership_suspended_action_blocked',
  'membership_access_fail_open',
  // --- 059-membership-suspension Task 13 (migration 0247) — F8 →F4
  //     `InvoiceDueBridge` credit-window guard (Task 12) closes the daily
  //     lapse cron's decision branch: emitted by `lapseCyclesOnGraceExpiry`
  //     when a member past the grace window still has an unpaid
  //     (`status='issued'`), not-yet-past-due MEMBERSHIP invoice (F4's
  //     90-day net terms). The cron defers the `awaiting_payment` →
  //     `lapsed` transition instead of terminating benefit access
  //     mid-credit-window. No state change occurs on this branch, so the
  //     audit is emitted via the fire-and-forget `emit()` path (no
  //     surrounding state-change tx to pair it with per Constitution
  //     Principle VIII — deferring IS the absence of a state change). ---
  'renewal_lapse_deferred_invoice_not_due',
  // --- 066-renewal-swecham-round2 §4.4(2) — a post-termination payment was
  //     CHARGED (and under FEATURE_088 a §86/4 receipt minted) while the
  //     member's membership stays terminated. Emitted in F4's payment tx at
  //     BOTH terminal heal sites (resolve-unlinked terminal_only +
  //     mark-cycle-complete's linked-terminal skip). 10y retention
  //     (tax-evidence class — explains an anomalous receipt; migration 0257
  //     retention trigger). ---
  'payment_on_terminated_member',
] as const;

export type F8AuditEventType = (typeof F8_AUDIT_EVENT_TYPES)[number];

/**
 * Compile-time count check — pins the const tuple length so a typo or
 * accidental drop in `F8_AUDIT_EVENT_TYPES` becomes a build error.
 */
type _AssertF8AuditEventCount = (typeof F8_AUDIT_EVENT_TYPES)['length'] extends 70
  ? true
  : 'F8_AUDIT_EVENT_TYPES count mismatch — expected 70';
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
   *   - `'grace_expired'` — no terminal-failed F5 payment attempts on the
   *     cycle's LINKED invoice (member silently let the clock run out)
   *   - `'payment_failed'` — `>= 1` F5 attempt ended `status='failed'`
   *     before the termination clock expired (payment problem, not apathy)
   *
   * 065 §5.2 (final-review V9): the termination clock is now the member's
   * oldest-due unpaid membership invoice `due_date + 60` (Bangkok days),
   * with `expires_at + grace_period_days` only as the no-invoice backstop.
   * `expires_at`/`grace_period_days` alone therefore no longer describe
   * the decision — a due+60 termination of a §5.3 born-awaiting cycle
   * carries a far-FUTURE `expires_at`. The payload records the actual
   * anchor so SRE/compliance can reconstruct the branch:
   *   - `due_date` — the anchoring invoice's due date (`YYYY-MM-DD`
   *     Bangkok), or `null` on the backstop branch;
   *   - `termination_basis` — which clock fired: `'due_plus_60'` (unpaid
   *     membership invoice 60+ days past due) or `'no_invoice_backstop'`
   *     (never invoiced; `expires_at + grace` elapsed).
   * Note `closed_reason` still keys F5 attempts on `linked_invoice_id`
   * (NULL for the born-awaiting cohort → always `'grace_expired'` there);
   * `termination_basis` is the field that carries the true anchor.
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
    readonly due_date: string | null;
    readonly termination_basis: 'due_plus_60' | 'no_invoice_backstop';
  };
  /**
   * F8-completion slice 2 — typed payload for the `upcoming|reminded`
   * → `awaiting_payment` flip that makes a cycle payable. Migration
   * 0215 adds the pgEnum value.
   *
   * `source` discriminator (Resolved #3) records which writer flipped
   * the cycle so the member timeline can distinguish:
   *   - `'cron'`    — the T-0 expiry cron (`enter-awaiting-payment-on-
   *     expiry.ts`) flipped the cycle when `expires_at <= now`.
   *   - `'confirm'` — the member's own early-renewal click lazily
   *     self-transitioned the cycle (confirm-renewal Step-1, slice 2.5)
   *     before `expires_at`.
   *
   * Both writers go through the same CAS guard (`transitionStatus`
   * `WHERE status = from`), so concurrent cron + confirm flips converge
   * to exactly ONE `awaiting_payment` row — the loser sees a
   * `CycleTransitionConflictError` and re-reads cleanly. `entered_at`
   * is the writer's injected clock (cron) or `clock.now().toISOString()`
   * (confirm), never wall-clock, for deterministic forensic correlation.
   */
  readonly renewal_entered_awaiting_payment: {
    readonly cycle_id: CycleId;
    readonly member_id: MemberId;
    readonly source: 'cron' | 'confirm';
    readonly entered_at: string;
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
  /**
   * Renewal rolling-anchor refactor (design 2026-07-08, migration 0238) —
   * emitted by the shared `classifyMembershipPayment` settlement sites
   * (unlinked-invoice hook, `markCycleCompleteInTx`, `mark-paid-offline`)
   * whenever a first-payment cycle re-anchors to the actual payment date
   * instead of completing, OR a zero-cycle member is healed (new cycle
   * created + immediately anchored).
   *
   * `invoice_id: InvoiceId | null` — null only for the ship-day backfill
   * script path (pre-system payments with no forensic invoice reference).
   *
   * `old_period_from` / `old_period_to: string | null` — both null for
   * the `heal_no_cycle` branch (no prior period existed at all); non-null
   * for a genuine re-anchor of an existing provisional cycle.
   *
   * `old_status` carries the pre-write status (`upcoming` |
   * `awaiting_payment`, or the `heal_no_cycle` sentinel case has no prior
   * row) so the forensic trail records which branch fired without a
   * separate discriminator field.
   *
   * `refroze_plan_fields` is true when the re-anchor crossed a fiscal-year
   * boundary and `loadPlanFrozenFields` re-resolved the frozen
   * price/term for the new period (rev 2 FY-crossing rule).
   *
   * `reminder_events_reset` is the count of `renewal_reminder_events` rows
   * deleted for this cycle in the same tx (a step fired against the
   * provisional expiry must not suppress that step for the later,
   * re-anchored expiry).
   */
  readonly renewal_cycle_reanchored: {
    readonly cycle_id: CycleId;
    readonly member_id: MemberId;
    readonly invoice_id: InvoiceId | null;
    readonly old_period_from: string | null;
    readonly old_period_to: string | null;
    readonly new_period_from: string;
    readonly new_period_to: string;
    readonly old_status: string;
    readonly refroze_plan_fields: boolean;
    readonly reminder_events_reset: number;
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
    /**
     * Deep-review fix — token fingerprint for forensic correlation
     * across multiple rejection events. `null` for rejection paths
     * that occur BEFORE HMAC verification produces a sha256 (e.g.
     * malformed_token, mac_mismatch); populated for paths where the
     * verifier already ran (replayed, cross_tenant,
     * member_not_found_in_tenant). The raw token is NEVER logged —
     * only the SHA-256 hex of the raw token, which is safe to record
     * (one-way + bounded length) and lets SRE correlate replay-storm
     * attempts on a specific emailed token.
     */
    readonly token_sha256?: string;
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
   * Phase 7 T180 — admin Accept transitions suggestion `open` →
   * `accepted_pending_apply`. Carries the cycle the upgrade will apply
   * at + the F2 scheduled_plan_changes row id (forensic linkage to the
   * F2 supersede listener). Member's `members.plan_id` is NOT mutated
   * yet (FR-039 — no surprise mid-year invoicing).
   *
   * Phase 7 review-fix I-TYPE-4: `scheduled_change_id` carries the
   * `ScheduledChangeId` brand for cross-module forensic linkage.
   */
  readonly tier_upgrade_accepted: {
    readonly suggestion_id: SuggestionId;
    readonly member_id: MemberId;
    readonly from_plan_id: PlanId;
    readonly to_plan_id: PlanId;
    readonly target_apply_at_cycle_id: CycleId;
    readonly scheduled_change_id: string;
  };
  /**
   * Phase 7 T180 — single transactional email dispatched to the
   * member's primary contact email after Accept. `delivery_id` is the
   * Resend message id (forensic linkage to the F1 transactional
   * delivery webhook).
   */
  readonly tier_upgrade_pending_member_notified: {
    readonly suggestion_id: SuggestionId;
    readonly member_id: MemberId;
    readonly to_plan_id: PlanId;
    readonly recipient_email_hashed: Sha256Hex;
    readonly delivery_id: string | null;
    readonly effective_at: string;
  };
  /**
   * Phase 7 T180 — T-180 verify-task scheduled when
   * `expires_at - today > 180 days`. Admin re-verifies the upgrade
   * still applies before the cycle rollover.
   *
   * Phase 7 review-fix I-TYPE-4: `verification_task_id` is the
   * `TaskId` brand from the F8 escalation-task domain.
   */
  readonly tier_upgrade_pending_admin_verification_due: {
    readonly suggestion_id: SuggestionId;
    readonly member_id: MemberId;
    readonly verification_task_id: TaskId;
    readonly verification_due_at: string;
  };
  /**
   * Phase 7 T183 — F4 renewal-invoice-creation hook applied the
   * pending upgrade. Suggestion transitioned `accepted_pending_apply`
   * → `applied`. The invoice id forensically links the upgrade to the
   * actual F4 invoice + F2 plan flip.
   */
  readonly tier_upgrade_applied_at_renewal: {
    readonly suggestion_id: SuggestionId;
    readonly member_id: MemberId;
    readonly from_plan_id: PlanId;
    readonly to_plan_id: PlanId;
    readonly applied_at_cycle_id: CycleId;
    readonly applied_at_invoice_id: InvoiceId;
  };
  /**
   * Phase 7 T181 — admin Dismiss with optional reason. Suppression
   * persists for 90 days (cron skip-eligibility check via
   * `tier_upgrade_suggestions_suppressed_idx`).
   */
  readonly tier_upgrade_dismissed: {
    readonly suggestion_id: SuggestionId;
    readonly member_id: MemberId;
    readonly reason: string | null;
    readonly suppressed_until: string;
  };
  /**
   * Phase 7 T179 (cron) — debug-level signal that the cron evaluated
   * member(s) whose `members.plan_id` already matches the would-be
   * upgrade target. Round 6 W-010 collapsed the per-member emit
   * (5,000 rows/week × 5y retention amplification hazard) into a
   * single aggregate emit per cron pass. The pre-Round-6 per-member
   * shape is retained as the second arm of the union so historical
   * audit rows still type-check on read paths.
   *
   *   - Round 6 + post: aggregate per cron pass, fired ONCE after the
   *     candidate loop completes. Skipped emit when count === 0.
   *   - Pre-Round 6 (historical): per-member emit, fired inside the
   *     loop for each candidate whose plan already matches the target.
   */
  readonly tier_upgrade_already_at_target:
    | {
        readonly already_at_target_count: number;
        readonly members_scanned: number;
      }
    | {
        readonly member_id: MemberId;
        readonly current_plan_id: PlanId;
      };
  /**
   * Phase 7 T179 (cron) — emitted once per cron pass when
   * `tenant_renewal_settings.auto_upgrade_enabled = false`. Whole
   * tenant skipped; cron continues with next tenant.
   */
  readonly tier_upgrade_tenant_disabled: Record<string, never>;
  /**
   * Phase 7 T179 (cron) — emitted once per cron pass when the tenant
   * has not configured turnover thresholds on any plan in their
   * catalogue. Cron continues with next tenant.
   *
   * Phase 7 review-fix I-TYPE-3: enriched with `catalogue_size`.
   * Phase 7 review-fix Round 2 IMP-2: explicit `skip_reason`
   * discriminator so dashboards + alert rules can distinguish
   * `'no_plans'` (onboarding gap — tenant has zero active plans)
   * from `'no_thresholds_set'` (config gap — tenant has N plans,
   * none with `min_turnover_minor_units`). `catalogue_size: 0` ⇒
   * `'no_plans'`; `catalogue_size > 0` ⇒ `'no_thresholds_set'`.
   */
  readonly tier_upgrade_skipped_no_thresholds_configured: {
    /** Number of active non-deleted plans in the tenant catalogue (>=0). */
    readonly catalogue_size: number;
    readonly skip_reason: 'no_plans' | 'no_thresholds_set';
  };
  /**
   * Phase 7 T185 (reconcile cron) — orphan detection. Three orphan
   * shapes are detected and dismissed:
   *
   *   - `'cancelled'` / `'lapsed'`: the `target_apply_at_cycle_id`
   *     cycle is in a terminal state, so the F4 invoice-paid hook
   *     will never fire. Dismiss reason: `orphan_target_cycle_terminal`.
   *   - `'manual_plan_change'` (Round 6 W-002): the member's current
   *     `members.plan_id` no longer matches the suggestion's
   *     `from_plan_id` AND no longer matches `to_plan_id` — admin
   *     manually changed the plan after Accept and the F8 supersede
   *     listener swallowed the resulting failure (or was never wired
   *     at the time). Dismiss reason: `orphan_member_plan_diverged`.
   */
  readonly tier_upgrade_pending_orphan_detected: {
    readonly suggestion_id: SuggestionId;
    readonly member_id: MemberId;
    readonly target_apply_at_cycle_id: CycleId;
    readonly target_cycle_status:
      | 'cancelled'
      | 'lapsed'
      | 'manual_plan_change';
  };
  /**
   * Phase 7 T188a — F2 → F8 reschedule-on-plan-change listener emit.
   * Captured when an admin's manual plan-change shifts the member's
   * tier-bucket and not-yet-fired reminders shift cadence. Per spec
   * Edge Cases line 182, already-sent reminders are NOT recalled —
   * only future schedule steps differ.
   *
   * `cancelled_step_ids` are old-bucket steps no longer scheduled;
   * `new_step_ids` are new-bucket steps newly scheduled. Same-bucket
   * plan changes do not emit (early-return inside the use-case).
   *
   * Phase 7 review-fix I-TYPE-2: bucket fields use Domain `TierBucket`
   * literal-union instead of bare string.
   */
  readonly renewal_schedule_rescheduled: {
    readonly member_id: MemberId;
    readonly cycle_id: CycleId;
    readonly old_tier_bucket: TierBucket;
    readonly new_tier_bucket: TierBucket;
    readonly cancelled_step_ids: ReadonlyArray<string>;
    readonly new_step_ids: ReadonlyArray<string>;
  };
  /**
   * Phase 7 review-fix I-ERR-1 — emitted when admin Accept commits
   * the suggestion transition but the member has no primary contact
   * email. FR-039 step 2 audit obligation surfaced explicitly so
   * admin can re-notify after onboarding the contact.
   */
  readonly tier_upgrade_pending_member_notify_skipped: {
    readonly suggestion_id: SuggestionId;
    readonly member_id: MemberId;
    readonly to_plan_id: PlanId;
    readonly reason: 'no_primary_contact_email';
  };
  /**
   * Phase 7 review-fix I-ERR-2 + Round 2 IMP-3 + Round 3 IMP-2/IMP-7 —
   * emitted when the post-tx tier-upgrade approval email fails after
   * the retry budget OR throws an exception (including the catch-all
   * `'threw'` branch where the lookup/gateway crashed before
   * computing `recipient_email_hashed`). `failure_kind` mirrors
   * `SendRenewalEmailError['kind']` exactly (audit + port unions
   * stay in lock-step via the type-link) plus `'unknown'` for the
   * catch-all branch.
   *
   * Round 3 IMP-2 fix: `recipient_email_hashed: Sha256Hex | null`
   * — nullable so the `'threw'` branch emits this audit even when
   * we crashed before computing the hash. FR-039 step 2 forensic
   * chain now covers all 4 outcomes (sent / skipped / failed /
   * threw); previously the threw-branch was metric-only.
   *
   * `failure_message` carries the gateway message OR (for
   * `template_variables_missing`) a comma-joined `missing[]` list.
   */
  readonly tier_upgrade_pending_member_notify_failed: {
    readonly suggestion_id: SuggestionId;
    readonly member_id: MemberId;
    readonly to_plan_id: PlanId;
    readonly recipient_email_hashed: Sha256Hex | null;
    /**
     * Round 3 IMP-7: typed-link to `SendRenewalEmailError['kind']`
     * via the gateway port. A future port-side kind addition now
     * triggers a TypeScript compile error here, eliminating the
     * silent-drift risk Round 2 IMP-3 left open.
     */
    readonly failure_kind:
      | NotifyEmailErrorKind
      | 'unknown';
    readonly failure_message: string | null;
  };
  /**
   * Phase 7 review-fix S-2-errors — emitted when the F2 → F8
   * reschedule listener cannot resolve the OLD or NEW plan via
   * `loadPlanFrozenFields`. The `renewal_schedule_rescheduled` audit
   * cannot fire (no buckets to compare); this skipped-audit closes
   * the forensic chain so the F2 plan-flip never appears as an
   * un-acknowledged event.
   */
  readonly renewal_schedule_reschedule_skipped: {
    readonly member_id: MemberId;
    readonly old_plan_id: PlanId;
    readonly new_plan_id: PlanId;
    readonly reason: 'old_plan_not_found' | 'new_plan_not_found' | 'both_not_found';
  };
  /**
   * Phase 7 review-fix Round 2 IMP-6 — emitted when the Drizzle
   * plan-catalog adapter drops a row whose `renewal_tier_bucket`
   * value fails Domain `parseTierBucket`. Closes the silent-narrowing
   * gap surfaced by Round 2 review (a DB drift would otherwise
   * shrink the cron decision tree without forensic chain).
   *
   * `raw_bucket` carries the unparseable value (no PII risk — it's a
   * tier-bucket string column).
   */
  readonly tier_upgrade_catalogue_row_dropped: {
    readonly plan_id: PlanId;
    readonly raw_bucket: string;
  };
  /**
   * Phase 7 review-fix Round 2 SUG-6 — emitted from the F4
   * onPaidCallback INVALID_TX fallback when `applyPendingTierUpgradeInTx`
   * throws AFTER F4 has committed the paid invoice. The F4 invoice =
   * paid, F8 suggestion stays in `accepted_pending_apply` against a
   * still-active paid cycle; the reconcile cron will NOT recover this
   * case (cycle isn't terminal). This audit closes the gap.
   */
  readonly tier_upgrade_apply_post_invoice_paid_failed: {
    readonly invoice_id: InvoiceId;
    readonly member_id: MemberId;
    readonly cycle_id: CycleId;
    readonly failure_message: string;
  };
  /**
   * F8 Phase 8 T213 — `escalation_task_created` typed payload.
   *
   * Pre-Phase-8 the 5 inline producers (`dispatch-one-cycle` ladder,
   * `dispatch-one-cycle` no-primary-contact, `detect-bounce-threshold`,
   * `admin-reject-reactivation`, `retry-failed-reminders`) emitted with
   * a `Record<string, unknown>` fallback. Phase 8 adds the canonical
   * `createEscalationTask` use-case (T208) and pins the payload shape:
   *
   *   - `task_id` / `task_type` / `member_id` are mandatory across every
   *     producer.
   *   - `cycle_id` is nullable for non-cycle tasks (e.g.
   *     `verify_pending_tier_upgrade` — FR-039 step 3).
   *   - `trigger_reason` is OPTIONAL — backward-compat with the 5
   *     pre-Phase-8 producers that did not carry an explicit reason. The
   *     T208 canonical use-case always sets it.
   *   - `idempotent_replay` flips when the partial unique index
   *     short-circuits an open task; emit sites still emit so the
   *     forensic chain documents the no-op replay (mirrors
   *     `dispatch-one-cycle.ts` ~L933 pattern).
   *
   * Optional context fields (`step_id`, `year_in_cycle`, `assignee_role`,
   * `refund_credit_note_id`, `related_suggestion_id`) cover the per-
   * producer extras without forcing a payload migration on existing
   * inline call sites.
   */
  readonly escalation_task_created: {
    readonly task_id: TaskId;
    readonly task_type: string;
    readonly member_id: MemberId;
    readonly cycle_id: CycleId | null;
    readonly trigger_reason?: string;
    readonly assignee_role?: 'admin' | 'manager' | 'executive_director';
    readonly idempotent_replay?: boolean;
    readonly step_id?: string;
    readonly year_in_cycle?: number;
    readonly refund_credit_note_id?: CreditNoteId | null;
    readonly related_suggestion_id?: SuggestionId | null;
    /**
     * Producer-specific discriminator from `detectBounceThreshold` —
     * one of `'hard_bounce' | 'soft_streak_in_cycle' | 'soft_rolling_30d'`.
     * Pre-Phase-8 emit; kept optional for backward compat.
     */
    readonly bounce_trigger?: string;
    /**
     * 063 — catch-up provenance for task-channel reminder steps fired by
     * the dispatcher's bounded missed-cron recovery (Gate 8). `caught_up`
     * is true when the step's due-day was strictly before today (recovered
     * within `REMINDER_CATCH_UP_LOOKBACK_DAYS`); `step_due_date` is the ISO
     * date the step was originally due. Optional — only the dispatch
     * producer sets them; other `escalation_task_created` emitters omit.
     */
    readonly caught_up?: boolean;
    readonly step_due_date?: string;
  };
  /**
   * F8 Phase 8 T209 — `escalation_task_completed` typed payload.
   *
   * Admin clicks "Done" with optional outcome note (≤1000 chars per
   * `renewal_escalation_tasks.outcome_note` CHECK + Domain invariant).
   * `actor_user_id` is the closing admin (F1 `users.id`).
   *
   * `outcome_note` is `string | null` — NULL when admin closed without
   * a note. Stored as NULL in DB; emitted as `null` for consumer
   * simplicity (vs omit-the-field).
   */
  readonly escalation_task_completed: {
    readonly task_id: TaskId;
    readonly task_type: string;
    readonly member_id: MemberId;
    /**
     * Optional for backward-compat with `reset-email-unverified.ts`
     * (Phase 4 producer) which closes `manual_outreach_required` tasks
     * without explicit cycle linkage. New producers (T209
     * `completeEscalationTask`) always set it.
     */
    readonly cycle_id?: CycleId | null;
    /**
     * Outcome note. The T209 admin-Done path sets `null` when admin
     * closed without a note. Other producers (e.g. reset-email-unverified)
     * may omit; the AuditContext's `summary` carries human-readable
     * context in that case.
     */
    readonly outcome_note?: string | null;
    /**
     * Required for the T209 admin-Done path. Optional for system-driven
     * producers (e.g. reset-email-unverified) that close on behalf of
     * the F1 webhook — the AuditContext carries `actorUserId` separately
     * for those.
     */
    readonly actor_user_id?: UserId;
    /** Producer-specific tags carried by reset-email-unverified.ts. */
    readonly closed_by_actor_role?: string;
    readonly closure_reason?: string;
  };
  /**
   * F8 Phase 8 T210 — `escalation_task_skipped` typed payload.
   *
   * Admin clicks "Skip" with REQUIRED reason (1..500 chars per
   * `renewal_escalation_tasks.skipped_reason` CHECK + Domain invariant +
   * use-case zod schema `min(1).max(500)`).
   */
  readonly escalation_task_skipped: {
    readonly task_id: TaskId;
    readonly task_type: string;
    readonly member_id: MemberId;
    readonly cycle_id: CycleId | null;
    readonly skipped_reason: string;
    readonly actor_user_id: UserId;
  };
  /**
   * F8 Phase 8 T211 — `escalation_task_reassigned` typed payload.
   *
   * Admin reassigns the task's `assigned_to_user_id`. `from_user_id` is
   * captured pre-mutation (NULL when previously assigned by role only —
   * no specific user). `actor_user_id` is the admin who performed the
   * reassignment (NOT the recipient).
   */
  readonly escalation_task_reassigned: {
    readonly task_id: TaskId;
    readonly task_type: string;
    readonly member_id: MemberId;
    readonly cycle_id: CycleId | null;
    readonly from_user_id: UserId | null;
    readonly to_user_id: UserId;
    readonly actor_user_id: UserId;
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
   * S-2 (063 review polish) — `renewal_reminder_sent` typed payload.
   *
   * Emitted ONLY by the EMAIL channel on a successful dispatch: the
   * member dispatcher (`dispatchOneCycle` → `dispatchEmailStep`) and the
   * retry path (`retryFailedReminders`). The TASK channel
   * (`dispatchOneCycle` → `dispatchTaskStep`) does NOT emit this event —
   * a task-channel "send" is recorded via `escalation_task_created`
   * (a different event). Hence `channel` is narrowed to `'email'`: a
   * dashboard/alert filtering `renewal_reminder_sent` on a task channel
   * would always return zero. Analytics that count "all reminder
   * dispatches" (email + task) MUST union both events:
   * `renewal_reminder_sent` ∪ `escalation_task_created`.
   *
   * Previously fell through to `Record<string, unknown>` — asymmetric
   * with the already-typed `escalation_task_created`.
   *
   * Key fields:
   *   - `caught_up` — true when the step's due-day was strictly before
   *     today (bounded missed-cron recovery, 063 feature). False for
   *     on-time sends. Ops dashboards filter on this to detect cron-
   *     health degradation (a spike in `caught_up=true` across tenants
   *     signals a systemic cron miss). NOTE: the OTel counter
   *     `renewalsMetrics.remindersSent(...,caught_up)` is EMAIL-only —
   *     task-channel catch-up recoveries are observable only via
   *     `escalation_task_created.caught_up` in the audit payload, not
   *     via that counter (no separate task metric is warranted).
   *   - `step_due_date` — ISO UTC date the step was originally due
   *     (for forensic correlation; present on both on-time and catch-up).
   *   - `delivery_id` — Resend message id (forensic link to F7 delivery
   *     webhook).
   *   - `recipient_locale` — resolved BCP-47 tag (email channel).
   */
  readonly renewal_reminder_sent: {
    readonly cycle_id: CycleId;
    readonly member_id: MemberId;
    readonly step_id: string;
    readonly channel: 'email';
    readonly template_id: string | null;
    readonly delivery_id: string | null;
    readonly recipient_locale?: string | null;
    /**
     * True when dispatched after the exact due-day (bounded catch-up).
     * Set by the member dispatcher path; absent on the retry path.
     */
    readonly caught_up?: boolean;
    /** ISO UTC date the step was originally due (dispatcher path). */
    readonly step_due_date?: string;
    /** True when (re-)emitted by the retry-failed-reminders path. */
    readonly via_retry?: boolean;
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
         * J9-M17 + Round 4 IMP-9: closed set of gateway-error
         * classifiers, type-linked via `DispatchFailureKind`. The
         * type alias resolves to `SendRenewalEmailError['kind'] |
         * 'dispatcher_crash'` (5 + 1 arms). When a future arm is
         * added to the gateway error union, this audit field type
         * widens automatically — no hand-mirrored literal union to
         * keep in sync. Closes the silent-drift gap that the bare
         * `string` shape used to allow.
         */
        readonly failure_kind: DispatchFailureKind;
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
      | 'enter_awaiting'
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
            | { readonly kind: 'enter_awaiting'; readonly errors: number; readonly flipped?: number; readonly race_skipped?: number }
            | { readonly kind: 'reconcile'; readonly refund_failures: number; readonly timed_out?: number }
            | { readonly kind: 'at_risk_recompute'; readonly members_failed: number; readonly members_skipped_below_tenure?: number };
        }
    >;
  };
  /**
   * 059-membership-suspension Task 8 — emitted from `checkPortalAccess`'s
   * suspended-policy denylist branch (`src/lib/lapsed-portal-scope.ts`).
   * Discriminated from `lapsed_member_action_blocked` (which now covers
   * ONLY the terminated-policy allowlist branch) so dashboards can tell
   * the two block reasons apart. `access_state` is always `'suspended'`
   * for this event — the field exists for payload-shape symmetry with
   * the resolver's own `PortalAccessDecision`, so a future
   * generalisation of this event to cover both access states (should one
   * ever be needed) would not require a payload-shape churn.
   *
   * IDs are plain `string` (not the module's branded `CycleId`/`MemberId`)
   * because the emit site lives OUTSIDE `src/modules/renewals/` in the
   * cross-cutting `src/lib/lapsed-portal-scope.ts` helper, which
   * deliberately works in raw route/member strings rather than importing
   * Domain brands from a sibling it doesn't otherwise depend on.
   */
  readonly membership_suspended_action_blocked: {
    readonly cycle_id: string;
    readonly member_id: string;
    readonly blocked_route: string;
    readonly access_state: 'suspended';
    readonly action:
      | 'GET'
      | 'POST'
      | 'PUT'
      | 'PATCH'
      | 'DELETE'
      | 'HEAD'
      | 'OPTIONS'
      | null;
  };
  /**
   * 059-membership-suspension Task 8 — emitted from `checkPortalAccess`'s
   * fail-open branch when `cyclesRepo.findLatestCycleForMember` throws.
   * No `cycle_id` — the read itself failed, so no cycle was ever
   * resolved. `error` carries the caught error's message (never the raw
   * error object — matches the existing `emitBlockedAudit` log-field
   * convention of string-only error detail).
   */
  readonly membership_access_fail_open: {
    readonly member_id: string;
    readonly blocked_route: string;
    readonly error: string;
  };
  /**
   * 059-membership-suspension Task 13 — emitted from
   * `lapseCyclesOnGraceExpiry`'s `processOne` when the Task-12
   * `InvoiceDueBridge` guard reports an unpaid, not-yet-past-due
   * MEMBERSHIP invoice for the cycle's member. `due_date_frontier` is
   * the Bangkok-local calendar date (`YYYY-MM-DD`) the guard checked
   * against (`bangkokLocalDate(now)`) — NOT the invoice's own due date,
   * which the boolean-returning bridge does not surface. `invoice_subject`
   * is always `'membership'` (the bridge's own filter); the field exists
   * for payload-shape symmetry should a future generalisation ever cover
   * other invoice subjects.
   */
  readonly renewal_lapse_deferred_invoice_not_due: {
    readonly cycle_id: CycleId;
    readonly member_id: MemberId;
    readonly invoice_subject: 'membership';
    readonly due_date_frontier: string;
  };
  /**
   * 066 §4.4(2) — a payment settled a MEMBERSHIP invoice for a member whose
   * membership is terminated. Fields are the real F4InvoicePaidEvent fields
   * (the event carries NO processor payment reference by design;
   * payment_method + triggered_by distinguish the online/offline rails).
   * `cycle_id` is the lapsed cycle when the payment arrived on a LINKED
   * invoice (mark-cycle-complete site) and null on the unlinked terminal_only
   * site. `heal_site` names which of the two exits observed it.
   */
  readonly payment_on_terminated_member: {
    readonly invoice_id: string;
    readonly member_id: MemberId;
    readonly cycle_id: string | null;
    readonly amount_satang: string;
    readonly payment_method: string;
    readonly triggered_by: string;
    readonly paid_at: string;
    readonly heal_site: 'terminal_only' | 'linked_terminal_skip';
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
