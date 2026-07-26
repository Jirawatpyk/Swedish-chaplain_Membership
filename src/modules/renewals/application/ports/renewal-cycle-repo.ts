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
import type { RenewalMonthAggregation } from '../../domain/renewal-month-bucket';
import type { MembershipBillCoverageRow } from '../../domain/membership-bill-coverage';

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

/**
 * 107-auto-invoice Task 6 — return shape for
 * `listCyclesEligibleForAutoDraft`. Deliberately a SEPARATE shape from
 * `RenewalCyclePage` (`cycles` not `items`) — the auto-draft cron
 * consumer (Task 7) is a fresh call site with no existing `items`-shaped
 * expectations, and single-page-only (`nextCursor` is always `null`,
 * never a real cursor) makes that explicit at the type level rather than
 * reusing a shape that implies cursor pagination is supported.
 */
export interface AutoDraftEligiblePage {
  readonly cycles: ReadonlyArray<RenewalCycle>;
  readonly nextCursor: null;
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

/**
 * 107-auto-invoice Task 9 — the minimal `invoices` projection the issue-time
 * guards need. Deliberately NOT the F4 `Invoice` aggregate: renewals must not
 * depend on F4's domain shape (Principle III), and these five fields are the
 * whole of what the HARD REQ #1 shape check + the content guard read.
 */
export interface MembershipInvoiceRef {
  readonly invoiceId: string;
  readonly memberId: string;
  /** F4 `invoices.plan_year` — the fiscal year the document will PRINT. */
  readonly planYear: number;
  readonly status:
    | 'draft'
    | 'issued'
    | 'paid'
    | 'void'
    | 'partially_credited'
    | 'credited';
  readonly origin: 'manual' | 'auto_renewal';
}

/**
 * 107-auto-invoice Task 11 — row shape for `listStaleAutoDrafts`. Carries
 * just enough to discard the F4 draft (`invoiceId`) and emit the F8
 * `renewal_auto_draft_discarded` audit payload (`cycleId`, `memberId`) —
 * deliberately NOT the full `MembershipInvoiceRef` or `RenewalCycle`
 * shapes, mirroring the narrow-projection convention `MemberWithoutCycleRow`
 * / `StaleAutoDraftRow`'s sibling queries already use.
 */
export interface StaleAutoDraftRow {
  readonly invoiceId: string;
  readonly cycleId: CycleId;
  readonly memberId: string;
}

/**
 * 107-auto-invoice Task 11 — row shape for `listIssuedAutoInvoiceOrphans`.
 * Same narrow projection as {@link StaleAutoDraftRow}; the reconcile
 * cron re-reads the full cycle row itself (under the per-cycle lock)
 * before deciding how to repair the link, so this candidate row only
 * needs to name WHICH (invoice, cycle) pair to re-read.
 */
export interface IssuedAutoInvoiceOrphanRow {
  readonly invoiceId: string;
  readonly cycleId: CycleId;
  readonly memberId: string;
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
   * Plan-change immediate re-freeze (Phase 2, Step 2.2) — re-freeze the 5
   * frozen_plan_* columns of a member's OPEN cycle to a NEW plan when a manual
   * admin change-plan flips `members.plan_id`. DISTINCT from `updateFrozenPlan`:
   *   - accepts ANY open status (`upcoming|reminded|awaiting_payment`), not
   *     just `awaiting_payment` (the change can land before the T-0 cron flips
   *     the cycle to payable);
   *   - GUARDED by `linked_invoice_id IS NULL` — an OPEN cycle whose §86/4 has
   *     already been issued+linked is NEVER rewritten (tax-safe: an issued tax
   *     invoice is immutable);
   *   - returns `null` (NEVER throws) on 0 rows — the cycle raced into a
   *     terminal/linked state, and the caller DEFERS rather than erroring.
   *
   * The guard predicate mirrors the SQL `WHERE cycle_id = ? AND tenant_id = ?
   * AND status IN ('upcoming','reminded','awaiting_payment') AND
   * linked_invoice_id IS NULL RETURNING *`. Term-length changes are handled by
   * the CALLER (the plan-change billing remediation defers a term change —
   * period re-derivation is out of scope), so this method rewrites the frozen
   * fields verbatim from `args`. Thread `tx` from the caller's `runInTenant`.
   */
  refreezeOpenCycleForPlanChangeInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    args: {
      readonly planIdAtCycleStart: string;
      readonly tierAtCycleStart: TierBucket;
      readonly frozenPlanPriceThb: ThbDecimal;
      readonly frozenPlanTermMonths: number;
      readonly frozenPlanCurrency: 'THB' | 'SEK' | 'EUR' | 'USD';
    },
  ): Promise<RenewalCycle | null>;

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
   * Finding #20 (Phase 2 #238 adversarial money-path review) — link the issued
   * §86/4 to the cycle AND (re-)assert the cycle's 5 frozen_plan_* columns to the
   * `billed` snapshot the invoice was actually issued from, in ONE guarded
   * statement so the two can never disagree.
   *
   * confirm-renewal Step-4 uses this (NOT `linkInvoice`) because its Step-1
   * frozen-price capture + Step-3 §86/4 issue run OUTSIDE the per-cycle advisory
   * lock (released at Step-1's commit). A concurrent admin `change-plan`
   * immediate-refreeze can land in that window and CAS-refreeze the still-open,
   * still-unlinked cycle to a DIFFERENT plan/price — so at link time the cycle's
   * frozen fields may no longer match what the (immutable) §86/4 bills. Since the
   * member already holds an issued tax document at the price they CONFIRMED, the
   * cycle is reconciled BACK to the billed snapshot (the plan change defers to the
   * next cycle) rather than the member being rebilled.
   *
   * Runs under the caller's Step-4 tx while it holds `acquireCycleLockInTx`, so
   * the SELECT-before + guarded UPDATE are race-free against other frozen-price
   * writers (they all take the same lock). Returns BOTH the post-update `cycle`
   * and the `previous` (pre-update) row so the use-case can decide whether a real
   * reconciliation occurred (previous frozen fields differ from `billed`) and emit
   * a truthful corrective audit ONLY then.
   *
   * Guard `WHERE cycle_id = ? AND tenant_id = ? AND (linked_invoice_id IS NULL OR
   * linked_invoice_id = ?)` mirrors `linkInvoice` exactly — idempotent re-link,
   * `InvoiceLinkConflictError` on a concurrent link to a DIFFERENT invoice (0
   * rows → nothing written, so no partial reconcile), `CycleNotFoundError` when
   * the row vanished. Thread `tx` from `runInTenant`; NEVER the global `db`.
   */
  linkInvoiceAndReconcileFrozenPlanInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    invoiceId: string,
    billed: {
      readonly planIdAtCycleStart: string;
      readonly tierAtCycleStart: TierBucket;
      readonly frozenPlanPriceThb: ThbDecimal;
      readonly frozenPlanTermMonths: number;
      readonly frozenPlanCurrency: 'THB' | 'SEK' | 'EUR' | 'USD';
    },
  ): Promise<{ readonly cycle: RenewalCycle; readonly previous: RenewalCycle }>;

