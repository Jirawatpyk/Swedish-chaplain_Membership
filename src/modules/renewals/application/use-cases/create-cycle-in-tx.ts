/**
 * F8-completion Slice 1 · Task 1.2 — `createCycleInTx` shared helper.
 *
 * The SINGLE home for all cycle-creation invariants. Every cycle-
 * creation entry point consumes it — none forks a parallel creator:
 *   - the on-paid steady-state callback (`create-next-cycle-on-paid`),
 *   - the member import cold-start,
 *   - the create-member onboarding listener,
 *   - the Slice-3 admin lapsed-comeback fresh cycle.
 *
 * Responsibilities (in order):
 *   1. In-tx-visible idempotency no-op via `findActiveForMemberInTx`
 *      (NEVER the connection-fresh `findActiveForMember` — that cannot
 *      see an uncommitted prior-cycle `→completed` flip made earlier in
 *      the SAME tx, which would make the on-paid creation no-op on first
 *      delivery; see Task 1.1).
 *   2. Frozen-price snapshot via `loadPlanFrozenFields` (FR-021a — the
 *      cycle freezes the resolved plan's price/term/tier at creation
 *      time; never overwritten afterwards).
 *   3. Gapless period derivation: `periodTo = periodFrom + termMonths`
 *      via the shared `addMonthsUtc` helper (`@/lib/dates`) — direct UTC
 *      month arithmetic with month-end clamping (Jan 31 + 1mo → Feb 28, not
 *      Mar 3), same as `mark-paid-offline`. Asia/Bangkok is UTC+7 with no DST
 *      so the UTC instant lands on the same Bangkok calendar date — no
 *      js-joda needed.
 *   4. `renewal_cycle_created` audit emit IN THE SAME tx after insert
 *      (Constitution Principle VIII — state↔audit atomicity).
 *
 * Pure Application — orchestrates Domain via port interfaces only. No
 * ORM / HTTP / framework / React imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import { addMonthsUtc } from '@/lib/dates';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { omitUndefined } from '@/lib/object-helpers';
import type { MemberId } from '@/modules/members';
import type {
  NewRenewalCycleInput,
  RenewalCycleRepo,
} from '../ports/renewal-cycle-repo';
import type {
  PlanFrozenFields,
  PlanLookupForRenewalPort,
  PlanLookupForRenewalResult,
} from '../ports/plan-lookup-for-renewal';
import type {
  RenewalActorRole,
  RenewalAuditEmitter,
} from '../ports/renewal-audit-emitter';
import { asCycleId, type CycleId, type RenewalCycle } from '../../domain/renewal-cycle';

/**
 * The plan a cycle-creation entry point referenced cannot be resolved to a
 * frozen price (the F2 plan-lookup returned `not_found` or `plan_inactive`).
 * `createCycleInTx` THROWS this rather than inserting a cycle with no frozen
 * price — a cycle without a frozen §86/4 price is an unbillable orphan.
 *
 * Typed sentinel (070 Item B): callers narrow with
 * `instanceof PlanNotResolvableError` — NOT a brittle
 * `message.includes('not resolvable')` string-match (which mis-classified any
 * coincidentally-worded infra throw as a plan error). The carried fields
 * (`planId` / `memberId` / `planStatus`) give the caller + forensic logs the
 * full context without re-parsing the message. The human-readable `message`
 * text is preserved byte-for-byte for existing log greps.
 *
 * Co-located here (the throwing site) mirroring the module's other
 * Application-layer typed errors (`CycleNotFoundError`,
 * `CycleTransitionConflictError`, `InvoiceLinkConflictError` in
 * `renewal-cycle-repo.ts`). Pure Application — no framework imports
 * (Constitution Principle III).
 */
export class PlanNotResolvableError extends Error {
  override readonly name = 'PlanNotResolvableError';
  constructor(
    public readonly planId: string,
    public readonly memberId: string,
    public readonly planStatus: 'not_found' | 'plan_inactive',
  ) {
    super(
      `createCycleInTx: plan "${planId}" not resolvable (status=${planStatus}) for member ${memberId} — refusing to create a cycle without a frozen price`,
    );
  }
}

export interface CreateCycleInTxDeps {
  readonly cyclesRepo: Pick<
    RenewalCycleRepo,
    'findActiveForMemberInTx' | 'insert'
  >;
  /** F8 → F2 plan-lookup; supplies the frozen price/term/tier. */
  readonly planLookup: PlanLookupForRenewalPort;
  readonly auditEmitter: RenewalAuditEmitter;
  /** Cycle-id generator (production: `() => asCycleId(randomUUID())`). */
  readonly idFactory: { cycleId(): CycleId };
}

