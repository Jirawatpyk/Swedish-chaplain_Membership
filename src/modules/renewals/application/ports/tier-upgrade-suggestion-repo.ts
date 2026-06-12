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

  /**
   * 065 Fix 1 (W-011 double-accept TOCTOU) — compare-and-swap
   * transition. The UPDATE matches only while the row is still in the
   * expected FROM state; a concurrent transition that committed after
   * the caller's read makes the UPDATE match 0 rows and the adapter
   * throws `TierUpgradeStatusConflictError` instead of silently
   * re-applying the transition (which produced duplicate
   * `tier_upgrade_accepted` audit + duplicate member email +
   * last-writer `accepted_by_user_id`). Throws
   * `TierUpgradeSuggestionNotFoundError` when the row does not exist
   * at all.
   *
   * 065 S7 — the FROM guard accepts two mutually-exclusive shapes
   * (caller MUST supply EXACTLY ONE):
   *
   *   - `expectedFrom` — value-pinned guard (`AND status = expectedFrom`).
   *     Used by the four single-FROM callers (accept: `open`,
   *     apply-pending / reconcile-dismiss: `accepted_pending_apply`,
   *     dismiss: `open`). The captured read-status IS the only valid
   *     FROM, so pinning it is correct.
   *
   *   - `expectedFromIn` — set-membership guard
   *     (`AND status IN (...expectedFromIn)`). Used ONLY by
   *     `supersedePendingTierUpgrade`, whose manual-override semantics
   *     are valid from EITHER `open` OR `accepted_pending_apply`
   *     (FR-039 step 5). Its `findActiveForMember` read runs in a
   *     SEPARATE tx and is stale by CAS time; a value-pinned guard
   *     therefore silently no-ops when a concurrent accept moved the
   *     row across the set's boundary, orphaning the suggestion. The
   *     set guard supersedes regardless of which in-set state the row
   *     committed to. (Mirrors the pre-065 id-only WHERE for supersede,
   *     restored under a tenant-/state-scoped CAS.)
   */
  transitionStatus(
    tx: TenantTx,
    tenantId: string,
    suggestionId: SuggestionId,
    args: {
      readonly to: TierUpgradeStatus;
      readonly expectedFrom?: TierUpgradeStatus;
      readonly expectedFromIn?: readonly TierUpgradeStatus[];
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

  /**
   * F8 Phase 10 T262 batched-write — bulk suppression check.
   *
   * Single-RTT alternative to N-call `isSuppressedForMember` from the
   * `evaluateTierUpgrade` cron page-loop. Returns the set of member ids
   * that have a `dismissed` suggestion with `suppressed_until > nowIso`.
   * Members not in the result are NOT suppressed (cron may proceed to
   * insert a new `open` suggestion).
   *
   * Empty `memberIds` is a no-op returning an empty set.
   *
   * Constitution Principle VII (Perf) — collapses 333 RTTs (per
   * T264 perf bench at 1k members ~33% above-threshold) into 1.
   */
  bulkGetSuppressedMembers(
    tx: TenantTx,
    memberIds: ReadonlyArray<string>,
    nowIso: string,
  ): Promise<ReadonlySet<string>>;

  /**
   * F8 Phase 10 T262 batched-write — bulk insert open suggestions.
   *
   * Single-RTT alternative to N-call `insertOpen` from the
   * `evaluateTierUpgrade` cron page-loop. Uses
   * `INSERT … ON CONFLICT (tenant_id, member_id) WHERE status IN
   * ('open','accepted_pending_apply') DO NOTHING` to honour the
   * `tier_upgrade_suggestions_member_open_uniq` partial index — a
   * member with an existing open/pending suggestion is silently
   * skipped (counted as `conflicted`). Returns the actual rows
   * inserted (suitable for downstream audit emission).
   *
   * Empty `inputs` is a no-op returning `{ inserted: [], conflicted: [] }`.
   *
   * Constitution Principle VIII (Reliability) — caller MUST emit
   * audit events bundled with the same tx (use `bulkEmitInTx`).
   * Atomicity guaranteed by the surrounding `runInTenant`.
   */
  bulkInsertOpenIfAbsent(
    tx: TenantTx,
    inputs: ReadonlyArray<NewTierUpgradeSuggestionInput>,
  ): Promise<{
    readonly inserted: ReadonlyArray<TierUpgradeSuggestion>;
    /**
     * R5-MED1 fix: shape harmonized with sister
     * `RenewalReminderEventRepo.bulkInsertIfAbsent` — both return the
     * full input shape (NewTierUpgradeSuggestionInput / NewReminderEventInput)
     * for skipped rows so callers can branch on input metadata
     * (e.g. emit `tier_upgrade_skipped { reason: 'already_open' }`
     * with the candidate's reasonCode + evidence) without re-fetching.
     * Pre-fix returned `ReadonlyArray<string>` (just memberIds) which
     * forced callers to re-look up the original input by member id.
     */
    readonly conflicted: ReadonlyArray<NewTierUpgradeSuggestionInput>;
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

/**
 * 065 Fix 1 — thrown by `transitionStatus` when the CAS
 * (`AND status = expectedFrom`) matched 0 rows but the row exists:
 * a concurrent transition won the race. Callers treat this as the
 * loser arm of their respective race (accept/dismiss → typed
 * `suggestion_not_open`; apply/supersede → idempotent no-op skip).
 */
export class TierUpgradeStatusConflictError extends Error {
  override readonly name = 'TierUpgradeStatusConflictError';
  constructor(
    public readonly suggestionId: string,
    public readonly expectedFrom: string,
    public readonly actualStatus: string,
  ) {
    super(
      `tier_upgrade_suggestions row ${suggestionId} status CAS failed — expected '${expectedFrom}', found '${actualStatus}'`,
    );
  }
}
