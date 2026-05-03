/**
 * T041 (F8 Phase 2 Wave E) — `RenewalCycleRepo` Application port.
 *
 * Domain-typed repository over the `renewal_cycles` table (Wave C
 * migration 0087). Concrete adapter ships at Phase 5+ when use-cases
 * land; Wave E is interface-only.
 *
 * Method conventions (mirror F2 PlanRepo + F4 InvoiceRepo + F7
 * BroadcastsRepo):
 *   - `tx: unknown` parameter for transactional methods
 *   - throws on conflicts; use-cases adapt to Result at boundaries
 *   - `tenantId: string` threaded explicitly per call (NOT constructor
 *     injection — Constitution Principle I clause 1 compile-enforcement)
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type {
  CycleId,
  RenewalCycle,
  ClosedReason,
} from '../../domain/renewal-cycle';
import type { CycleStatus } from '../../domain/value-objects/cycle-status';
import type { TierBucket } from '../../domain/value-objects/tier-bucket';

export interface NewRenewalCycleInput {
  readonly tenantId: string;
  readonly cycleId: CycleId;
  readonly memberId: string;
  /** ISO 8601 UTC. */
  readonly periodFrom: string;
  /** ISO 8601 UTC. */
  readonly periodTo: string;
  readonly cycleLengthMonths: number;
  readonly tierAtCycleStart: TierBucket;
  readonly planIdAtCycleStart: string;
  /** Decimal string from DB (`decimal(12,2)`). */
  readonly frozenPlanPriceThb: string;
  readonly frozenPlanTermMonths: number;
}

export interface ListRenewalCyclesOpts {
  readonly cursor?: string;
  readonly pageSize: number;
  readonly statusFilter?: ReadonlyArray<CycleStatus>;
  readonly memberIdFilter?: string;
  /** Optional T-N urgency bucket (data-model.md § 2.1 pipeline_idx hot-path). */
  readonly maxDaysUntilExpiry?: number;
  readonly sort?:
    | 'expires_at_asc'
    | 'expires_at_desc'
    | 'created_at_desc';
}

export interface RenewalCyclePage {
  readonly items: ReadonlyArray<RenewalCycle>;
  readonly nextCursor: string | null;
  readonly totalCount?: number;
}

export interface RenewalCycleRepo {
  /** Insert a new cycle (typically called from F4 invoice-paid hook in Phase 5+). */
  insert(
    tx: unknown,
    tenantId: string,
    input: NewRenewalCycleInput,
  ): Promise<RenewalCycle>;

  /**
   * Look up a single cycle by id. Returns `null` when the cycle does
   * not exist OR belongs to a different tenant (RLS hides it). The
   * 404-vs-403 distinction lives in the use-case layer.
   */
  findById(
    tenantId: string,
    cycleId: CycleId,
  ): Promise<RenewalCycle | null>;

  /**
   * Find the unique active cycle for a member (status NOT IN
   * lapsed/cancelled/completed) per data-model.md § 2.1 invariant
   * L135. Returns null when the member has no active cycle.
   */
  findActiveForMember(
    tenantId: string,
    memberId: string,
  ): Promise<RenewalCycle | null>;

  /**
   * Pipeline list for `/admin/renewals` dashboard (FR-046). Supports
   * server-side pagination + filter combinations. Default sort by
   * `expires_at_asc` (most urgent first).
   */
  list(
    tenantId: string,
    opts: ListRenewalCyclesOpts,
  ): Promise<RenewalCyclePage>;

  /**
   * Atomic transition with optional anchor updates. Throws
   * `CycleTransitionConflictError` if the source row is no longer at
   * the expected `from` status (advisory-lock-style optimistic lock).
   */
  transitionStatus(
    tx: unknown,
    tenantId: string,
    cycleId: CycleId,
    args: {
      readonly from: CycleStatus;
      readonly to: CycleStatus;
      readonly closedAt?: string;
      readonly closedReason?: ClosedReason;
      readonly enteredPendingAt?: string;
      readonly linkedInvoiceId?: string;
      readonly linkedCreditNoteId?: string;
    },
  ): Promise<RenewalCycle>;

  /**
   * Eligibility cursor for the dispatcher cron (FR-046 reminder
   * ladder). Returns cycles in active states with `expires_at` newer
   * than the cutoff, ordered for deterministic batching.
   */
  listEligibleForDispatch(
    tenantId: string,
    args: {
      readonly cutoff: string;
      readonly pageSize: number;
      readonly cursor?: string;
    },
  ): Promise<RenewalCyclePage>;
}

/** Use-case-side error narrowing for adapter throws. */
export class CycleNotFoundError extends Error {
  override readonly name = 'CycleNotFoundError';
  constructor(public readonly cycleId: string) {
    super(`renewal_cycles row ${cycleId} not found`);
  }
}

export class CycleTransitionConflictError extends Error {
  override readonly name = 'CycleTransitionConflictError';
  constructor(
    public readonly cycleId: string,
    public readonly expectedFrom: CycleStatus,
    public readonly actualStatus: CycleStatus,
  ) {
    super(
      `cycle ${cycleId} expected status=${expectedFrom} but row is ${actualStatus}`,
    );
  }
}
