/**
 * T043 (F8 Phase 2 Wave E) — `TierUpgradeSuggestionRepo` Application port.
 *
 * Domain-typed repository over `tier_upgrade_suggestions` (Wave C
 * migration 0091; 6-state machine). Concrete adapter ships at Phase 5+.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type {
  SuggestionId,
  TierUpgradeSuggestion,
  TierUpgradeStatus,
  TierUpgradeReasonCode,
  TierUpgradeEvidence,
} from '../../domain/tier-upgrade-suggestion';

export interface NewTierUpgradeSuggestionInput {
  readonly tenantId: string;
  readonly suggestionId: SuggestionId;
  readonly memberId: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;
  readonly reasonCode: TierUpgradeReasonCode;
  readonly evidence: TierUpgradeEvidence;
}

export interface TierUpgradeSuggestionRepo {
  /**
   * Insert a new `open` suggestion. Throws
   * `TierUpgradeOpenConflictError` when the member already has an
   * `open` or `accepted_pending_apply` suggestion (member_open partial
   * UNIQUE in migration 0091).
   */
  insertOpen(
    tx: unknown,
    input: NewTierUpgradeSuggestionInput,
  ): Promise<TierUpgradeSuggestion>;

  findById(
    tenantId: string,
    suggestionId: SuggestionId,
  ): Promise<TierUpgradeSuggestion | null>;

  /**
   * Find the unique `open` OR `accepted_pending_apply` row per
   * (tenant, member). Returns null when no active suggestion exists.
   */
  findActiveForMember(
    tenantId: string,
    memberId: string,
  ): Promise<TierUpgradeSuggestion | null>;

  /**
   * Cron skip-eligibility cursor — used by the at-risk recompute /
   * tier-upgrade-evaluate weekly cron to skip recently-dismissed
   * suggestions for 90 days (suppressed_idx partial in migration 0091).
   */
  isSuppressedForMember(
    tenantId: string,
    memberId: string,
    nowIso: string,
  ): Promise<boolean>;

  /**
   * F4 renewal-invoice hook lookup — find pending-apply suggestions
   * targeting a specific cycle (pending_apply_idx partial in migration
   * 0091).
   */
  findPendingForCycle(
    tenantId: string,
    cycleId: string,
  ): Promise<ReadonlyArray<TierUpgradeSuggestion>>;

  transitionStatus(
    tx: unknown,
    tenantId: string,
    suggestionId: SuggestionId,
    args: {
      readonly to: TierUpgradeStatus;
      readonly acceptedAt?: string;
      readonly acceptedByUserId?: string;
      readonly targetApplyAtCycleId?: string;
      readonly appliedAt?: string;
      readonly appliedAtInvoiceId?: string;
      readonly memberNotifiedAt?: string;
      readonly adminVerificationTaskId?: string;
      readonly suppressedUntil?: string;
      readonly dismissedReason?: string;
      readonly closedAt?: string;
    },
  ): Promise<TierUpgradeSuggestion>;
}

export class TierUpgradeOpenConflictError extends Error {
  override readonly name = 'TierUpgradeOpenConflictError';
  constructor(public readonly memberId: string) {
    super(
      `member ${memberId} already has an open or pending-apply tier upgrade suggestion`,
    );
  }
}

export class TierUpgradeSuggestionNotFoundError extends Error {
  override readonly name = 'TierUpgradeSuggestionNotFoundError';
  constructor(public readonly suggestionId: string) {
    super(`tier_upgrade_suggestions row ${suggestionId} not found`);
  }
}
