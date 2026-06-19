/**
 * `RenewalCycleRepo` — F8 application port over `renewal_cycles`.
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
import type { TenantTx } from '@/lib/db';
import type { ThbDecimal } from '@/lib/money';
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
  /** Brand-validated `decimal(12,2)` THB value (I-1, 068 speckit-review). */
  readonly frozenPlanPriceThb: ThbDecimal;
  readonly frozenPlanTermMonths: number;
  /**
   * F8-completion Slice 1 — the cycle's initial status. Defaults to
   * `'upcoming'` (the DB column default + the steady-state on-paid /
   * import / onboarding entry points). Slice 3's admin lapsed-comeback
   * path creates a cycle that starts in `'awaiting_payment'` (already
   * payable). Constrained to the two valid START states — a new cycle
   * never begins life in a reminded/pending/terminal status.
   */
  readonly startStatus?: 'upcoming' | 'awaiting_payment';
}

export interface ListRenewalCyclesOpts {
  readonly cursor?: string;
  readonly pageSize: number;
  readonly statusFilter?: ReadonlyArray<CycleStatus>;
  readonly memberIdFilter?: string;
  /**
   * Exclude a single cycle by id from the result. Used by
   * `loadRenewalSummary` to probe "does this member have ANY OTHER prior
   * completed cycles?" without the current cycle false-counting itself
   * when its own status is already `completed` (post-renew historical
   * view). Without this filter `isFirstTimeRenewer` would falsely
   * resolve to `false` for a true first-timer once their cycle reaches
   * `completed`. Implemented as `cycle_id <> $1` at the DB level.
   */
  readonly excludeCycleId?: string;
  /** Optional T-N urgency bucket (data-model.md § 2.1 pipeline_idx hot-path). */
  readonly maxDaysUntilExpiry?: number;
  /**
   * COMP-1 H4 — when `true`, drop cycles whose owning member was
   * GDPR-erased (`members.erased_at IS NOT NULL`). Erasure keeps
   * `members.status` + the cycle and stamps only `erased_at`, so a status
   * filter alone does NOT hide an erased member's cycle. Set ONLY by the
   * OPERATIONAL `loadPendingReactivationReview` admin queue — the cron
   * (`reconcilePendingReactivations`) and the per-member detail reads
   * (`loadMemberRenewalStatus`, `loadRenewalSummary`) leave it `false`/unset
   * (they are internal-processing or by-member reads that must still see
   * the erased member's own cycles). Implemented as a correlated
   * `NOT EXISTS` anti-join so `list` keeps reading only `renewal_cycles`
   * (no member join added).
   */
  readonly excludeErasedMembers?: boolean;
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

// ---------------------------------------------------------------------------
// DV-18 — "Members without renewal cycle" admin tray
// ---------------------------------------------------------------------------

export interface ListMembersWithoutCycleOpts {
  readonly limit: number;
}

export interface MemberWithoutCycleRow {
  readonly memberId: string;
  readonly companyName: string;
  /** `registration_date` (a `date` column) surfaced as a YYYY-MM-DD string. */
  readonly registrationDate: string;
}

export interface MembersWithoutCyclePage {
  readonly items: ReadonlyArray<MemberWithoutCycleRow>;
  readonly totalCount: number;
}

export interface RenewalCycleRepo {
  /** Insert a new cycle (typically called from F4 invoice-paid hook in Phase 5+). */
  insert(
    tx: TenantTx,
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
   * Same as `findById` but accepts the caller's tx handle so the read
   * participates in the surrounding transaction (and any advisory lock
   * held inside it). Required by mutating use-cases that re-read after
   * acquiring `acquireCycleLockInTx` to defeat TOCTOU windows — using
   * the non-tx `findById` would open a separate connection and the
   * re-read could observe a different snapshot from the lock-holding
   * tx. Constitution Principle VIII (state↔audit atomicity).
   */
  findByIdInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
  ): Promise<RenewalCycle | null>;

