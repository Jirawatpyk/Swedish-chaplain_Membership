# F8 — Audit Port Contract

**Feature**: F8 Renewal Tracking + Smart Reminders
**Branch**: `011-renewal-reminders`
**Date**: 2026-05-03
**Status**: Phase 1 contract output

F8 emits **54 audit event types** to F1's existing `audit_log` table (no new audit infra). All events have `retention_years = 5` (F8 has no tax-document overlap with F4's 10-year retention). Total updated at /speckit.critique 2026-05-03 round 1 (5 events): added `cron_dispatch_orchestrated` (X1), `renewal_reminder_send_failed_permanent` (E6), `renewal_reminder_retried` (E6), `renewal_skipped_no_joined_at` (P13), `tier_upgrade_pending_orphan_detected` (E19). Total updated again at /speckit.implement Wave E verify-run C1 (2026-05-04, 6 events): clarify R3 admin-reactivation lifecycle events that landed in spec.md FR-005a-c + data-model.md § 4 but were missed in this contract: `lapsed_member_admin_reactivated` (Q1), `lapsed_member_admin_reactivation_rejected` (Q1), `lapsed_member_admin_reactivation_timed_out` (M3), `member_auto_reactivation_blocked` (Q1), `member_auto_reactivation_unblocked` (Q1), `renewal_cycle_price_frozen` (Q2).

The `RenewalAuditEmitter` port is the canonical interface; Infrastructure adapter is `audit-emitter.ts` writing through F1's audit pipeline.

---

## 1. Port interface

