/**
 * F8 — Renewals public barrel.
 *
 * Module bootstrapped at /speckit.implement Phase 1 (T002).
 * All cross-module access from outside `src/modules/renewals/` MUST go
 * through this barrel (enforced by `eslint.config.mjs` no-restricted-imports
 * rule per Constitution Principle III).
 *
 * Wave-D-shipped surface (Domain layer T030-T040):
 *   - Value objects: TierBucket, CycleStatus, RiskBand, ReminderStep
 *   - Entities: RenewalCycle, TierUpgradeSuggestion, RenewalEscalationTask,
 *     RenewalLinkToken, AtRiskScore, TenantRenewalSettings,
 *     TenantRenewalSchedulePolicy
 *
 * Application ports (Wave E T041-T051) + Drizzle adapters + composition-
 * root factories will land here as subsequent waves ship.
 */

// --- Domain value objects ---------------------------------------------------
// Branded-type smart constructors are exported via `parse*` only (returns
// Result<T,E>). The unsafe `as*` casts are intentionally NOT in the
// barrel — they exist for Drizzle row mappers in `domain/value-objects/*`
// which can deep-import within the renewals module. External callers
// (Application use-cases, Presentation, cross-module) MUST go through
// `parse*` so type-safety is enforced at the boundary.
export {
  TIER_BUCKETS,
  parseTierBucket,
  isTierBucket,
  type TierBucket,
  type TierBucketError,
} from './domain/value-objects/tier-bucket';

export {
  CYCLE_STATUSES,
  TERMINAL_CYCLE_STATUSES,
  parseCycleStatus,
  isTerminalCycleStatus,
  canTransition,
  assertCanTransition,
  type CycleStatus,
  type TerminalCycleStatus,
  type CycleStatusError,
  type CycleTransitionError,
} from './domain/value-objects/cycle-status';

export {
  RISK_BANDS,
  RISK_BAND_THRESHOLDS,
  parseRiskBand,
  asRiskBand,
  bandForScore,
  bandForScoreProportional,
  isAtRiskWidgetBand,
  type RiskBand,
  type RiskBandError,
} from './domain/value-objects/risk-band';

export {
  REMINDER_CHANNELS,
  REMINDER_ASSIGNEE_ROLES,
  REMINDER_OFFSET_DAYS_MIN,
  REMINDER_OFFSET_DAYS_MAX,
  parseReminderStep,
  reminderStepToJson,
  type ReminderStep,
  type ReminderStepEmail,
  type ReminderStepTask,
  type ReminderChannel,
  type ReminderAssigneeRole,
  type ReminderStepError,
} from './domain/value-objects/reminder-step';

// --- Domain entities --------------------------------------------------------
export {
  CLOSED_REASONS,
  parseCycleId,
  assertCycleInvariants,
  cycleFrozenPriceSatang,
  isOverdue,
  daysUntilExpiry,
  isMembershipLapsed,
  deriveMembershipAccess,
  type CycleId,
  type CycleIdError,
  type ClosedReason,
  type RenewalCycle,
  type CycleInvariantError,
  type MembershipAccessDecision,
  type MembershipAccessReason,
} from './domain/renewal-cycle';

export {
  TIER_UPGRADE_STATUSES,
  TERMINAL_TIER_UPGRADE_STATUSES,
  TIER_UPGRADE_REASON_CODES,
  parseSuggestionId,
  assertSuggestionInvariants,
  isTerminalTierUpgradeStatus,
  type SuggestionId,
  type SuggestionIdError,
  type TierUpgradeStatus,
  type TerminalTierUpgradeStatus,
  type TierUpgradeReasonCode,
  type TierUpgradeEvidence,
  type TierUpgradeSuggestion,
  type TierUpgradeInvariantError,
} from './domain/tier-upgrade-suggestion';

export {
  ESCALATION_TASK_STATUSES,
  ESCALATION_ASSIGNEE_ROLES,
  parseTaskId,
  assertEscalationTaskInvariants,
  isOverdueTask,
  type TaskId,
  type TaskIdError,
  type EscalationTaskStatus,
  type EscalationAssigneeRole,
  type RenewalEscalationTask,
  type EscalationTaskInvariantError,
} from './domain/renewal-escalation-task';