export interface CreateCycleInTxInput {
  readonly tenantId: string;
  readonly memberId: string;
  /**
   * ISO 8601 UTC period anchor. Steady-state on-paid: prior.periodTo
   * (gapless). Import / onboarding: the member's registration_date.
   * Admin lapsed-comeback: the comeback instant.
   */
  readonly periodFrom: string;
  readonly planId: string;
  readonly actorUserId: string | null;
  readonly actorRole: RenewalActorRole;
  readonly correlationId: string;
  /**
   * Initial cycle status. Defaults to `'upcoming'`. Slice 3's admin
   * lapsed-comeback path passes `'awaiting_payment'` so the fresh cycle
   * is immediately payable.
   */
  readonly startStatus?: 'upcoming' | 'awaiting_payment';
  /**
   * 068 cluster F + R2-1 — when set, advance `periodFrom` from its raw value by
   * whole `termMonths` multiples (preserving the anniversary month/day, clamped
   * at month-end — see `addMonthsUtc`) until `periodTo > nowIso`, so the cycle
   * lands on the member's CURRENT membership period. The two cold-start /
   * onboarding paths anchored at a member-supplied `registration_date` set this:
   *   - the member-import cold-start (`scripts/import-members.ts`); and
   *   - the create-member onboarding listener
   *     (`f8-on-create-member-callbacks.ts`) — the admin "New member" form is a
   *     free `<input type=date>` with no not-in-past constraint.
   * A long-standing member (e.g. registered 2015) anchored at the raw
   * `registration_date` would get `periodTo = 2016` (years past) → the
   * enter-awaiting + lapse crons would immediately flip a paid-up member to
   * `lapsed`. The other entry points already anchor at the current period
   * (on-paid uses `prior.periodTo`; admin-lapsed-comeback uses the comeback
   * instant), so they DO NOT set this and their behaviour is unchanged.
   *
   * `nowIso` is the server clock (ISO 8601 UTC). When omitted, `periodFrom` is
   * used verbatim (the existing behaviour for the on-paid / admin-comeback
   * paths). A current-period `periodFrom` is a no-op (the first iteration
   * already covers `now`).
   */
  readonly anchorToCurrentPeriod?: { readonly nowIso: string };
}

export type CreateCycleOutcome =
  | { readonly kind: 'created'; readonly cycle: RenewalCycle }
  | { readonly kind: 'skipped_active_exists' };

/**
 * 068 cluster F — advance `periodFromIso` by whole `termMonths` multiples
 * (preserving the anniversary month/day) until `periodFrom + termMonths >
 * nowIso`, i.e. the member's CURRENT membership period. A member already in
 * their current/future period (the common case) is returned unchanged on the
 * first iteration. Used by the two registration_date-anchored paths — the
 * import cold-start and the create-member onboarding listener (see
 * `CreateCycleInTxInput.anchorToCurrentPeriod`).
 *
 * Anniversary is preserved via `addMonthsUtc`, which clamps a month-end
 * overflow to the last day of the target month (068 R2-2) — so a Feb-29 or
 * month-end registration anniversary does NOT drift forward across the
 * iterations (it would compound under a naïve roll-over).
 *
 * Bounded by construction: each iteration adds `termMonths` (≥1), so the loop
 * advances strictly forward and terminates as soon as the window covers `now`.
 * A hard cap (200 iterations ≈ centuries at a 12-month term) guards against a
 * pathological `termMonths` of 0 — `createCycleInTx` already rejects such a
 * plan upstream, but the cap keeps this a total function.
 */
function advanceAnchorToCurrentPeriod(
  periodFromIso: string,
  termMonths: number,
  nowIso: string,
): string {
  const nowMs = Date.parse(nowIso);
  let anchor = periodFromIso;
  for (let i = 0; i < 200; i++) {
    // 068 R2-3 — compute the candidate period end ONCE per iteration (was
    // called twice with identical args: the `> now` test + the advance).
    const next = addMonthsUtc(anchor, termMonths);
    if (Date.parse(next) > nowMs) return anchor;
    anchor = next;
  }
  return anchor;
}