```ts
// src/modules/renewals/application/ports/renewal-audit-emitter.ts

export type F8AuditEvent =
  | { type: 'renewal_cycle_created'; payload: RenewalCycleCreatedPayload }
  | { type: 'renewal_cycle_cancelled'; payload: RenewalCycleCancelledPayload }
  | { type: 'renewal_cycle_completed_offline'; payload: RenewalCycleCompletedOfflinePayload }
  | { type: 'renewal_lapsed'; payload: RenewalLapsedPayload }
  | { type: 'renewal_reminder_sent'; payload: RenewalReminderSentPayload }
  | { type: 'renewal_reminder_skipped'; payload: RenewalReminderSkippedPayload }
  | { type: 'renewal_reminder_send_failed'; payload: RenewalReminderSendFailedPayload }
  | { type: 'renewal_schedule_rescheduled'; payload: RenewalScheduleRescheduledPayload }
  | { type: 'renewal_schedule_policy_updated'; payload: RenewalSchedulePolicyUpdatedPayload }
  | { type: 'renewal_self_service_initiated'; payload: RenewalSelfServiceInitiatedPayload }
  | { type: 'renewal_invoice_created'; payload: RenewalInvoiceCreatedPayload }
  | { type: 'renewal_with_plan_change'; payload: RenewalWithPlanChangePayload }
  | { type: 'renewal_payment_failed'; payload: RenewalPaymentFailedPayload }
  | { type: 'renewal_completed'; payload: RenewalCompletedPayload }
  | { type: 'renewal_completed_post_lapse'; payload: RenewalCompletedPostLapsePayload }
  | { type: 'renewal_token_invalid'; payload: RenewalTokenInvalidPayload }
  | { type: 'renewal_kill_switch_blocked'; payload: RenewalKillSwitchBlockedPayload }
  | { type: 'renewal_cross_tenant_probe'; payload: RenewalCrossTenantProbePayload }
  | { type: 'renewal_cross_member_probe'; payload: RenewalCrossMemberProbePayload }
  | { type: 'renewal_reminder_deferred_read_only'; payload: RenewalReminderDeferredReadOnlyPayload }
  | { type: 'lapsed_member_action_blocked'; payload: LapsedMemberActionBlockedPayload }
  | { type: 'member_email_unverified_threshold_crossed'; payload: MemberEmailUnverifiedThresholdCrossedPayload }
  | { type: 'f8_role_violation_blocked'; payload: F8RoleViolationBlockedPayload }
  | { type: 'at_risk_score_recomputed'; payload: AtRiskScoreRecomputedPayload }
  | { type: 'at_risk_score_threshold_crossed'; payload: AtRiskScoreThresholdCrossedPayload }
  | { type: 'at_risk_snoozed'; payload: AtRiskSnoozedPayload }
  | { type: 'at_risk_outreach_recorded'; payload: AtRiskOutreachRecordedPayload }
  | { type: 'at_risk_skipped_below_min_tenure'; payload: AtRiskSkippedBelowMinTenurePayload }
  | { type: 'at_risk_compute_partial_failure'; payload: AtRiskComputePartialFailurePayload }
  | { type: 'tier_upgrade_suggested'; payload: TierUpgradeSuggestedPayload }
  | { type: 'tier_upgrade_accepted'; payload: TierUpgradeAcceptedPayload }
  | { type: 'tier_upgrade_pending_member_notified'; payload: TierUpgradePendingMemberNotifiedPayload }
  | { type: 'tier_upgrade_pending_admin_verification_due'; payload: TierUpgradePendingAdminVerificationDuePayload }
  | { type: 'tier_upgrade_applied_at_renewal'; payload: TierUpgradeAppliedAtRenewalPayload }
  | { type: 'tier_upgrade_pending_superseded_by_manual_change'; payload: TierUpgradePendingSupersededByManualChangePayload }
  | { type: 'tier_upgrade_dismissed'; payload: TierUpgradeDismissedPayload }
  | { type: 'tier_upgrade_already_at_target'; payload: TierUpgradeAlreadyAtTargetPayload }
  | { type: 'tier_upgrade_tenant_disabled'; payload: TierUpgradeTenantDisabledPayload }
  | { type: 'tier_upgrade_skipped_no_thresholds_configured'; payload: TierUpgradeSkippedNoThresholdsPayload }
  | { type: 'escalation_task_created'; payload: EscalationTaskCreatedPayload }
  | { type: 'escalation_task_completed'; payload: EscalationTaskCompletedPayload }
  | { type: 'escalation_task_skipped'; payload: EscalationTaskSkippedPayload }
  | { type: 'escalation_task_reassigned'; payload: EscalationTaskReassignedPayload }
  // Added at /speckit.critique 2026-05-03 round 1
  | { type: 'cron_dispatch_orchestrated'; payload: CronDispatchOrchestratedPayload }
  | { type: 'renewal_reminder_send_failed_permanent'; payload: RenewalReminderSendFailedPermanentPayload }
  | { type: 'renewal_reminder_retried'; payload: RenewalReminderRetriedPayload }
  | { type: 'renewal_skipped_no_joined_at'; payload: RenewalSkippedNoJoinedAtPayload }
  | { type: 'tier_upgrade_pending_orphan_detected'; payload: TierUpgradePendingOrphanDetectedPayload }
  // Added at /speckit.implement Wave E verify-run C1 (2026-05-04) — synced
  // from /speckit.clarify round 3 admin-reactivation lifecycle. These 6
  // events were already in data-model.md § 4 + spec.md FR-005a-c +
  // Wave E impl `renewal-audit-emitter.ts` F8_AUDIT_EVENT_TYPES tuple;
  // contract had drifted out of sync until now.
  | { type: 'lapsed_member_admin_reactivated'; payload: LapsedMemberAdminReactivatedPayload }
  | { type: 'lapsed_member_admin_reactivation_rejected'; payload: LapsedMemberAdminReactivationRejectedPayload }
  | { type: 'lapsed_member_admin_reactivation_timed_out'; payload: LapsedMemberAdminReactivationTimedOutPayload }
  | { type: 'member_auto_reactivation_blocked'; payload: MemberAutoReactivationBlockedPayload }
  | { type: 'member_auto_reactivation_unblocked'; payload: MemberAutoReactivationUnblockedPayload }
  | { type: 'renewal_cycle_price_frozen'; payload: RenewalCyclePriceFrozenPayload }

export interface RenewalAuditEmitter {
  emit(event: F8AuditEvent, context: AuditContext): Promise<void>
}

export interface AuditContext {
  tenantId: TenantId
  actorUserId: UserId | null    // null for cron / system actors
  actorRole: 'admin' | 'manager' | 'member' | 'cron' | 'webhook' | 'system'
  correlationId: string         // OTel trace ID for joining log + trace
}
```