// Outreach-channel canonical list (mirrors `at_risk_outreach.channel`
// CHECK at migration 0090) — consumed by the at-risk OutreachDialog
// channel <Select> in Presentation.
export {
  OUTREACH_CHANNELS,
  type OutreachChannel,
} from './domain/at-risk-outreach';

export {
  RENEWAL_LINK_TOKEN_VERSION,
  RENEWAL_LINK_TOKEN_TTL_DAYS,
  RENEWAL_LINK_TOKEN_TTL_SECONDS,
  buildPayload,
  parsePayload,
  secondsUntilExpiry,
  type RenewalLinkTokenPayload,
  type RenewalLinkTokenVersion,
  type TokenPayloadError,
} from './domain/renewal-link-token';

// Phase 6 Wave A1+C — Domain pure function re-exported under
// `computeAtRiskScorePure` so the public name `computeAtRiskScore`
// can carry the Application use-case (T154 — orchestrates persistence
// + audit emit on top of the Domain formula). Direct Domain consumers
// (tests + the AtRiskScorer adapter) keep using `./domain/...` paths.
export {
  computeAtRiskScore as computeAtRiskScorePure,
  AT_RISK_FACTOR_WEIGHTS,
  F6_ACTIVE_MAX,
  F6_INACTIVE_MAX,
  type AtRiskFactors,
  type AtRiskComputeContext,
  type AtRiskScoreResult,
  type FactorContribution,
} from './domain/at-risk-score';


export {
  GRACE_PERIOD_DAYS_MIN,
  GRACE_PERIOD_DAYS_MAX,
  MIN_TENURE_DAYS_MIN,
  MIN_TENURE_DAYS_MAX,
  assertSettingsInvariants,
  defaultSettings,
  type TenantRenewalSettings,
  type SettingsInvariantError,
} from './domain/tenant-renewal-settings';

export {
  parseSchedulePolicySteps,
  findStepForDate,
  findDueStepsForDate,
  REMINDER_CATCH_UP_LOOKBACK_DAYS,
  type TenantRenewalSchedulePolicy,
  type SchedulePolicyError,
} from './domain/tenant-renewal-schedule-policy';

export {
  classifyMembershipPayment,
  type MembershipPaymentClassificationInput,
  type MembershipPaymentClassification,
} from './domain/classify-membership-payment';

// --- Application ports (Wave E T041-T051) -----------------------------------
// Pure interfaces — no adapter implementations until Wave G+.
export {
  CycleNotFoundError,
  CycleTransitionConflictError,
  type RenewalCycleRepo,
  type NewRenewalCycleInput,
  type ListRenewalCyclesOpts,
  type RenewalCyclePage,
} from './application/ports/renewal-cycle-repo';

export {
  ReminderEventNotFoundError,
  type RenewalReminderEventRepo,
  type ReminderEvent,
  type ReminderEventChannel,
  type ReminderEventStatus,
  type NewReminderEventInput,
  type ReminderEventTransitionInput,
} from './application/ports/renewal-reminder-event-repo';

export {
  TierUpgradeOpenConflictError,
  TierUpgradeStatusConflictError,
  TierUpgradeSuggestionNotFoundError,
  type TierUpgradeSuggestionRepo,
  type NewTierUpgradeSuggestionInput,
} from './application/ports/tier-upgrade-suggestion-repo';

export {
  ESCALATION_UNASSIGNED_FILTER,
  EscalationTaskNotFoundError,
  InvalidCursorError,
  type AssigneeFilter,
  type RenewalEscalationTaskRepo,
  type NewEscalationTaskInput,
  type ListEscalationTasksOpts,
  type EscalationTaskPage,
  type EscalationTaskAdminQueuePage,
  type EscalationTaskWithMember,
} from './application/ports/renewal-escalation-task-repo';

export type {
  TenantRenewalSettingsRepo,
  UpdateTenantRenewalSettingsInput,
} from './application/ports/tenant-renewal-settings-repo';