  /**
   * Phase 5 Wave B (T123) — find the cycle whose `linked_invoice_id`
   * matches the given F4 invoice id. Used by the F4 onPaidCallback to
   * resolve "which renewal cycle does this paid invoice belong to".
   * Returns null when no F8 cycle owns the invoice (e.g. ad-hoc admin
   * invoice unrelated to a renewal).
   */
  findByInvoiceIdInTx(
    tx: TenantTx,
    tenantId: string,
    invoiceId: string,
  ): Promise<RenewalCycle | null>;

  /**
   * Phase 5 Wave B (T122) — atomic plan-change update per FR-021b.
   * When a member selects a different F2 plan during the confirm flow,
   * the cycle's frozen_plan_* columns must update in a single
   * statement so a concurrent reader never sees mixed state. Throws
   * `CycleTransitionConflictError` if the cycle row's status no longer
   * permits a plan change (i.e. moved out of `awaiting_payment`).
   */
  updateFrozenPlan(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    args: {
      readonly planIdAtCycleStart: string;
      readonly tierAtCycleStart: TierBucket;
      // ThbDecimal (not bare string) so the §86/4 frozen-price write path is
      // brand-guarded like the other hops — a raw/display string can't reach
      // the tax-document price column without going through parseThbDecimal.
      readonly frozenPlanPriceThb: ThbDecimal;
      readonly frozenPlanTermMonths: number;
      readonly frozenPlanCurrency: 'THB' | 'SEK' | 'EUR' | 'USD';
    },
  ): Promise<RenewalCycle>;

  /**
   * Phase 5 Wave B (T122) — link an issued F4 invoice to the cycle.
   * Runs after `f4InvoicingBridge.issueInvoiceForRenewal` succeeds; the
   * cycle's `linked_invoice_id` becomes the joining column the F4
   * onPaidCallback (T123) uses to resolve cycle ↔ invoice. Idempotent
   * when called with the same invoice id.
   */
  linkInvoice(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    invoiceId: string,
  ): Promise<RenewalCycle>;

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
   * 070 — find the member's MOST-RECENT NON-ABANDONED cycle (status NOT IN
   * lapsed/cancelled), newest `period_from` first. UNLIKE
   * `findActiveForMember`, this INCLUDES a `completed` cycle. It backs the
   * post-payment `/portal/renewal/[memberId]/success` page, which must be
   * able to display the just-completed cycle's status row — that row was
   * unreachable while the page used `findActiveForMember` (which excludes
   * `completed` per the L135 active invariant), so the success page could
   * never confirm completion. Returns null when the member has only
   * abandoned cycles (or none).
   */
  findMostRecentForMember(
    tenantId: string,
    memberId: string,
  ): Promise<RenewalCycle | null>;

  /**
   * F8-completion Slice 1 — same as `findActiveForMember` but accepts
   * the caller's tx handle so the read participates in the surrounding
   * transaction. It can therefore see an uncommitted prior-cycle
   * `→completed` flip made EARLIER in the SAME tx (e.g. F4
   * `f8OnPaidCallbacks[0]` flips the just-paid cycle to `completed`
   * before `withTx` commits). The connection-fresh `findActiveForMember`
   * opens its OWN `runInTenant` connection and CANNOT see that
   * uncommitted flip under READ COMMITTED — which would make the
   * on-paid next-cycle creation idempotency-guard see the prior cycle
   * as still active → no-op → the next cycle never created on first
   * delivery. Threading the F4 tx closes that window.
   *
   * Tenant context comes from the inherited GUC (set by the caller's
   * `runInTenant`); `tenantId` is intentionally unused (RLS, not a
   * WHERE clause) — same precedent as `findByIdInTx`. Constitution
   * Principle VIII (state↔audit atomicity).
   */
  findActiveForMemberInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<RenewalCycle | null>;

