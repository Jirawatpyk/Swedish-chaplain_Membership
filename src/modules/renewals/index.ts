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
  bandForScore,
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
  type CycleId,
  type CycleIdError,
  type ClosedReason,
  type RenewalCycle,
  type CycleInvariantError,
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

export {
  computeAtRiskScore,
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
  type TenantRenewalSchedulePolicy,
  type SchedulePolicyError,
} from './domain/tenant-renewal-schedule-policy';

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
  TierUpgradeSuggestionNotFoundError,
  type TierUpgradeSuggestionRepo,
  type NewTierUpgradeSuggestionInput,
} from './application/ports/tier-upgrade-suggestion-repo';

export {
  EscalationTaskNotFoundError,
  type RenewalEscalationTaskRepo,
  type NewEscalationTaskInput,
  type ListEscalationTasksOpts,
  type EscalationTaskPage,
} from './application/ports/renewal-escalation-task-repo';

export type {
  TenantRenewalSettingsRepo,
  UpdateTenantRenewalSettingsInput,
} from './application/ports/tenant-renewal-settings-repo';

export type {
  TenantRenewalSchedulePolicyRepo,
} from './application/ports/tenant-renewal-schedule-policy-repo';

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
} from './application/ports/renewal-cycle-repo';

// --- Phase 3 use-cases (Wave H2 T056-T059) ---------------------------------
export {
  loadPipeline,
  loadPipelineInputSchema,
  type LoadPipelineInput,
  type LoadPipelineError,
} from './application/use-cases/load-pipeline';

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

// --- Composition root (Wave G T054 + H1 expansions) ------------------------
export { makeRenewalsDeps, f8OnPaidCallbacks } from './infrastructure/renewals-deps';
export type { RenewalsDeps } from './infrastructure/renewals-deps';