export type {
  TenantRenewalSchedulePolicyRepo,
} from './application/ports/tenant-renewal-schedule-policy-repo';

export type {
  AtRiskOutreachReadRepo,
  OutreachWithinWindowResult,
} from './application/ports/at-risk-outreach-read-repo';

export type {
  MemberRenewalFlagsRepo,
  MemberRenewalFlagsMutationResult,
} from './application/ports/member-renewal-flags-repo';

export type {
  RenewalGateway,
  SendRenewalEmailInput,
  SendRenewalEmailResult,
  SendRenewalEmailError,
  RenewalEmailRecipient,
  SupportedLocale,
} from './application/ports/renewal-gateway';

export type {
  RenewalLinkTokenSigner,
  SignedRenewalLinkToken,
} from './application/ports/renewal-link-token-signer';

export type {
  RenewalLinkTokenVerifier,
  VerifiedRenewalLinkToken,
  VerifyTokenError,
  VerifyTokenContext,
} from './application/ports/renewal-link-token-verifier';

export type {
  EventAttendeesPort,
  EventAttendanceRecord,
  ListAttendancesOpts,
} from './application/ports/event-attendees-port';

export type { AtRiskScorer } from './application/ports/at-risk-scorer';

export {
  F8_AUDIT_EVENT_TYPES,
  F8_AUDIT_RETENTION_YEARS,
  isF8AuditEventType,
  type RenewalAuditEmitter,
  type F8AuditEvent,
  type F8AuditEventType,
  type F8AuditPayloadShapes,
  type F8AuditPayloadFor,
  type AuditContext,
} from './application/ports/renewal-audit-emitter';

export type {
  PipelineQueryOpts,
  PipelineQueryResult,
  PipelineRow,
  PipelineSummary,
  UrgencyBucket,
  // DV-18 — members-without-cycle tray shapes.
  ListMembersWithoutCycleOpts,
  MemberWithoutCycleRow,
  MembersWithoutCyclePage,
} from './application/ports/renewal-cycle-repo';

// Renewals-by-month view-model types (pure Domain).
export type {
  RenewalMonthBucket,
  RenewalMonthSummary,
  RenewalMonthAggregation,
  RawMonthCount,
} from './domain/renewal-month-bucket';

// Renewals-by-month pure helper functions (Task 9) — bar-width scaling +
// BKK month arithmetic, needed by the `RenewalsByMonthSection` server
// component to resolve the `later` bucket's label. Re-exported as values
// (not just types) so Presentation never deep-imports `./domain/**`
// (blocked by the ESLint no-restricted-imports module-barrel rule).
export {
  parseMonthParam,
  barWidthPercent,
  addMonthsToYm,
  bkkYearMonth,
} from './domain/renewal-month-bucket';

// --- Phase 3 use-cases (Wave H2 T056-T059) ---------------------------------
export {
  loadPipeline,
  loadPipelineInputSchema,
  type LoadPipelineInput,
  type LoadPipelineError,
} from './application/use-cases/load-pipeline';

export {
  loadRenewalMonthSummary,
  type LoadRenewalMonthSummaryInput,
} from './application/use-cases/load-renewal-month-summary';

export {
  loadCycleDetail,
  loadCycleDetailInputSchema,
  type LoadCycleDetailInput,
  type LoadCycleDetailOutput,
  type LoadCycleDetailError,
} from './application/use-cases/load-cycle-detail';

export {
  cancelCycle,
  cancelCycleInputSchema,
  type CancelCycleInput,
  type CancelCycleOutput,
  type CancelCycleError,
} from './application/use-cases/cancel-cycle';

export {
  markPaidOffline,
  markPaidOfflineInputSchema,
  type MarkPaidOfflineInput,
  type MarkPaidOfflineOutput,
  type MarkPaidOfflineError,
} from './application/use-cases/mark-paid-offline';

// --- Phase 4 Wave I1a use-cases (T081-T082) -------------------------------
export {
  loadSchedulePolicies,
  loadSchedulePoliciesInputSchema,
  type LoadSchedulePoliciesInput,
  type LoadSchedulePoliciesOutput,
  type LoadSchedulePoliciesError,
} from './application/use-cases/load-schedule-policies';