  /**
   * The MOST-RECENT cycle (by created_at DESC, cycle_id DESC tiebreak) for each
   * member id, in ONE query (DISTINCT ON). Used by the lapsed-badge enrichment
   * to avoid N+1 across the ≤50 rows of the member-directory page. Returns at
   * most one cycle per member that HAS a cycle; members with none are absent.
   * Tenant-isolated via runInTenant (RLS+FORCE) — a foreign member id matches
   * nothing. An empty `memberIds` MUST short-circuit at the use-case (no DB hit).
   */
  findLatestCyclesForMembers(
    tenantId: string,
    memberIds: readonly string[],
  ): Promise<ReadonlyArray<RenewalCycle>>;

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
    tx: TenantTx,
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

  /**
   * Per-(tenant, cycle) advisory lock for mark-paid-offline races.
   * Namespace `renewals:` is disjoint from F4 `invoicing:` and F5
   * `payments:`. Auto-released at tx end. Phase 3 H2 / T059 use.
   */
  acquireCycleLockInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
  ): Promise<void>;

  /**
   * T115a Phase 5 wave K24 — eligibility cursor for the daily
   * `lapseCyclesOnGraceExpiry` cron (FR-004 + AS3 closed-reason
   * differentiation). Returns cycles still in `awaiting_payment`
   * whose `expires_at < cutoffDate` (cutoff = `now - grace_period_days`),
   * ordered by `expires_at ASC` for deterministic batching. The
   * use-case decides the closed_reason discriminant per cycle by
   * consulting the F5 payment-attempts bridge.
   */
  listCyclesEligibleForLapse(
    tenantId: string,
    args: {
      readonly cutoffDate: string;
      readonly pageSize: number;
    },
  ): Promise<RenewalCyclePage>;

  /**
   * F8-completion slice 2 — eligibility cursor for the T-0 expiry cron
   * (`enterAwaitingPaymentOnExpiry`). Returns cycles still in
   * `upcoming` or `reminded` whose `expires_at <= nowIso` — i.e. they
   * have reached T-0 and must become payable. Ordered by `expires_at
   * ASC` for deterministic batching (oldest expiries first).
   *
   * The `<= nowIso` boundary (vs the lapse cron's `< now -
   * grace_period_days`) is load-bearing: a cycle is never
   * simultaneously eligible for BOTH the enter-awaiting flip and the
   * lapse transition in one cron pass — the enter-awaiting cron flips
   * `upcoming|reminded → awaiting_payment` at T-0; only AFTER it is
   * `awaiting_payment` does the (later) lapse cron consider it once the
   * grace window elapses.
   */
  listCyclesEligibleForAwaitingPayment(
    tenantId: string,
    args: {
      readonly nowIso: string;
      readonly pageSize: number;
    },
  ): Promise<RenewalCyclePage>;

  /**
   * Pipeline dashboard composite query (Phase 3 US1 / FR-046 / SC-003).
   * Returns rows enriched with `members.company_name` + last reminder
   * + DB-side derived `urgency` bucket + summary aggregates. Cursor is
   * an opaque base64 string the adapter encodes from
   * `(expires_at, cycle_id)` tuple.
   *
   * Separate from `list()` so the abstract Domain `RenewalCyclePage`
   * shape remains pure — pipeline rows carry presentation-layer joins
   * that don't belong on the Domain entity.
   */
  loadPipelinePage(
    tenantId: string,
    opts: PipelineQueryOpts,
  ): Promise<PipelineQueryResult>;

  /**
   * DV-18 — members that have NO `renewal_cycles` row at all (the renewal
   * gap the admin tray surfaces). Anti-join LEADS from `members` with a
   * correlated `NOT EXISTS` against the cycle table, EXCLUDING
   * `status='archived'` AND `erased_at IS NOT NULL` (COMP-1 H4 — erasure
   * keeps status='active', so a status filter alone won't hide an erased
   * member). Ordered `registration_date DESC, member_id ASC`.
   *
   * Single capped page (no pagination cursor — the tray is a best-effort
   * visibility widget like the pending-reactivation section; a chamber has
   * well under the 200-row cap of no-cycle members). Returns `totalCount`
   * (the WHOLE anti-join size, via a separate `count(*)` aggregate run in
   * parallel with the page query) so the tray can show "N members" and flag
   * when the rendered page is truncated past the cap.
   *
   * Tenant isolation: RLS+FORCE on BOTH `members` and `renewal_cycles` —
   * the adapter threads `tx` from `runInTenant`, never the global `db`.
   */
  listMembersWithoutCycle(
    tenantId: string,
    opts: ListMembersWithoutCycleOpts,
  ): Promise<MembersWithoutCyclePage>;
}