---

## 2. Payload schemas (TypeScript)

```ts
export interface RenewalCycleCreatedPayload {
  member_id: MemberId
  cycle_id: CycleId
  period_from: ISO8601String
  period_to: ISO8601String
  plan_id: PlanId
  tier_bucket: TierBucket
  cycle_length_months: number
}

export interface RenewalCycleCancelledPayload {
  member_id: MemberId
  cycle_id: CycleId
  reason: string                // max 500 chars
}

export interface RenewalCycleCompletedOfflinePayload {
  member_id: MemberId
  cycle_id: CycleId
  invoice_id: InvoiceId
  payment_method: 'bank_transfer' | 'cash' | 'cheque'
  payment_reference: string
  payment_date: ISO8601String
}

export interface RenewalLapsedPayload {
  member_id: MemberId
  cycle_id: CycleId
  expires_at: ISO8601String
  lapsed_at: ISO8601String       // expires_at + grace_period_days
}

export interface RenewalReminderSentPayload {
  member_id: MemberId
  cycle_id: CycleId
  step_id: string                // 't-30.email'
  channel: 'email' | 'task'
  template_id: string | null
  delivery_id: string | null     // Resend message id for email
  year_in_cycle: number
  // actor_user_id is in AuditContext, not payload
}

export interface RenewalReminderSkippedPayload {
  member_id: MemberId
  cycle_id: CycleId
  step_id: string
  reason:
    | 'already_sent'
    | 'email_unverified'
    | 'member_opted_out'
    | 'member_archived'
    | 'feature_flag_disabled'
    | 'read_only_mode'
    | 'member_below_min_tenure_for_step'
    | 'multi_year_non_final_year'
}

export interface RenewalReminderSendFailedPayload {
  member_id: MemberId
  cycle_id: CycleId
  step_id: string
  failure_reason: string         // Resend API error class
  retry_count: number
}

export interface RenewalScheduleRescheduledPayload {
  member_id: MemberId
  cycle_id: CycleId
  old_tier_bucket: TierBucket
  new_tier_bucket: TierBucket
  cancelled_step_ids: string[]
  new_step_ids: string[]
}

export interface RenewalSchedulePolicyUpdatedPayload {
  tier_bucket: TierBucket
  change_diff: { added: string[]; removed: string[]; modified: string[] }
}

export interface RenewalSelfServiceInitiatedPayload {
  member_id: MemberId
  cycle_id: CycleId
  token_iat: number              // epoch ms when token was issued
}

export interface RenewalInvoiceCreatedPayload {
  member_id: MemberId
  cycle_id: CycleId
  invoice_id: InvoiceId
  plan_id: PlanId
  amount_thb: number             // decimal as cents-style integer
  vat_thb: number
  period_from: ISO8601String
  period_to: ISO8601String
}

export interface RenewalWithPlanChangePayload {
  member_id: MemberId
  cycle_id: CycleId
  invoice_id: InvoiceId
  from_plan_id: PlanId
  to_plan_id: PlanId
}

export interface RenewalPaymentFailedPayload {
  member_id: MemberId
  cycle_id: CycleId
  invoice_id: InvoiceId
  failure_reason: string         // F5 error class
}

export interface RenewalCompletedPayload {
  member_id: MemberId
  cycle_id: CycleId
  invoice_id: InvoiceId
  paid_at: ISO8601String
  new_expires_at: ISO8601String
}

export interface RenewalCompletedPostLapsePayload extends RenewalCompletedPayload {
  was_lapsed_at: ISO8601String
}

export interface RenewalTokenInvalidPayload {
  sha256_token_hash: string      // hex-encoded sha256 of the raw token (NOT the token itself)
  reason: 'malformed' | 'mac_mismatch' | 'expired' | 'replay' | 'cross_tenant'
  // tenant_id may be NULL when reason='malformed' (couldn't extract from payload)
  attempted_tenant_id?: TenantId
}

export interface RenewalKillSwitchBlockedPayload {
  route: string
  // actor_user_id is in AuditContext if known, NULL for unauthenticated cron
}

export interface RenewalCrossTenantProbePayload {
  attempted_tenant_id: TenantId
  attempted_member_id?: MemberId
  attempted_cycle_id?: CycleId
}

export interface RenewalCrossMemberProbePayload {
  actor_member_id: MemberId
  attempted_member_id: MemberId
}

export interface RenewalReminderDeferredReadOnlyPayload {
  cycle_id: CycleId
  step_id: string
}

export interface LapsedMemberActionBlockedPayload {
  member_id: MemberId
  attempted_route: string
  attempted_action: string
}

export interface MemberEmailUnverifiedThresholdCrossedPayload {
  member_id: MemberId
  trigger: 'hard_bounce' | 'soft_streak' | 'soft_rolling'
  bounce_count: number
  classification: 'permanent' | 'transient'
}

export interface F8RoleViolationBlockedPayload {
  attempted_route: string
  attempted_action: string
  // actor_user_id and actor_role in AuditContext
}

export interface AtRiskScoreRecomputedPayload {
  member_id: MemberId
  score: number
  factors: Record<string, number>   // { events_attended_12m: 0, invoices_overdue: 1, ... }
  threshold_band: 'healthy' | 'warning' | 'at-risk' | 'critical'
  active_max: 70 | 100               // depends on F6 readiness
}

export interface AtRiskScoreThresholdCrossedPayload {
  member_id: MemberId
  from_band: 'healthy' | 'warning' | 'at-risk' | 'critical'
  to_band: 'healthy' | 'warning' | 'at-risk' | 'critical'
}

export interface AtRiskSnoozedPayload {
  member_id: MemberId
  snooze_duration_days: 7 | 30 | 90
  snoozed_until: ISO8601String
}

export interface AtRiskOutreachRecordedPayload {
  member_id: MemberId
  outreach_id: OutreachId
  channel: 'email' | 'phone' | 'meeting'
  template_id: string | null
}

export interface AtRiskSkippedBelowMinTenurePayload {
  member_id: MemberId
  tenure_days: number
}

export interface AtRiskComputePartialFailurePayload {
  error_class: string
  members_processed: number
  members_failed: number
}

export interface TierUpgradeSuggestedPayload {
  member_id: MemberId
  suggestion_id: SuggestionId
  from_plan_id: PlanId
  to_plan_id: PlanId
  reason_code: 'declared_turnover_above_threshold' | 'paid_invoice_volume_above_threshold' | 'multi_signal'
  evidence: Record<string, unknown>
}

export interface TierUpgradeAcceptedPayload {
  suggestion_id: SuggestionId
  member_id: MemberId
  target_apply_at_cycle_id: CycleId
}

export interface TierUpgradePendingMemberNotifiedPayload {
  suggestion_id: SuggestionId
  member_id: MemberId
  target_plan_id: PlanId
  effective_at: ISO8601String
  delivery_id: string
}

export interface TierUpgradePendingAdminVerificationDuePayload {
  suggestion_id: SuggestionId
  task_id: TaskId
  due_at: ISO8601String
}

export interface TierUpgradeAppliedAtRenewalPayload {
  suggestion_id: SuggestionId
  member_id: MemberId
  from_plan_id: PlanId
  to_plan_id: PlanId
  applied_at_cycle_id: CycleId
  invoice_id: InvoiceId
}

export interface TierUpgradePendingSupersededByManualChangePayload {
  suggestion_id: SuggestionId
  manual_change_actor_user_id: UserId
  manual_change_to_plan_id: PlanId
}

export interface TierUpgradeDismissedPayload {
  suggestion_id: SuggestionId
  dismissed_reason: string
  suppressed_until: ISO8601String
}

export interface TierUpgradeAlreadyAtTargetPayload {
  member_id: MemberId
  current_plan_id: PlanId
  evaluated_target_plan_id: PlanId
}

export interface TierUpgradeTenantDisabledPayload {
  // tenant_id from AuditContext
}

export interface TierUpgradeSkippedNoThresholdsPayload {
  // tenant_id from AuditContext
}

export interface EscalationTaskCreatedPayload {
  task_id: TaskId
  member_id: MemberId
  cycle_id: CycleId | null
  task_type: string
  due_at: ISO8601String
  assigned_to_role: 'admin' | 'manager' | 'executive_director'
  assigned_to_user_id?: UserId
}

export interface EscalationTaskCompletedPayload {
  task_id: TaskId
  outcome_note?: string
}

export interface EscalationTaskSkippedPayload {
  task_id: TaskId
  skipped_reason: string
}

export interface EscalationTaskReassignedPayload {
  task_id: TaskId
  from_user_id?: UserId
  to_user_id: UserId
}

// Added at /speckit.critique 2026-05-03 round 1

export interface CronDispatchOrchestratedPayload {
  job: 'dispatch' | 'at-risk-recompute' | 'tier-upgrade-evaluate'
  tenants_enqueued: number
  tenants_succeeded: number
  tenants_failed: number
  duration_ms: number
}

export interface RenewalReminderSendFailedPermanentPayload {
  member_id: MemberId
  cycle_id: CycleId
  step_id: string
  failure_reason: string
  total_retry_attempts: number
  first_attempted_at: ISO8601String
  given_up_at: ISO8601String
}

export interface RenewalReminderRetriedPayload {
  member_id: MemberId
  cycle_id: CycleId
  step_id: string
  retry_attempt: number
  prior_failure_reason: string
}

export interface RenewalSkippedNoJoinedAtPayload {
  member_id: MemberId
  // tenant_id from AuditContext
}

export interface TierUpgradePendingOrphanDetectedPayload {
  suggestion_id: SuggestionId
  member_id: MemberId
  target_apply_at_cycle_id: CycleId
  target_cycle_status: 'completed' | 'lapsed' | 'cancelled'
  suggestion_age_days: number
}

// --- /speckit.clarify round 3 admin-reactivation lifecycle (synced at
//     /speckit.implement Wave E verify-run C1, 2026-05-04). Payload
//     shapes mirror data-model.md § 4 entries. ---

export interface LapsedMemberAdminReactivatedPayload {
  member_id: MemberId
  cycle_id: CycleId
  actor_user_id: UserId
}

export interface LapsedMemberAdminReactivationRejectedPayload {
  member_id: MemberId
  cycle_id: CycleId
  actor_user_id: UserId
  refund_id: RefundId
  credit_note_id: CreditNoteId
}

export interface LapsedMemberAdminReactivationTimedOutPayload {
  member_id: MemberId
  cycle_id: CycleId
  entered_pending_at: ISO8601String
  refund_id: RefundId
  credit_note_id: CreditNoteId
}

export interface MemberAutoReactivationBlockedPayload {
  member_id: MemberId
  actor_user_id: UserId
  reason: string                // max 500 chars
}

export interface MemberAutoReactivationUnblockedPayload {
  member_id: MemberId
  actor_user_id: UserId
  reason: string                // max 500 chars
}

export interface RenewalCyclePriceFrozenPayload {
  cycle_id: CycleId
  plan_id: PlanId
  frozen_price_thb: string      // decimal(12,2) string
  frozen_term_months: number
  frozen_currency: 'THB'
}
```

---

## 3. Retention

All 54 events: `retention_years = 5`. This is the F8 default — no tax-document overlap means the F4 10-year backfill (per F5 R2-E4 Review-Gate blocker) does NOT apply.

---

## 4. Forbidden in payloads (extends FR-049)

The following MUST NEVER appear in any F8 audit event payload:

- Plaintext member email addresses (use `email_hash = sha256(tenant_id + ':' + email_lower)` if cross-event correlation is needed)
- Renewal-link tokens (raw OR verified) — use `sha256_token_hash` only
- Session cookies / authentication tokens
- Payment-method details (handled by F5; F8 should never see them)
- Resend transactional API key
- `RENEWAL_LINK_TOKEN_SECRET`

Pino redact list extended in `src/lib/logger.ts` to enforce these at the structured-log layer.

---

## 5. Audit emitter test contract

`tests/contract/audit-port.contract.test.ts` MUST verify that for each of the 43 event types:
1. The event constructor produces a payload matching the declared TS type (compile-time check passes)
2. The runtime payload is JSON-serialisable (no functions, no symbols)
3. Forbidden fields (per § 4) are absent
4. The pino redact list catches each forbidden field if accidentally included