export {
  updateSchedulePolicy,
  updateSchedulePolicyInputSchema,
  type UpdateSchedulePolicyInput,
  type UpdateSchedulePolicyOutput,
  type UpdateSchedulePolicyError,
} from './application/use-cases/update-schedule-policy';

// --- Phase 4 Wave I2a use-cases (T092) ------------------------------------
export {
  pauseRemindersAfterOutreach,
  pauseRemindersAfterOutreachInputSchema,
  REMINDER_PAUSE_WINDOW_DAYS,
  type PauseRemindersAfterOutreachInput,
  type PauseRemindersAfterOutreachOutput,
  type PauseRemindersAfterOutreachError,
  type PausedResult,
  type NotPausedResult,
} from './application/use-cases/pause-reminders-after-outreach';

// --- Phase 4 Wave I2b use-cases (T091) ------------------------------------
export {
  resetEmailUnverified,
  resetEmailUnverifiedInputSchema,
  MANUAL_OUTREACH_TASK_TYPE,
  type ResetEmailUnverifiedInput,
  type ResetEmailUnverifiedOutput,
  type ResetEmailUnverifiedError,
} from './application/use-cases/reset-email-unverified';

// --- Phase 4 Wave I2c use-cases (T088 + T089) -----------------------------
export {
  dispatchRenewalCycle,
  dispatchRenewalCycleInputSchema,
  DEFAULT_MAX_OFFSET_DAYS,
  DEFAULT_PAGE_SIZE,
  type DispatchRenewalCycleInput,
  type DispatchRenewalCycleOutput,
  type DispatchRenewalCycleError,
  type DispatchRenewalCycleSummary,
} from './application/use-cases/dispatch-renewal-cycle';

export {
  sendReminderNow,
  sendReminderNowInputSchema,
  type SendReminderNowInput,
  type SendReminderNowOutput,
  type SendReminderNowError,
} from './application/use-cases/send-reminder-now';

// --- Phase 6 Wave B (T154 + T155 + T156) at-risk use-cases ---------------
export {
  computeAtRiskScore,
  computeAtRiskScoreInputSchema,
  type ComputeAtRiskScoreInput,
  type ComputeAtRiskScoreOutput,
  type ComputeAtRiskScoreError,
} from './application/use-cases/compute-at-risk-score';

export {
  snoozeAtRiskMember,
  snoozeAtRiskMemberInputSchema,
  type SnoozeAtRiskMemberInput,
  type SnoozeAtRiskMemberOutput,
  type SnoozeAtRiskMemberError,
} from './application/use-cases/snooze-at-risk-member';

export {
  recordAtRiskOutreach,
  recordAtRiskOutreachInputSchema,
  type RecordAtRiskOutreachInput,
  type RecordAtRiskOutreachOutput,
  type RecordAtRiskOutreachError,
} from './application/use-cases/record-at-risk-outreach';

// Phase 6 Wave G T159b — batched cron path (per-tenant cron route uses
// this; per-member computeAtRiskScore stays for admin-triggered single-
// member recomputes).
export {
  recomputeAtRiskScoresBatch,
  recomputeAtRiskScoresBatchInputSchema,
  type RecomputeAtRiskScoresBatchInput,
  type RecomputeAtRiskScoresBatchOutput,
  type RecomputeAtRiskScoresBatchError,
} from './application/use-cases/recompute-at-risk-scores-batch';

// SkipReason enum + DispatchCandidate types are referenced by route
// handlers in Wave I5/I6 — exported via barrel for type-safety.
export {
  SKIP_REASONS,
  type SkipReason,
  type DispatchContext,
  type DispatchOneCycleOutcome,
} from './application/use-cases/_lib/dispatch-one-cycle';

export type {
  DispatchCandidate,
  DispatchCandidateRepo,
  DispatchCandidatePage,
  DispatchCandidateListArgs,
  DispatchCandidateMember,
  DispatchCandidatePrimaryContact,
} from './application/ports/dispatch-candidate-repo';

