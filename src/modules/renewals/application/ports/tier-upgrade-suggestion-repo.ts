/**
 * T043 (F8 Phase 2 Wave E) — `TierUpgradeSuggestionRepo` Application port.
 *
 * Domain-typed repository over `tier_upgrade_suggestions` (Wave C
 * migration 0091; 6-state machine). Concrete adapter ships at Phase 5+.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
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
    tx: TenantTx,
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
    tx: TenantTx,
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

  /**
   * Phase 7 T185 + Round 6 W-002 — orphan detection. Returns all
   * suggestions in `accepted_pending_apply` state for any of three
   * orphan shapes:
   *
   *   1. `targetCycleStatus === 'cancelled' | 'lapsed'` — the F4
   *      invoice-paid hook will never fire (cycle is terminal).
   *   2. `targetCycleStatus === 'manual_plan_change'` — the member's
   *      current `members.plan_id` no longer matches EITHER the
   *      suggestion's `from_plan_id` OR `to_plan_id`. Admin manually
   *      changed the plan after Accept and the F8 supersede listener
   *      either failed silently (`f2-plan-change-bridge` wrapper
   *      swallows exceptions) or was not yet wired at the time. The
   *      reconcile cron is the backstop that dismisses these suggestions
   *      so a fresh eval pass can re-suggest cleanly.
   *
   * Reconcile cron transitions terminal-cycle orphans with
   * `reason='orphan_target_cycle_terminal'` and plan-diverged orphans
   * with `reason='orphan_member_plan_diverged'`.
   */
  listOrphanedPending(
    tenantId: string,
  ): Promise<ReadonlyArray<{
    readonly suggestion: TierUpgradeSuggestion;
    readonly targetCycleStatus: 'cancelled' | 'lapsed' | 'manual_plan_change';
  }>>;

  /**
   * Phase 7 T193 — admin queue listing. Returns suggestions in `open`
   * OR `accepted_pending_apply` state for the admin dashboard,
   * ordered by `(created_at DESC, suggestion_id DESC)`.
   */
  listForAdminQueue(
    tenantId: string,
    args?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<{
    readonly items: ReadonlyArray<TierUpgradeSuggestion>;
    readonly nextCursor: string | null;
  }>;
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
