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
export {
  TIER_BUCKETS,
  asTierBucket,
  parseTierBucket,
  isTierBucket,
  type TierBucket,
  type TierBucketError,
} from './domain/value-objects/tier-bucket';

export {
  CYCLE_STATUSES,
  TERMINAL_CYCLE_STATUSES,
  asCycleStatus,
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
  asRiskBand,
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
  asCycleId,
  parseCycleId,
  assertCycleInvariants,
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
  asSuggestionId,
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
  asTaskId,
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