// --- Phase 4 Wave I2d use-case (T090) -------------------------------------
export {
  detectBounceThreshold,
  detectBounceThresholdInputSchema,
  BOUNCE_THRESHOLD_HARD,
  BOUNCE_THRESHOLD_SOFT_IN_CYCLE,
  BOUNCE_THRESHOLD_SOFT_30D,
  BOUNCE_TRIGGERS,
  type DetectBounceThresholdInput,
  type DetectBounceThresholdOutcome,
  type DetectBounceThresholdError,
  type BounceTrigger,
} from './application/use-cases/detect-bounce-threshold';

export type {
  BounceEventQuery,
  BounceCounts,
} from './application/ports/bounce-event-query';

// --- Phase 4 Wave I2e — FR-010a retry budget ------------------------------
export {
  retryFailedReminders,
  retryFailedRemindersInputSchema,
  DEFAULT_RETRY_PAGE_SIZE,
  type RetryFailedRemindersInput,
  type RetryFailedRemindersOutput,
  type RetryFailedRemindersError,
  type RetryFailedRemindersSummary,
} from './application/use-cases/retry-failed-reminders';

export { RETRY_BUDGET_HOURS } from './application/use-cases/_lib/dispatch-one-cycle';

// --- Phase 4 Wave I4 — cross-cutting webhook lookups ---------------------
export {
  lookupMemberByEmail,
  lookupMemberByContactId,
  type MemberLookupResult,
} from './infrastructure/lookup-member-by-email';

// --- Phase 5 Wave A + A.5 + B + C use-cases (T120-T138 US3) ----------------
export {
  verifyRenewalLinkToken,
  verifyRenewalLinkTokenInputSchema,
  type VerifyRenewalLinkTokenInput,
  type VerifyRenewalLinkTokenSuccess,
  type VerifyRenewalLinkTokenError,
} from './application/use-cases/verify-renewal-link-token';

export {
  loadRenewalSummary,
  loadRenewalSummaryInputSchema,
  type LoadRenewalSummaryInput,
  type LoadRenewalSummaryOutput,
  type LoadRenewalSummaryError,
  type BenefitConsumptionEntry,
} from './application/use-cases/load-renewal-summary';

// Pass A · Section 1 — admin member-detail "Renewal & Health" card read.
export {
  loadMemberRenewalStatus,
  type LoadMemberRenewalStatusInput,
  type LoadMemberRenewalStatusOutput,
  type LoadMemberRenewalStatusError,
} from './application/use-cases/load-member-renewal-status';

// Pass A · Section 5 — Members-directory batch "lapsed" badge read.
export {
  loadMembersMembershipStatus,
  type LoadMembersMembershipStatusInput,
} from './application/use-cases/load-members-membership-status';

// DV-18 — read-only "Members without renewal cycle" tray for the
// `/admin/renewals` dashboard.
export {
  loadMembersWithoutCycle,
  MEMBERS_WITHOUT_CYCLE_DEFAULT_LIMIT,
  type LoadMembersWithoutCycleInput,
  type LoadMembersWithoutCycleOutput,
} from './application/use-cases/load-members-without-cycle';

export {
  confirmRenewal,
  confirmRenewalInputSchema,
  selfServiceFailureReason,
  type ConfirmRenewalInput,
  type ConfirmRenewalOutput,
  type ConfirmRenewalError,
  type SelfServiceFailureReason,
} from './application/use-cases/confirm-renewal';

export {
  adminRenewLapsedMember,
  adminRenewLapsedMemberInputSchema,
  type AdminRenewLapsedMemberInput,
  type AdminRenewLapsedMemberOutput,
  type AdminRenewLapsedMemberError,
  type AdminRenewLapsedMemberDeps,
} from './application/use-cases/admin-renew-lapsed-member';

export type {
  MemberPlanLookupPort,
  MemberPlanLookupResult,
} from './application/ports/member-plan-lookup-port';