export async function createCycleInTx(
  deps: CreateCycleInTxDeps,
  tx: TenantTx,
  input: CreateCycleInTxInput,
): Promise<CreateCycleOutcome> {
  // 1. Idempotency — in-tx-visible guard (NEVER the connection-fresh
  //    variant; see Task 1.1). If the member already holds an active
  //    cycle (including an uncommitted prior-cycle that has NOT yet been
  //    flipped →completed in this tx), do nothing.
  const active = await deps.cyclesRepo.findActiveForMemberInTx(
    tx,
    input.tenantId,
    input.memberId,
  );
  if (active) {
    return { kind: 'skipped_active_exists' };
  }

  // 2. Frozen-price snapshot (FR-021a). The cycle freezes the resolved
  //    plan's price/term/tier at creation; a later catalogue price bump
  //    does NOT change this cycle's billing.
  //
  //    070 §86/4 — the freeze MUST resolve by the cycle's OWN fiscal year
  //    (`mode: 'freeze'` — a FREEZE, not a plan-offer check; a seeded-but-
  //    not-yet-active next-year row is the correct frozen price for that
  //    year). The cycle's year is the year of the RESOLVED `periodFrom`
  //    (post current-period anchoring), but anchoring needs the plan's
  //    `termMonths`. The plan term is stable across catalogue years (the
  //    multi-year axis is the cycle's own `cycleLengthMonths`), so we
  //    resolve in two steps:
  //      (a) a provisional lookup keyed on the RAW input year supplies the
  //          term used to anchor `periodFrom`;
  //      (b) once `periodFrom` (hence the real fiscal year) is known, the
  //          definitive freeze lookup uses THAT year — re-querying only
  //          when anchoring crossed a year boundary (the rare cold-start
  //          case; the common path's year is unchanged → no second query).
  //
  //    070 Item B — `resolvePlanOrThrow` collapses the (previously
  //    duplicated) "not found → typed sentinel" guard into one place. The
  //    sentinel is a typed `PlanNotResolvableError` (callers narrow via
  //    `instanceof`, NOT a brittle message string-match); `result.status`
  //    is narrowed to `'not_found' | 'plan_inactive'` inside it.
  const resolvePlanOrThrow = (
    result: PlanLookupForRenewalResult,
  ): PlanFrozenFields => {
    if (result.status !== 'found') {
      throw new PlanNotResolvableError(
        input.planId,
        input.memberId,
        result.status,
      );
    }
    return result.plan;
  };

  const provisionalFiscalYear = deriveFiscalYear(input.periodFrom);
  const provisionalPlan = resolvePlanOrThrow(
    await deps.planLookup.loadPlanFrozenFields({
      tenantId: input.tenantId,
      planId: input.planId,
      fiscalYear: provisionalFiscalYear,
      mode: 'freeze',
    }),
  );

  // 3. Gapless period derivation. 068 cluster F — the import cold-start opts
  //    into current-period anchoring (advance the raw registration_date by
  //    whole term multiples so a long-standing member lands on their CURRENT
  //    period, not a years-past one). Every other entry point passes
  //    `periodFrom` already at the current period, so `periodFrom` is used
  //    verbatim there.
  const periodFrom = input.anchorToCurrentPeriod
    ? advanceAnchorToCurrentPeriod(
        input.periodFrom,
        provisionalPlan.termMonths,
        input.anchorToCurrentPeriod.nowIso,
      )
    : input.periodFrom;

  // 070 §86/4 — definitive freeze lookup for the cycle's ACTUAL fiscal
  // year. Reuse the provisional result when anchoring did not cross a
  // year boundary (always true on the non-anchored paths).
  //
  // INVARIANT (load-bearing): `termMonths` is plan-stable across catalogue
  // years — the multi-year axis is the cycle's own `cycleLengthMonths`, not
  // the plan's term (see the adapter's term-months note). So a year-boundary
  // re-resolve can only change price/tier, NEVER the term that anchored
  // `periodFrom` above; the provisional term stays correct.
  const fiscalYear = deriveFiscalYear(periodFrom);
  let plan = provisionalPlan;
  if (fiscalYear !== provisionalFiscalYear) {
    plan = resolvePlanOrThrow(
      await deps.planLookup.loadPlanFrozenFields({
        tenantId: input.tenantId,
        planId: input.planId,
        fiscalYear,
        mode: 'freeze',
      }),
    );
  }

  const periodTo = addMonthsUtc(periodFrom, plan.termMonths);

  const cycleId = deps.idFactory.cycleId();
  const newCycle: NewRenewalCycleInput = {
    tenantId: input.tenantId,
    cycleId,
    memberId: input.memberId,
    periodFrom,
    periodTo,
    cycleLengthMonths: plan.termMonths,
    tierAtCycleStart: plan.tierBucket,
    planIdAtCycleStart: input.planId,
    frozenPlanPriceThb: plan.priceTHB,
    frozenPlanTermMonths: plan.termMonths,
    // FIX-8(c) (PR #173 review, 2026-07-09) — `omitUndefined` replaces the
    // conditional-spread idiom (same exactOptionalPropertyTypes rationale
    // as the membershipCoverage sites).
    ...omitUndefined({ startStatus: input.startStatus }),
  };
  const cycle = await deps.cyclesRepo.insert(tx, input.tenantId, newCycle);

  // 4. Audit in the SAME tx (Principle VIII). The payload matches the
  //    canonical `F8AuditPayloadShapes.renewal_cycle_created` shape.
  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_cycle_created',
      payload: {
        cycle_id: asCycleId(cycleId),
        member_id: input.memberId as MemberId,
        tier_bucket: plan.tierBucket,
        // 068 cluster F — the persisted/anchored periodFrom (not the raw
        // input), so the audit row matches the cycle row exactly.
        period_from: periodFrom,
        period_to: periodTo,
      },
    },
    {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      correlationId: input.correlationId,
    },
  );

  return { kind: 'created', cycle };
}