// ---------------------------------------------------------------------------
// Pipeline-specific shapes (Phase 3 US1)
// ---------------------------------------------------------------------------

export type UrgencyBucket =
  | 't-90'
  | 't-60'
  | 't-30'
  | 't-14'
  | 't-7'
  | 't-0'
  | 'grace'
  | 'lapsed';

export interface PipelineQueryOpts {
  readonly tier?: TierBucket;
  readonly urgency?: UrgencyBucket;
  readonly cursor?: string | null;
  readonly limit: number;
}

export interface PipelineRow {
  readonly cycleId: CycleId;
  readonly memberId: string;
  readonly companyName: string;
  readonly tierBucket: TierBucket;
  readonly expiresAt: string;
  readonly urgency: UrgencyBucket;
  readonly status: CycleStatus;
  readonly lastReminderAt: string | null;
  readonly lastReminderStepId: string | null;
  readonly linkedInvoiceId: string | null;
  /**
   * Frozen reason on terminal cycles. NULL for non-terminal rows.
   * Surfaced on the lapsed-tab UI so admins see WHY a cycle lapsed
   * (grace_expired vs payment_failed vs admin_marked) per spec AS3.
   */
  readonly closedReason: ClosedReason | null;
  /**
   * J4-H13 (smart-feature #2 — at-risk visibility): mirror of
   * `members.email_unverified` so the pipeline UI can render an
   * inline indicator on rows whose primary contact email has hit
   * a bounce threshold (T090 detect-bounce-threshold). Without this
   * field admins only learn email is unverified by clicking
   * "Send reminder" and reading the toast — by then the cycle may
   * already be at T+0 lapsed. Surfacing it on the row itself lets
   * the admin remediate (chase a new contact email) before the
   * grace window closes.
   */
  readonly emailUnverified: boolean;
}

export interface PipelineSummary {
  readonly totalInWindow: number;
  readonly byUrgency: Readonly<Record<UrgencyBucket, number>>;
  readonly lapsedCount: number;
}

export interface PipelineQueryResult {
  readonly rows: ReadonlyArray<PipelineRow>;
  readonly nextCursor: string | null;
  readonly summary: PipelineSummary;
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

/**
 * Thrown by `linkInvoice` when the cycle row already carries a
 * DIFFERENT linked_invoice_id. Indicates a concurrent confirmRenewal
 * race won the link and our F4-issued invoice is now orphaned. The
 * use-case maps this to `server_error` with a forensic log line so
 * support can void the orphan invoice via the F4 admin list.
 *
 * Idempotent re-link with the SAME invoice_id does NOT throw.
 */
export class InvoiceLinkConflictError extends Error {
  override readonly name = 'InvoiceLinkConflictError';
  constructor(
    public readonly cycleId: string,
    public readonly attemptedInvoiceId: string,
    public readonly existingInvoiceId: string,
  ) {
    super(
      `cycle ${cycleId} already linked to invoice ${existingInvoiceId} — refused to overwrite with ${attemptedInvoiceId}`,
    );
  }
}