export {
  // Round 2 (S-11): split into InTx + wrapper variants. F4 onPaidCallback
  // path uses `markCycleCompleteInTx` to participate in F4's tx;
  // standalone callers use the wrapper.
  markCycleCompleteInTx,
  markCycleCompleteFromInvoicePaid,
  type MarkCycleCompleteOutcome,
  type MarkCycleCompleteDeps,
} from './application/use-cases/mark-cycle-complete-from-invoice-paid';

export {
  optOutRenewalReminders,
  optOutRenewalRemindersInputSchema,
  type OptOutRenewalRemindersInput,
  type OptOutRenewalRemindersOutput,
  type OptOutRenewalRemindersError,
} from './application/use-cases/opt-out-renewal-reminders';

export {
  optInRenewalReminders,
  optInRenewalRemindersInputSchema,
  type OptInRenewalRemindersInput,
  type OptInRenewalRemindersOutput,
  type OptInRenewalRemindersError,
} from './application/use-cases/opt-in-renewal-reminders';

export {
  blockAutoReactivation,
  blockAutoReactivationInputSchema,
  type BlockAutoReactivationInput,
  type BlockAutoReactivationOutput,
  type BlockAutoReactivationError,
} from './application/use-cases/block-auto-reactivation';

export {
  unblockAutoReactivation,
  unblockAutoReactivationInputSchema,
  type UnblockAutoReactivationInput,
  type UnblockAutoReactivationOutput,
  type UnblockAutoReactivationError,
} from './application/use-cases/unblock-auto-reactivation';

export {
  adminReactivateLapsedCycle,
  adminReactivateLapsedCycleInputSchema,
  type AdminReactivateLapsedCycleInput,
  type AdminReactivateLapsedCycleOutput,
  type AdminReactivateLapsedCycleError,
} from './application/use-cases/admin-reactivate-lapsed-cycle';

export {
  adminRejectReactivation,
  adminRejectReactivationInputSchema,
  type AdminRejectReactivationInput,
  type AdminRejectReactivationOutput,
  type AdminRejectReactivationError,
} from './application/use-cases/admin-reject-reactivation';

export {
  reconcilePendingReactivations,
  reconcilePendingReactivationsInputSchema,
  type ReconcilePendingReactivationsInput,
  type ReconcilePendingReactivationsOutput,
  type ReconcilePendingReactivationsError,
} from './application/use-cases/reconcile-pending-reactivations';

// 070 F8 item #18 — read-only "Pending review" discovery list for the
// `/admin/renewals` dashboard.
export {
  loadPendingReactivationReview,
  PENDING_REVIEW_DEFAULT_PAGE_SIZE,
  type LoadPendingReactivationReviewInput,
  type LoadPendingReactivationReviewOutput,
} from './application/use-cases/load-pending-reactivation-review';

// --- T115a Phase 5 wave K24 — lapseCyclesOnGraceExpiry --------------------
export {
  lapseCyclesOnGraceExpiry,
  lapseCyclesOnGraceExpiryInputSchema,
  type LapseCyclesOnGraceExpiryInput,
  type LapseCyclesOnGraceExpiryOutput,
  type LapseCyclesOnGraceExpiryError,
} from './application/use-cases/lapse-cycles-on-grace-expiry';

// --- F8-completion slice 2 — enterAwaitingPaymentOnExpiry (T-0 cron) ------
export {
  enterAwaitingPaymentOnExpiry,
  enterAwaitingPaymentOnExpiryInputSchema,
  type EnterAwaitingPaymentOnExpiryInput,
  type EnterAwaitingPaymentOnExpiryOutput,
  type EnterAwaitingPaymentOnExpiryError,
} from './application/use-cases/enter-awaiting-payment-on-expiry';

// --- Phase 7 use-cases (T179-T188a US5 Auto Tier-Upgrade Suggestions) -----
export {
  evaluateTierUpgrade,
  evaluateTierUpgradeInputSchema,
  DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
  type EvaluateTierUpgradeInput,
  type EvaluateTierUpgradeOutput,
  type EvaluateTierUpgradeError,
} from './application/use-cases/evaluate-tier-upgrade';