  /**
   * Plan-change / void-on-reissue unlink (Phase 2, Step 2.4) — clear the
   * cycle's `linked_invoice_id` when the invoice it points at is VOIDED. A
   * voided §86/4 no longer validly links the cycle; without this clear a
   * subsequent re-issue would hit `InvoiceLinkConflictError` from
   * `linkInvoice`'s `WHERE linked_invoice_id IS NULL OR = $new` guard.
   *
   * GUARDED single UPDATE (mirrors `clearRejectRefundMarkerInTx`):
   *   `WHERE cycle_id = ? AND tenant_id = ? AND status IN
   *    ('upcoming','reminded','awaiting_payment') AND linked_invoice_id = ?
   *    RETURNING cycle_id`
   *
   *   - CAS on `linked_invoice_id = expectedInvoiceId` — a concurrent relink
   *     to a DIFFERENT invoice is NEVER clobbered (0 rows → `false`).
   *   - Restricted to the OPEN cycle statuses. A `completed` cycle is left
   *     UNTOUCHED: the `renewal_cycles_completed_requires_invoice_check` CHECK
   *     forbids a NULL `linked_invoice_id` there, so clearing one would abort
   *     the whole void tx. The reissue workflow only applies to an OPEN cycle
   *     whose §86/4 is issued-but-unpaid, so this is also the correct scope.
   *   - `true` when 1 row cleared, `false` on 0 rows (raced / non-open /
   *     already-cleared / cross-tenant) — NEVER throws on a miss.
   *
   * The explicit `tenant_id` predicate is application-layer defence-in-depth
   * alongside RLS (Principle I § 1). Thread `tx` from the caller's tx (the
   * void's Phase-1 tx) — NEVER a nested `runInTenant`.
   */
  clearLinkedInvoiceForVoidInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    expectedInvoiceId: string,
  ): Promise<boolean>;

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
   * 059-membership-suspension Task 2 — the member's single most-recent cycle
   * across ALL statuses (incl. lapsed/cancelled). Ordered created_at DESC,
   * cycle_id DESC — the SAME key as `findLatestCyclesForMembers`, so the
   * suspension gate and the admin badge never disagree on "latest". UNLIKE
   * `findMostRecentForMember` (070, which EXCLUDES lapsed/cancelled for the
   * post-payment success page), this method must NOT filter by status: the
   * whole point is to let the Domain predicate `deriveMembershipAccess` see
   * a `lapsed` row so it can gate access. Backs `deriveMembershipAccess`.
   */
  findLatestCycleForMember(
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
   * F8-RP follow-up (migration 0243) — stamp the async reject-with-refund
   * marker on a cycle. Called by `adminRejectReactivation` in the same tx
   * where F5 returned `refund_pending` (Stripe settling asynchronously): the
   * cycle stays `pending_admin_reactivation` and these columns record that an
   * admin REJECT initiated a refund whose settlement the reconcile-pending
   * cron will later converge to `cancelled`/`admin_rejected_with_refund`.
   *
   * GUARDED UPDATE `WHERE cycle_id = ? AND status = 'pending_admin_reactivation'
   * AND reject_refund_initiated_at IS NULL` (CAS) — returns `true` when the
   * marker was written, `false` when 0 rows matched. Two reasons for `false`,
   * both handled by the caller's `!marked` warning: (1) the cycle moved out of
   * pending in the race window between the validate tx and this write; (2) M1
   * fix — the marker was ALREADY stamped by a concurrent FIRST writer. The
   * `IS NULL` predicate makes the stamp first-writer-wins at the DB layer: the
   * admin-reject caller decides "no marker yet" from a STALE app-level read
   * (`lockedCycle.rejectRefundInitiatedAt === null`, taken before the lock was
   * released + the refund ran), so two admins rejecting the same UNMARKED cycle
   * concurrently could both pass that check; without `IS NULL` the second
   * overwrote `reject_actor_user_id` to the last writer's (racy attribution —
   * money-safe, same in-flight refund, but wrong actor). The async refund is
   * already in flight and money-safe either way, so the caller logs + still
   * surfaces `refund_pending`. NORMAL first stamp (marker null → true) and
   * post-clear re-stamp (marker cleared → null → true) are unaffected. RLS
   * scope comes from the inherited GUC (thread `tx` from `runInTenant`).
   */
  markRejectRefundInitiatedInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    args: {
      readonly initiatedAt: string;
      readonly refundId: string;
      readonly actorUserId: string;
    },
  ): Promise<boolean>;

  /**
   * F8-RP follow-up (migration 0243) — clear the async reject-with-refund
   * marker. Called by the reconcile-pending cron when the marked refund
   * settled `failed` (Stripe failed/canceled): the async refund never
   * returned the money, so the cycle MUST NOT converge to `cancelled`. The
   * cron clears the marker (reverting the cycle to an ordinary
   * `pending_admin_reactivation` row the admin re-handles via the pending
   * queue — the sync reject path's own refund-failure treatment) + emits an
   * alerting metric.
   *
   * GUARDED UPDATE `WHERE cycle_id = ? AND status = 'pending_admin_reactivation'
   * AND reject_refund_initiated_at IS NOT NULL AND reject_refund_id = ?` —
   * idempotent (`false` when 0 rows matched: cycle moved on, or the marker was
   * already cleared). Thread `tx` from `runInTenant`.
   *
   * Finding 5 (F8-RP-2 review): the `expectedRefundId` guard makes the clear a
   * CAS on the SPECIFIC refund the caller resolved OUTSIDE the lock (R1). If a
   * concurrent admin re-reject overwrote the marker with a fresh refund (R2) in
   * the caller's read→clear window, the clear matches 0 rows (no-op, `false`)
   * instead of wiping R2's live marker — so R2's own settlement still converges
   * the cycle rather than the cycle being silently unmarked → lapsed.
   */
  clearRejectRefundMarkerInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    expectedRefundId: string,
  ): Promise<boolean>;

  /**
   * Eligibility cursor for the daily `lapseCyclesOnGraceExpiry` cron
   * (FR-004 + AS3 closed-reason differentiation). Returns ALL cycles
   * still in `awaiting_payment`, ordered by `expires_at ASC` for
   * deterministic batching.
   *
   * 065 §5.2 — the `expires_at < cutoffDate` pre-filter was REMOVED (the
   * `cutoffDate` arg with it): a §5.3 born-`awaiting_payment` new member
   * has `expires_at ≈ now + 12 months`, so an `expires_at`-based gate
   * would hide that cohort for ~12 months and the due+60 clock would
   * never fire for them. The per-cycle decision (defer / terminate@due+60
   * / no-invoice backstop on `expires_at + grace`) now lives entirely in
   * the use-case, driven by the member's oldest-due unpaid membership
   * invoice `due_date`.
   */
  listCyclesEligibleForLapse(
    tenantId: string,
    args: {
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
   * 107-auto-invoice Task 6 — eligibility cursor for the daily auto-draft
   * cron (Task 7). Returns cycles the cron should pre-fill a DRAFT
   * membership invoice for, ahead of the member's due date. A cycle is
   * eligible when ALL of:
   *
   *   1. `status IN ('upcoming', 'reminded')`.
   *   2. `expires_at > nowIso` AND `expires_at <= nowIso + leadDays` where
   *      `leadDays` is `leadDaysCalendar` for a `members.billing_cycle =
   *      'calendar'` member, else `leadDaysRolling` — the per-member lead
   *      window (design §5.1).
   *   3. `members.auto_invoice_enrolled_at IS NOT NULL` (opt-in only —
   *      Task 1).
   *   4. `members.archived_at IS NULL AND members.status <> 'archived'`.
   *   4a. `members.erased_at IS NULL` — a GDPR/PDPA-erased member must never
   *      be auto-billed (Task 15 review). NOT implied by (4): the F3 erasure
   *      scrub deliberately leaves `status`/`archived_at` untouched
   *      ("erasure is orthogonal to archive"), so an erased-but-active member
   *      passes both of those. The scrub also NULLs
   *      `auto_invoice_enrolled_at`, but that is one-shot — a later bulk
   *      enrol could re-stamp the row, so the durable guard lives here.
   *   5. Dedup — NO existing membership invoice for the member with
   *      `status IN ('draft', 'issued')`. Deliberately narrower than the
   *      full "live invoice" set (`paid`/`credited`/`partially_credited`
   *      are NOT excluded): an `upcoming` cycle exists precisely BECAUSE
   *      the member's prior cycle was paid, so EVERY eligible member has
   *      at least one `paid` membership invoice on file — including
   *      `paid` here would exclude everyone and the cron would never
   *      fire. This dedup is intentionally MEMBER-scoped, not
   *      `plan_year`-scoped: `plan_year` on a cycle is derived
   *      (`deriveFiscalYear` from `period_from`), not a column, so it
   *      cannot be filtered in this set query. The precise per-cycle,
   *      plan_year-scoped duplicate-§86/4 guard (which DOES include
   *      `paid`) runs later, under the cycle lock, in Task 9 at DRAFT-
   *      creation time — this coarse query only decides "worth looking
   *      at", not "safe to draft".
   *
   * Deliberately does NOT gate on membership access
   * (terminated/suspended) — that predicate lives in
   * `lapsed-portal-scope`, not on the `members` row, and the Task 7
   * use-case re-asserts it per-member before drafting.
   *
   * Single capped page (`nextCursor` hardwired `null`, same scaling
   * caveat as `listCyclesEligibleForLapse` — fine at TSCC's member
   * count). Ordered `expires_at ASC` (soonest-expiring first). Runs
   * inside `runInTenant` (RLS+FORCE on both `renewal_cycles` and the
   * joined `members`/`invoices` tables); `tenantId` is threaded
   * explicitly per the port's compile-enforcement convention (file
   * header) even though the adapter also closes over the tenant via the
   * repo factory.
   */
  listCyclesEligibleForAutoDraft(
    tenantId: string,
    args: {
      readonly nowIso: string;
      readonly leadDaysRolling: number;
      readonly leadDaysCalendar: number;
      readonly pageSize: number;
    },
  ): Promise<AutoDraftEligiblePage>;

  /**
   * 107-auto-invoice Task 7 — precise per-(member, plan_year) dedup
   * re-check, run under the per-cycle advisory lock immediately before
   * drafting. `listCyclesEligibleForAutoDraft`'s own dedup (Task 6) is
   * coarse + MEMBER-scoped (any draft/issued invoice, any plan_year) —
   * by the time a cycle reaches this re-check it should already be
   * true that no such invoice exists, so this is a genuine TOCTOU
   * guard: did a concurrent writer (a member self-renewing via
   * `confirmRenewal` in the gap between the list query and this lock)
   * create one in the race window? `status IN ('draft','issued')`
   * mirrors Task 6's own dedup predicate — NOT the broader
   * paid-inclusive content guard (design §5.4) Task 9 uses at ISSUE
   * time as the primary duplicate-§86/4 barrier; this method only
   * protects against drafting a second DRAFT.
   *
   * `tenantId` is an explicit app-layer WHERE predicate on `invoices`
   * (Constitution Principle I two-layer isolation), not merely relied
   * on via the inherited RLS GUC — matches `listCyclesEligibleForAutoDraft`'s
   * own belt-and-suspenders filter against the same cross-module table.
   */
  hasLiveMembershipInvoiceForPlanYearInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
    planYear: number,
  ): Promise<boolean>;

  /**
   * 107-auto-invoice Task 9 — point-read of ONE membership invoice, backing
   * `issueAutoDraftedRenewal`'s HARD REQ #1 shape check.
   *
   * The F4 bridge's `issueExistingDraftForRenewal` will issue ANY invoice id
   * handed to it — it has no origin/status/ownership check of its own. So the
   * queue-issue use-case must verify, under the per-cycle lock and BEFORE
   * issuing, that the target really is the `origin='auto_renewal'`,
   * `status='draft'` row belonging to the member/cycle it claims. A wrong or
   * stale invoice id must produce a typed error, never silently issue an
   * unrelated manual draft.
   *
   * Returns `null` for a non-existent id, another tenant's row (RLS + the
   * app-layer filter), or a non-`membership` invoice (an event-fee invoice is
   * never an auto-renewal draft and must not resolve here).
   */
  findMembershipInvoiceInTx(
    tx: TenantTx,
    tenantId: string,
    invoiceId: string,
    // `planId` is returned alongside the ref so `issueAutoDraftedRenewal` can
    // refuse a draft whose stored plan no longer matches the cycle's current
    // frozen plan (a same-term admin plan-change after drafting — audit: tax).
  ): Promise<(MembershipInvoiceRef & { readonly planId: string | null }) | null>;

  /**
   * 107-auto-invoice Task 9 (review New-1 follow-through) — clear a STALE
   * `linked_invoice_id`, i.e. one pointing at an invoice that is no longer a
   * live bill (voided for correction).
   *
   * Voiding an invoice does not touch the cycle: nothing clears
   * `linked_invoice_id` on void (the only other writer that clears it is
   * `reanchorPeriodInTx`) and there is no void→renewals callback. Without this,
   * a bill voided for correction wedges the member out of renewing —
   * `linkInvoice`'s `WHERE (linked_invoice_id IS NULL OR = $1)` guard rejects
   * the replacement bill's link, and by then a NEW §87 number has already been
   * burned and is orphaned. Relaxing `linkInvoice` itself was rejected: its
   * guard is what stops two concurrent renewals from silently overwriting each
   * other's claim, and it cannot distinguish "stale because voided" from
   * "another writer legitimately won".
   *
   * CAS on the exact id the caller observed (`WHERE cycle_id = ? AND
   * linked_invoice_id = ?`) so a concurrent writer that re-linked the cycle in
   * the meantime is never clobbered; returns `false` when 0 rows matched.
   * Callers MUST verify the target invoice is genuinely non-live first — this
   * method deliberately does not re-check, so it can never be the thing that
   * unlinks a live bill.
   */
  clearStaleLinkedInvoiceInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    expectedInvoiceId: string,
  ): Promise<boolean>;

  /**
   * 107-auto-invoice Task 9 — resolve the cycle that Task 7 stamped with this
   * draft invoice id (`renewal_cycles.auto_draft_invoice_id`).
   *
   * Distinct from `findByInvoiceIdInTx`, which matches `linked_invoice_id` —
   * the ISSUED-and-linked back-reference. An auto-draft is not linked until
   * `issueAutoDraftedRenewal`'s tx2 stamps it, so the queue-issue path must
   * traverse the draft-stage column instead.
   */
  findByAutoDraftInvoiceIdInTx(
    tx: TenantTx,
    tenantId: string,
    invoiceId: string,
  ): Promise<RenewalCycle | null>;

  /**
   * 107-auto-invoice Task 13 — batched, NON-transactional sibling of
   * {@link findByAutoDraftInvoiceIdInTx}, for the admin review-queue LIST
   * page: given a page of `origin='auto_renewal'` draft invoiceIds,
   * resolves each one's originating cycle in ONE query
   * (`renewal_cycles.auto_draft_invoice_id IN (...)`) instead of an N+1
   * round-trip per row. Read-only — no lock, no tx (mirrors
   * `findLatestCyclesForMembers`'s non-tx batched shape).
   *
   * Keyed by `invoiceId` (the map key IS the value the caller already has
   * per row) rather than returning an array + forcing the caller to
   * re-index. A row with no matching cycle is simply ABSENT from the
   * result — this is the Task 7 "orphaned after commit" window (see that
   * module's docstring): tx2 (stamp + audit) can fail AFTER the F4 draft's
   * own tx already committed, leaving a real draft invoice with no
   * `auto_draft_invoice_id` back-reference. Callers must treat a missing
   * entry as "cannot resolve queue context for this row", never throw.
   */
  findCyclesByAutoDraftInvoiceIds(
    tenantId: string,
    invoiceIds: readonly string[],
  ): Promise<ReadonlyMap<string, RenewalCycle>>;

  /**
   * 107-auto-invoice Task 9 — every membership invoice for one
   * (member, plan_year), any status, any origin.
   *
   * A SIBLING of `hasLiveMembershipInvoiceForPlanYearInTx` rather than an
   * extension of it: that method's narrow `{draft, issued}` predicate is
   * load-bearing for Task 7's DRAFT-time dedup and must not change, and a
   * status-set parameter with a default would let a future caller silently
   * inherit the wrong (narrower) tax guard. Returning the ROWS instead of a
   * boolean lets ONE query serve both of Task 9's needs — the paid-inclusive
   * content guard and the tx3 sibling-draft discard scan — and lets the
   * refusal name the conflicting invoice for forensics.
   *
   * `tenantId` is an explicit app-layer `WHERE` predicate on `invoices`
   * (Constitution Principle I two-layer isolation), not merely the inherited
   * RLS GUC.
   */
  listMembershipInvoicesForPlanYearInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
    planYear: number,
  ): Promise<ReadonlyArray<MembershipInvoiceRef>>;

  /**
   * membership-coverage-exclude-guard (mig 0281) — every membership invoice for
   * one member with its PERSISTED true charged coverage window
   * (`invoices.coverage_from/to`) + status, so a mint use-case can run the
   * pre-flight overlap guard (`findOverlappingMembershipCoverageBill`) that is
   * the application twin of the DB EXCLUDE constraint. MEMBER-scoped (NOT
   * plan_year — the anchored pin lags the charged term). `tenantId` is an
   * explicit app-layer WHERE (Principle I two-layer isolation).
   */
  listMembershipCoverageForMemberInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<ReadonlyArray<MembershipBillCoverageRow>>;

  /**
   * membership-coverage-exclude-guard (mig 0281 — queue-prediction alignment).
   * The MEMBER-scoped coverage rows for a BATCH of members, keyed by memberId,
   * so the auto-renewal review queue's `duplicate_live_bill` PREDICTION uses the
   * SAME coverage-overlap discriminator as the real `issueAutoDraftedRenewal`
   * guard (which stopped using the plan_year-coarse `findLiveMembershipBill`).
   * Member-scoped, NOT (member, plan_year)-scoped: the anchored plan_year pin
   * lags a full term behind the coverage a §86/4 charges, so a plan_year-keyed
   * read would miss the very bill the overlap check must see. Non-tx, read-only,
   * no lock (mirrors `findLatestCyclesForMembers`). An empty `memberIds` MUST
   * short-circuit at the use-case (no DB hit).
   */
  listMembershipCoverageForMembers(
    tenantId: string,
    memberIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlyArray<MembershipBillCoverageRow>>>;

  /**
   * 107-auto-invoice Task 7 — stamp `renewal_cycles.auto_draft_invoice_id`
   * with the cron-created DRAFT invoice's id (Task 1 added the nullable,
   * no-FK column; this is its first writer). Plain UPDATE, no CAS — the
   * column is a forensic reference for the review queue (a later task),
   * not a state-machine field, so a concurrent overwrite is not a race
   * this method needs to defend against (the per-cycle advisory lock
   * the caller already holds serialises writers on this cycle anyway).
   */
  stampAutoDraftInvoiceIdInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    invoiceId: string,
  ): Promise<void>;

  /**
   * 107-auto-invoice Task 11 — candidates for the daily `prune-auto-drafts`
   * housekeeping cron: every `origin='auto_renewal' status='draft'`
   * membership invoice whose stamped cycle (`renewal_cycles.auto_draft_
   * invoice_id = invoices.invoice_id`) has LEFT the `upcoming|reminded`
   * window — the member self-renewed (their cycle moved to
   * `awaiting_payment` via a fresh `confirmRenewal`/issue) or the cycle
   * lapsed after the T-30ish draft (grace-expiry cron wrote `lapsed`). A
   * draft whose cycle is STILL `upcoming`/`reminded` is a live candidate
   * for `issueAutoDraftedRenewal` and must never appear here.
   *
   * `tenantId` is an explicit app-layer `WHERE` predicate on `invoices`
   * (Constitution Principle I two-layer isolation) — matches the sibling
   * Task 6/7/9 queries against this same cross-module table.
   */
  listStaleAutoDrafts(
    tenantId: string,
  ): Promise<ReadonlyArray<StaleAutoDraftRow>>;

  /**
   * 107-auto-invoice Task 11 — candidates for the daily
   * `reconcile-issued-orphans` housekeeping cron: every
   * `origin='auto_renewal' status='issued'` membership invoice whose
   * stamped cycle has `linked_invoice_id IS NULL` — the bill was minted
   * but `issueAutoDraftedRenewal`'s tx2 (flip + link) never ran, or
   * exhausted its idempotent retry (`F8.AUTO_ISSUE.LINK_FAILED`). The
   * bill itself is real and payable; only the cycle's forensic linkage is
   * missing. A `completed` cycle can never appear here — the DB CHECK
   * `completed → linked_invoice_id NOT NULL` makes `IS NULL` and
   * `status='completed'` mutually exclusive.
   *
   * `tenantId` is an explicit app-layer `WHERE` predicate on `invoices`,
   * matching the sibling Task 6/7/9 cross-module queries.
   */
  listIssuedAutoInvoiceOrphans(
    tenantId: string,
  ): Promise<ReadonlyArray<IssuedAutoInvoiceOrphanRow>>;

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

  /**
   * Renewals-by-month aggregation. Groups `MONTH_PLANNING_MEMBER_SQL`
   * cycles by `to_char(expires_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')`
   * then folds into overdue / 12-month window / later relative to `nowIso`.
   * Excludes GDPR-erased members + terminal + pending_admin_reactivation
   * cycles by construction (see the shared predicate). Runs inside
   * `runInTenant` (RLS+FORCE; threads `tx`, never global `db`).
   *
   * `expires_at` is `timestamptz`; `AT TIME ZONE 'Asia/Bangkok'` yields the
   * correct BKK wall-clock month. A future column-type change to a plain
   * timestamp would silently break this — must trip review.
   */
  countCyclesByExpiryMonth(
    tenantId: string,
    opts: { nowIso: string; timezone: 'Asia/Bangkok' },
  ): Promise<RenewalMonthAggregation>;

  /** ALL cycle rows for the member, any status. In-tx (classification must see uncommitted writes). */
  countCyclesForMemberInTx(tx: TenantTx, tenantId: string, memberId: string): Promise<number>;

  /**
   * Cluster 4 review-fix (money BLOCKER) — the member's PAID-THROUGH
   * frontier: `MAX(period_to)` across the cycles that represent EFFECTIVE-PAID
   * coverage. A cycle counts as paid coverage only when its SETTLING invoice
   * (linked for a completed cycle, anchor for an open one) has NOT been fully
   * reversed: a fully refunded / voided / credit-noted ('void'/'credited')
   * settling invoice retracts the cycle (plan-change-ux task #24); a partial
   * credit or a NULL settling id (backfill) still counts. This is the SAME
   * predicate `countSettledCyclesForMemberInTx` uses — the single canonical
   * notion of "coverage was paid for and NOT refunded" in F8.
   *
   * A cycle that was later CANCELLED by the archive cascade still counts when
   * it was anchored to a real (unreversed) payment (cancel does NOT un-pay the
   * coverage — `anchored_at` survives the cancel). An UNPAID cancelled/lapsed
   * cycle (never completed, never anchored) is excluded by construction. Returns
   * `null` when the member has no effective-paid coverage at all (a fresh
   * import, OR every prior cycle's settling invoice was refunded/voided).
   *
   * Used by the undelete-restore (`restoreCycleForMember`) to anchor the
   * re-created cycle AT the frontier rather than at the registration
   * anniversary — otherwise the rolling-anchor model (which moves a paid
   * period off the anniversary) could re-create a cycle OVERLAPPING an
   * already-paid period → the enter-awaiting cron issues a DUPLICATE
   * invoice (double-bill). In-tx so the restore reads a consistent snapshot
   * with the `createCycleInTx` idempotency guard + insert in the SAME tx.
   */
  findMaxPaidThroughForMemberInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<string | null>;

  /**
   * Count of the member's cycles — EXCLUDING `excludeCycleId` (the
   * caller's current open cycle) — that represent EFFECTIVE-PAID coverage
   * (the SAME predicate `findMaxPaidThroughForMemberInTx` uses: settled AND
   * its settling invoice not fully refunded/voided/credited — task #24). F2 fix
   * (final-review, 2026-07-09) — feeds `classifyMembershipPayment`'s
   * `settledCycleCountForMember` so a member whose only prior cycles are
   * cancelled/lapsed WITHOUT ever anchoring (never actually paid) — OR whose
   * only settled cycle was later fully REFUNDED — still classifies
   * `first_payment` on their next real payment, even though
   * `countCyclesForMemberInTx` is > 0 for them. In-tx (classification
   * must see uncommitted writes, same rationale as
   * `countCyclesForMemberInTx`).
   */
  countSettledCyclesForMemberInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
    excludeCycleId: string,
  ): Promise<number>;

  /** The member's open cycle (status IN upcoming|reminded|awaiting_payment), or null. At most one by invariant; 'reminded' folded into the open set defensively (vestigial status). */
  findOpenCycleForMemberInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<RenewalCycle | null>;

  /**
   * 066 F-5 review — the in-tx sibling of `findLatestCycleForMember`: the
   * member's single most-recent cycle across ALL statuses (incl. lapsed /
   * cancelled), threaded on the caller's tx so a settlement hook can derive
   * `deriveMembershipAccess` on the SAME snapshot it just classified against.
   * Same ORDER key (created_at DESC, cycle_id DESC) so the in-tx and non-tx
   * reads never disagree on "latest". Backs the terminal_only net's
   * "is this member actually terminated?" gate in
   * `resolveUnlinkedMembershipPaymentInTx` (which runs inside F4's payment tx,
   * so it must NOT reach for the non-tx `runInTenant` variant).
   */
  findLatestCycleForMemberInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<RenewalCycle | null>;

  /**
   * Rolling first-payment re-anchor (spec rev 2 §2). Guarded single UPDATE:
   * only an un-anchored open cycle qualifies; status resets to 'upcoming'
   * (sanctioned TRANSITIONS bypass — documented at the SQL); linked_invoice_id
   * cleared so the future renewal links cleanly; frozen fields replaced when
   * the caller re-resolved them (pass current values otherwise). Deletes the
   * cycle's renewal_reminder_events rows in the same tx and returns their
   * count. Returns null when the guard matched 0 rows (race — caller re-reads
   * and reclassifies).
   */
  reanchorPeriodInTx(
    tx: TenantTx,
    tenantId: string,
    cycleId: CycleId,
    args: {
      readonly periodFrom: string;
      readonly periodTo: string;
      readonly anchoredAt: string;
      readonly anchorInvoiceId: string | null;
      readonly frozenPlanPriceThb: ThbDecimal;
      readonly frozenPlanTermMonths: number;
    },
  ): Promise<{ readonly cycle: RenewalCycle; readonly reminderEventsReset: number } | null>;
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
  /**
   * Renewals-by-month lens — `'overdue' | 'YYYY-MM' | 'later'` (validated
   * upstream by the use-case). When present the row query is rebuilt from
   * `MONTH_PLANNING_MEMBER_SQL` + a month bound and the 90-day ceiling is
   * SUPPRESSED; the urgency summary + lapsed count are UNAFFECTED. Requires
   * `nowIso` to resolve the BKK month boundaries. Ignores `tier`.
   */
  readonly monthFilter?: string;
  /** ISO instant driving the month-filter boundaries (BKK). */
  readonly nowIso?: string;
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
   * plan-change-ux seam 1(b) + L1 — TRUE when this cycle's period is already
   * EFFECTIVELY-PAID coverage, regardless of whether a renewal invoice has
   * been LINKED yet. An `upcoming` cycle covering an already-paid window
   * carries the paid anchor on `anchor_invoice_id` (NULL for the R4 backfill
   * of pre-system payments) — NOT on `linked_invoice_id`, which the read-model
   * shows in the invoice cell. Without this flag that row renders an empty "—"
   * invoice cell which, paired with a pre-expiry countdown, reads to staff as
   * "payment owed / unpaid". The UI shows a "Covered" indicator instead.
   *
   * L1 refinement: the flag is `anchored_at IS NOT NULL` AND the anchor
   * invoice is still effectively-paid — the read-model now LEFT JOINs
   * `invoices` on `anchor_invoice_id` because `anchored_at` is set-once and is
   * NOT cleared when the anchor invoice is later VOIDED (F4) or fully
   * credit-noted / refunded (F5 → §86/10 → status 'credited'). Those two
   * statuses drop `anchored` to FALSE; a PARTIAL credit
   * ('partially_credited') stays covered; a NULL anchor status (R4 backfill,
   * or a practically-impossible hard-deleted tax invoice) stays covered.
   */
  readonly anchored: boolean;
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