export {
  acceptTierUpgrade,
  acceptTierUpgradeInputSchema,
  type AcceptTierUpgradeInput,
  type AcceptTierUpgradeOutput,
  type AcceptTierUpgradeError,
} from './application/use-cases/accept-tier-upgrade';

export {
  dismissTierUpgrade,
  dismissTierUpgradeInputSchema,
  type DismissTierUpgradeInput,
  type DismissTierUpgradeOutput,
  type DismissTierUpgradeError,
} from './application/use-cases/dismiss-tier-upgrade';

export {
  escalateTierUpgrade,
  escalateTierUpgradeInputSchema,
  type EscalateTierUpgradeInput,
  type EscalateTierUpgradeOutput,
  type EscalateTierUpgradeError,
} from './application/use-cases/escalate-tier-upgrade';

export {
  applyPendingTierUpgrade,
  applyPendingTierUpgradeInTx,
  applyPendingTierUpgradeInputSchema,
  type ApplyPendingTierUpgradeInput,
  type ApplyPendingTierUpgradeOutput,
  type ApplyPendingTierUpgradeError,
  type ApplyTierUpgradeActor,
} from './application/use-cases/apply-pending-tier-upgrade';

// 070 Item D — shared F2 scheduled-plan-change finaliser (post-commit
// half of the tier-upgrade-apply cascade), reused by the online F4
// invoice-paid callback + the offline admin mark-paid path.
export {
  finaliseF2PlanChangeOnPaid,
  defaultOnlineF2Actor,
  type FinaliseF2Actor,
} from './application/use-cases/finalise-f2-plan-change-on-paid';

export {
  supersedePendingTierUpgrade,
  supersedePendingTierUpgradeInTx,
  supersedePendingTierUpgradeInputSchema,
  type SupersedePendingTierUpgradeInput,
  type SupersedePendingTierUpgradeOutput,
  type SupersedePendingTierUpgradeError,
} from './application/use-cases/supersede-pending-tier-upgrade';

export {
  reconcilePendingApplications,
  reconcilePendingApplicationsInputSchema,
  type ReconcilePendingApplicationsInput,
  type ReconcilePendingApplicationsOutput,
  type ReconcilePendingApplicationsError,
} from './application/use-cases/reconcile-pending-applications';

// F8 Phase 8 (US6 Manual Escalation Task Queue) — T208–T211 use-cases.
export {
  createEscalationTask,
  createEscalationTaskInputSchema,
  type CreateEscalationTaskInput,
  type CreateEscalationTaskOutput,
  type CreateEscalationTaskError,
} from './application/use-cases/create-escalation-task';

export {
  completeEscalationTask,
  completeEscalationTaskInputSchema,
  type CompleteEscalationTaskInput,
  type CompleteEscalationTaskOutput,
  type CompleteEscalationTaskError,
} from './application/use-cases/complete-escalation-task';

export {
  skipEscalationTask,
  skipEscalationTaskInputSchema,
  type SkipEscalationTaskInput,
  type SkipEscalationTaskOutput,
  type SkipEscalationTaskError,
} from './application/use-cases/skip-escalation-task';

export {
  reassignEscalationTask,
  reassignEscalationTaskInputSchema,
  type ReassignEscalationTaskInput,
  type ReassignEscalationTaskOutput,
  type ReassignEscalationTaskError,
} from './application/use-cases/reassign-escalation-task';

export {
  rescheduleOnPlanChange,
  rescheduleOnPlanChangeInTx,
  rescheduleOnPlanChangeInputSchema,
  type RescheduleOnPlanChangeInput,
  type RescheduleOnPlanChangeOutput,
  type RescheduleOnPlanChangeError,
} from './application/use-cases/reschedule-on-plan-change';

// F8 Phase 7 — F2 → F8 plan-change bridge (factory for the listener
// array consumed by F3's `changeMemberPlan` use-case).
export {
  f8OnManualPlanChangeCallbacks,
} from './infrastructure/ports-adapters/f2-plan-change-bridge';

// F8-completion Slice 1 · Task 1.6 — F3 → F8 create-member onboarding
// bridge (factory for the listener array consumed by F3's `createMember`
// use-case; creates the new member's initial renewal cycle post-commit).
export {
  f8OnCreateMemberCallbacks,
} from './infrastructure/ports-adapters/f8-on-create-member-callbacks';

// F8 Phase 7 review-fix C-TYPE-1 — canonical event shape (was duplicated
// across F3 + F8 bridge before consolidation).
export type {
  ManualPlanChangeEvent,
  ManualPlanChangeListener,
} from './application/ports/manual-plan-change-event';

// F8 Phase 7 — Phase 7-extended port surfaces (admin queue + cron).
export type {
  TierUpgradeEvalCandidate,
  TierUpgradeEvalCandidatePage,
  TierUpgradeEvalCandidateListArgs,
  TierUpgradeEvalCandidateRepo,
} from './application/ports/tier-upgrade-eval-candidate-repo';

export type {
  PlanCatalogEntry,
  PlanCatalogPort,
} from './application/ports/plan-catalog-port';

// --- Phase 9 / T238 — F3 archival/erasure cascade -------------------------
// Cancel in-flight renewal cycles owned by an archived/erased member.
// Invoked from F3's `archive-member` use-case via the
// `RenewalsCascadePort` adapter at
// `src/modules/members/infrastructure/adapters/renewals-cascade-adapter.ts`.
// Reuses `renewal_cycle_cancelled` audit event with a system-actor +
// cascade-reason discriminator (no new pgEnum value needed).
export {
  cancelInFlightCyclesForMember,
  type CancelInFlightCyclesForMemberInput,
  type CancelInFlightCyclesForMemberOutput,
  type CancelInFlightCyclesForMemberError,
  type RenewalsCascadeReason,
} from './application/use-cases/cancel-in-flight-cycles-for-member';

// --- Cluster 4 (2026-07-12) — F3 undelete → F8 cycle RESTORE ---------------
// Symmetric counterpart of `cancelInFlightCyclesForMember`. Idempotently
// re-creates ONE active renewal cycle for an un-deleted member (anchored to
// the current membership period via `createCycleInTx` + `anchorToCurrentPeriod`)
// so the member re-appears in the renewal pipeline. Invoked from F3's
// `undelete-member` use-case via the `RenewalsCascadePort` adapter at
// `src/modules/members/infrastructure/adapters/renewals-cascade-adapter.ts`.
// Reuses the existing `renewal_cycle_created` audit event — no new pgEnum value.
export {
  restoreCycleForMember,
  type RestoreCycleForMemberDeps,
  type RestoreCycleForMemberInput,
  type RestoreCycleForMemberOutput,
  type RestoreCycleForMemberError,
} from './application/use-cases/restore-cycle-for-member';

// --- Phase 9 retrofit (PR #25) — prune-consumed-tokens weekly cron --------
// Closes the doc-vs-code drift discovered post-merge between
// `docs/runbooks/cron-jobs.md` (which documented the F8 token-prune
// row + section as "NEW — F8 Phase 9") and the absence of a route
// handler. Mirrors `reconcile-pending-applications` pattern (single-
// route housekeeping, no fan-out, weekly Sat 04:00 Asia/Bangkok).
// PRUNE_RETENTION_DAYS deliberately NOT exported — only the colocated
// unit test consumes the constant (asserts value = 60 per
// data-model.md § 2.8) and tests can deep-import within the module per
// established convention. Keeping it out of the barrel minimises the
// public surface area.
export {
  pruneConsumedTokens,
  type PruneConsumedTokensInput,
  type PruneConsumedTokensOutput,
  type PruneConsumedTokensError,
} from './application/use-cases/prune-consumed-tokens';

// --- Composition root (Wave G T054 + H1 expansions) ------------------------
export {
  makeRenewalsDeps,
  // Lean factory for the members-directory lapsed-badge read — builds only
  // `cyclesRepo` + `clock` (067 #4: avoids the ~20-adapter makeRenewalsDeps
  // on the directory hot path).
  makeMembersMembershipStatusDeps,
  f8OnPaidCallbacks,
} from './infrastructure/renewals-deps';
export type { RenewalsDeps } from './infrastructure/renewals-deps';
