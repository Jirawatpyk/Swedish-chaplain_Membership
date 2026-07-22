/**
 * F8-completion Slice 3 · Task 3.1 — `adminRenewLapsedMember`.
 *
 * The admin "renew / reactivate a lapsed member" action — the REACHABLE
 * lapsed-comeback path. An admin creates a fresh `awaiting_payment`
 * renewal cycle for a lapsed member (one with no active cycle) + issues a
 * §86/4 renewal invoice the member then pays. Once paid, the F4→F8
 * on-paid callbacks close the loop automatically: callback[0] flips the
 * fresh cycle `→completed` and callback[2] creates the next `upcoming`
 * cycle — the member is active again.
 *
 * This is the common-case reachable path only. The
 * `pending_admin_reactivation` money-hold reactivate/reject flow now ships
 * separately (070 item #18 — `/api/admin/renewals/[cycleId]/reactivate|reject`);
 * it is simply not part of THIS use-case, which only handles the reachable
 * lapsed-comeback create→issue→link.
 *
 * Flow (mirrors `confirm-renewal`'s create→issue→link structure so the
 * issue↔link orphan window is no wider than the proven member path):
 *
 *   1. **tx1** (`runInTenant`): resolve the member's CURRENT `plan_id`
 *      (`memberPlanLookup.loadMemberPlanInTx`; null ⇒ `member_not_found`),
 *      then `createCycleInTx(..., startStatus:'awaiting_payment')`. If the
 *      member already holds an active
 *      cycle, `createCycleInTx` no-ops (`skipped_active_exists`) ⇒
 *      `member_has_active_cycle` (the member is NOT lapsed — do not create
 *      a second cycle). If the plan is unresolvable, `createCycleInTx`
 *      throws ⇒ `plan_not_found`. The fresh cycle is `awaiting_payment`,
 *      frozen at the member's current plan price, with a
 *      `renewal_cycle_created` audit emitted in the SAME tx.
 *
 *   2. **issue (OUTSIDE tx1)**: `f4InvoicingBridge.issueInvoiceForRenewal`
 *      with `frozenPlanPriceThb` = the new cycle's frozen price (server-
 *      sourced; NEVER a request body — a §86/4 is a tax document) and
 *      `planYear` server-DERIVED from the fresh cycle's `period_from` via
 *      `deriveFiscalYear` (L1/L2 068 security review — neither the price
 *      nor the fiscal year on a §86/4 is client-influenceable; the same
 *      F4 fiscal-year convention the §87 allocator uses). F4 owns its own
 *      tx for §87 numbering + PDF render. Map failures to
 *      `invoice_issue_failed`. If the issue fails, the fresh cycle is left
 *      `awaiting_payment` with no linked invoice — the SAME recoverable
 *      state as a member who abandons their pay page (admin retries).
 *
 *   3. **tx2** (`runInTenant`): acquire the per-cycle advisory lock +
 *      `linkInvoice` (mirrors confirm-renewal Step-4). The lock + the
 *      adapter's `WHERE (linked_invoice_id IS NULL OR = $1)` guard close
 *      the orphan race. Emit `renewal_invoice_created`.
 *
 * RBAC: admin-only (`action='write'` at the route — manager 403). The
 * use-case input carries `actorRole:'admin'`; the route enforces the role
 * via `requireRenewalAdminContext(request, 'write')`.
 *
 * Coverage policy: Constitution Principle II — 100% branch coverage
 * (security + tax-sensitive mutating path: an admin issues a tax document
 * the member then pays).
 *
 * Pure Application — orchestrates Domain via port interfaces only
 * (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { addMonthsUtc } from '@/lib/dates';
import { omitUndefined } from '@/lib/object-helpers';
// L1 (068 security review) — Postgres 23505 detection. `@/lib/db-errors`
// is Infrastructure-free (only the stable Postgres SQLSTATE contract), so
// importing it in the Application layer is Principle-III clean — the same
// helper accept-tier-upgrade + F4/F5 conflict paths use.
import { isUniqueViolation, errorChainMessage } from '@/lib/db-errors';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalResult,
  RenewalInvoiceErrorCode,
} from '../ports/f4-invoicing-bridge';
import type { PlanLookupForRenewalPort } from '../ports/plan-lookup-for-renewal';
import type { MemberPlanLookupPort } from '../ports/member-plan-lookup-port';
import {
  createCycleInTx,
  PlanNotResolvableError,
  type CreateCycleInTxDeps,
} from './create-cycle-in-tx';
import {
  frozenPlanSnapshotsDiffer,
  type CycleId,
  type RenewalCycle,
} from '../../domain/renewal-cycle';
import { classifyMembershipPayment } from '../../domain/classify-membership-payment';
import { loadClassificationCounts } from './_lib/classification-input';
import { paymentAnchorMonthStartUtc } from './_lib/payment-anchor-date';
import {
  CycleNotFoundError,
  InvoiceLinkConflictError,
} from '../ports/renewal-cycle-repo';

/**
 * L1 (068 security review) — the partial UNIQUE index enforcing invariant
 * L135 ("at most one active cycle per member"):
 * `(tenant_id, member_id) WHERE status NOT IN ('lapsed','cancelled','completed')`
 * (migration 0087). A concurrent double-submit where the loser's in-tx
 * idempotency guard misses (the winner has not yet committed) lets the
 * loser's `createCycleInTx` insert reach this index → Postgres raises a
 * 23505. We map THAT 23505 to `member_has_active_cycle` (409-class), NOT
 * an opaque `server_error` (500). Named explicitly so a future unrelated
 * unique constraint's 23505 still surfaces as a genuine server error.
 */
const RENEWAL_CYCLES_ACTIVE_MEMBER_UNIQ = 'renewal_cycles_active_member_uniq';

export const adminRenewLapsedMemberInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type AdminRenewLapsedMemberInput = z.infer<
  typeof adminRenewLapsedMemberInputSchema
>;

export interface AdminRenewLapsedMemberOutput {
  readonly cycleId: string;
  readonly invoiceId: string;
  readonly cycleStatus: 'awaiting_payment';
}

export type AdminRenewLapsedMemberError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'member_not_found' }
  // 068 cluster C — the member exists but is archived. Rejected BEFORE the
  // cycle is created so an archived member never gets an orphan
  // awaiting_payment cycle. Admin must un-archive first.
  | { readonly kind: 'member_archived' }
  | { readonly kind: 'member_has_active_cycle' }
  | { readonly kind: 'plan_not_found' }
  | {
      readonly kind: 'invoice_issue_failed';
      readonly stage: 'create' | 'issue';
      // I-2 (068 speckit-review) — pinned to the bridge's closed F4
      // error vocabulary (was bare `string`) so an F4-side code rename
      // surfaces as a compile error rather than a runtime missing-toast.
      readonly errorCode: RenewalInvoiceErrorCode;
      readonly detail: string;
    }
  | { readonly kind: 'server_error'; readonly message: string };

export interface AdminRenewLapsedMemberDeps
  extends Pick<
    RenewalsDeps,
    'tenant' | 'cyclesRepo' | 'auditEmitter' | 'clock' | 'memberRenewalFlagsRepo'
  > {
  readonly f4InvoicingBridge: F4InvoicingForRenewalBridge;
  readonly planLookupForRenewal: PlanLookupForRenewalPort;
  readonly memberPlanLookup: MemberPlanLookupPort;
  /** Cycle-id generator (production: `() => asCycleId(randomUUID())`). */
  readonly cycleIdFactory: CreateCycleInTxDeps['idFactory'];
}

/**
 * Task 14 (059-membership-suspension) — decide the comeback cycle's
 * `period_from` anchor. This is the ONE cycle-creation path the anchor docs
 * (`docs/Bug/2026-07-08-renewal-paid-invoice-disconnect.md`, Q-2) reserved as
 * a payment-time anchor, refined here by the benefit-suspension design:
 *
 *   - **No settled predecessor** (`findMaxPaidThroughForMemberInTx` → null —
 *     the zero-history / never-paid cohort): keep the payment-month/now anchor.
 *     The value is PROVISIONAL — the fresh cycle classifies `first_payment`, so
 *     the F8 on-paid chain (`markCycleCompleteInTx` → `reanchorFirstPaymentCycleInTx`)
 *     RE-ANCHORS it to the actual payment month when the member pays, overriding
 *     whatever is set here (FIX-1). The §86/4 window is omitted for this cohort.
 *
 *   - **Settled predecessor** (frontier non-null — a genuine lapsed comeback):
 *     prefer the GAPLESS anniversary continuation `period_from = prior.periodTo`
 *     (`MAX(period_to)` over the member's settled coverage), because
 *     benefit-suspension already punished the late payment. Re-anchor to a fresh
 *     payment-month start ONLY when the gapless period has ALREADY fully expired
 *     (`gaplessPeriodTo <= now`, incl. the exact-boundary case) — the genuinely
 *     long-lapsed member. Either way this cycle classifies `renewal`, so on-paid
 *     COMPLETES it (never re-anchors) and creates the next cycle gaplessly at
 *     this cycle's `period_to` — so the anchor chosen here is FINAL and flows
 *     onto the printed §86/4 window + the next cycle's anchor.
 *
 * `findMaxPaidThroughForMemberInTx` uses the SAME "settled" predicate
 * (`status='completed' OR anchored_at IS NOT NULL`) as
 * `countSettledCyclesForMemberInTx`, so `frontier !== null` ⟺ the §86/4 gate's
 * `settledCycleCountForMember >= 1` (the fresh awaiting_payment cycle is never
 * settled, so excluding it does not change the count) — the anchor branch and
 * the window-print branch partition the member set identically, and the printed
 * window always matches the stored anchor whenever it is printed.
 */
async function resolveComebackPeriodFrom(
  deps: Pick<AdminRenewLapsedMemberDeps, 'cyclesRepo' | 'planLookupForRenewal'>,
  tx: TenantTx,
  tenantId: string,
  memberId: string,
  planId: string,
  nowIso: string,
): Promise<string> {
  const paidThrough = await deps.cyclesRepo.findMaxPaidThroughForMemberInTx(
    tx,
    tenantId,
    memberId,
  );
  if (paidThrough === null) {
    // No settled predecessor — keep the now anchor (onPaid re-anchors the
    // first_payment cycle to the actual payment month).
    return nowIso;
  }
  // Size the gapless window with the member's CURRENT plan term. Term is
  // plan-stable across catalogue years (the multi-year axis is the cycle's own
  // length — see `create-cycle-in-tx.ts`), so any fiscal year resolves the same
  // `termMonths`. If the plan is unresolvable the window can't be sized — fall
  // through to `now`; `createCycleInTx` re-resolves and throws
  // `PlanNotResolvableError` (→ `plan_not_found`), so no cycle is written and
  // the returned anchor is moot.
  const frozen = await deps.planLookupForRenewal.loadPlanFrozenFields({
    tenantId,
    planId,
    fiscalYear: deriveFiscalYear(nowIso),
    mode: 'freeze',
  });
  if (frozen.status !== 'found') {
    return nowIso;
  }
  const gaplessPeriodTo = addMonthsUtc(paidThrough, frozen.plan.termMonths);
  return Date.parse(gaplessPeriodTo) > Date.parse(nowIso)
    ? // Gapless period still live — keep the anniversary.
      paidThrough
    : // Gapless period fully expired — re-anchor to a fresh payment-month start
      // (Bangkok month boundary), the same anchor onPaid would set for a first
      // payment. No real payment yet at admin time → the comeback month is the
      // best proxy (onPaid does NOT re-anchor a `renewal` cycle later).
      paymentAnchorMonthStartUtc({ paymentDate: null, paidAt: nowIso });
}

export async function adminRenewLapsedMember(
  deps: AdminRenewLapsedMemberDeps,
  rawInput: AdminRenewLapsedMemberInput,
): Promise<Result<AdminRenewLapsedMemberOutput, AdminRenewLapsedMemberError>> {
  const parsed = adminRenewLapsedMemberInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;

  // ---- Step 1 (tx1): resolve member plan + create the fresh cycle.
  const createDeps: CreateCycleInTxDeps = {
    cyclesRepo: deps.cyclesRepo,
    planLookup: deps.planLookupForRenewal,
    auditEmitter: deps.auditEmitter,
    idFactory: deps.cycleIdFactory,
  };

  let stateResult: Result<
    { cycle: RenewalCycle; omitMembershipCoverage: boolean },
    AdminRenewLapsedMemberError
  >;
  try {
    stateResult = await runInTenant(deps.tenant, async (tx) => {
      // Resolve the member's CURRENT plan_id server-side. The frozen
      // §86/4 price derives from THIS plan, never a request body.
      const member = await deps.memberPlanLookup.loadMemberPlanInTx(
        tx,
        input.tenantId,
        input.memberId,
      );
      if (!member) {
        return err({ kind: 'member_not_found' as const });
      }

      // 068 cluster C — reject archived members BEFORE creating the cycle.
      // The renew-lapsed UI affordance is NOT gated on archive status, so
      // without this precheck an archived member would get a committed
      // `awaiting_payment` cycle in tx1 before `createInvoiceDraft` (Step 2)
      // rejects `member_archived` → orphan cycle, and every retry returns
      // `member_has_active_cycle` (permanently wedged). Fail fast inside tx1
      // (no cycle written) so the admin gets a clear "un-archive first" error.
      if (member.isArchived) {
        return err({ kind: 'member_archived' as const });
      }

      // Task 14 (059-membership-suspension) — the comeback anchor. Was an
      // unconditional `periodFrom = now`; now: gapless anniversary continuation
      // when the member has a settled predecessor whose gapless period is still
      // live, a fresh payment-month re-anchor when it has fully expired, and the
      // unchanged now anchor for the no-settled-predecessor cohort (onPaid
      // re-anchors that first_payment cycle regardless). See
      // `resolveComebackPeriodFrom`'s docstring for the on-paid interaction.
      const nowIso = deps.clock.now().toISOString();
      const periodFrom = await resolveComebackPeriodFrom(
        deps,
        tx,
        input.tenantId,
        input.memberId,
        member.planId,
        nowIso,
      );

      // createCycleInTx no-ops if an active cycle exists (the member is
      // NOT lapsed) ⇒ member_has_active_cycle. It THROWS on an
      // unresolvable plan ⇒ caught below as plan_not_found.
      const outcome = await createCycleInTx(createDeps, tx, {
        tenantId: input.tenantId,
        memberId: input.memberId,
        periodFrom,
        planId: member.planId,
        startStatus: 'awaiting_payment',
        actorUserId: input.actorUserId,
        actorRole: 'admin',
        correlationId: input.correlationId,
      });
      if (outcome.kind === 'skipped_active_exists') {
        return err({ kind: 'member_has_active_cycle' as const });
      }

      // FIX-1 (PR #173 review, 2026-07-09) — mirror confirm-renewal's
      // classification gate (F1, final-review 2026-07-09) so the §86/4
      // printed below OMITS the exact-window text for a `first_payment`
      // shape: a member reachable ONLY via `RenewalHealthCard`'s
      // "Renew"-on-null-status affordance (`isLapsed(null)` — the
      // zero-history cohort that never had a renewal cycle at all) gets
      // this admin-created cycle as their FIRST ever cycle. Without this
      // gate, that member's first invoice printed an exact window that
      // does not exist yet — `onPaid` re-anchors a first-payment cycle to
      // the actual payment month instead of completing it (same rationale
      // as confirm-renewal's docstring). Members with real terminal
      // history (a genuinely SETTLED predecessor cycle) keep the exact
      // window — this is the common "lapsed comeback" case this use-case
      // was built for. `countCyclesForMember` here already includes the
      // just-created row (same tx), so `settledCycleCountForMember`
      // (which excludes it) is what actually discriminates.
      // FIX-8(a) (PR #173 review, 2026-07-09) — shared loader (was inline
      // duplicated at every settlement site).
      //
      // R2-FIX-2 (PR #173 round-2 review, 2026-07-09) — read the REAL
      // GDPR-erased guard (was hardcoded `memberErased: false`) and gate
      // the printed window on `classification.kind === 'renewal'` (was the
      // narrower `=== 'first_payment'` boolean). Erasure NULLs risk_score +
      // stamps erased_at but does NOT archive the member, so the
      // `member.isArchived` precheck above does NOT catch an erased member;
      // without reading the flag, an erased member with settled history
      // classified `renewal` and printed the exact next-period window on a
      // §86/4 for a scrubbed member. Now the erased shape resolves
      // `not_applicable('erased')` — which, like `first_payment`, is
      // `!== 'renewal'` → the window is omitted (`createInvoiceDraft` falls
      // back to its `from_payment` default). This is the EXACT pattern
      // FIX-7(d) applied to confirm-renewal in this same PR; it gates only
      // the invoice TEXT, not whether the renewal is allowed (a hard erased
      // refusal is a separate COMP-1 policy decision).
      const guards = await deps.memberRenewalFlagsRepo.readReactivationGuardsInTx(
        tx,
        input.tenantId,
        input.memberId,
      );
      const { cycleCountForMember, settledCycleCountForMember } =
        await loadClassificationCounts(
          deps,
          tx,
          input.tenantId,
          input.memberId,
          outcome.cycle.cycleId,
        );
      const classification = classifyMembershipPayment({
        cycleCountForMember,
        settledCycleCountForMember,
        openCycle: { status: 'awaiting_payment', anchoredAt: outcome.cycle.anchoredAt },
        memberErased: guards?.erased === true,
      });
      return ok({
        cycle: outcome.cycle,
        omitMembershipCoverage: classification.kind !== 'renewal',
      });
    });
  } catch (e) {
    // L1 (068 security review) — concurrent double-submit. The loser's
    // `createCycleInTx` insert raced past its in-tx idempotency guard and
    // hit the `renewal_cycles_active_member_uniq` partial index → 23505.
    // This is a clean "the member already has an active cycle" outcome,
    // NOT a server fault: tx1 rolled back, no §86/4 was issued (issuance
    // is AFTER tx1), so the loser issues nothing. Map to the member-facing
    // member_has_active_cycle (409), not an opaque server_error (500).
    if (
      isUniqueViolation(e) &&
      errorChainMessage(e).includes(RENEWAL_CYCLES_ACTIVE_MEMBER_UNIQ)
    ) {
      logger.info(
        {
          tenantId: input.tenantId,
          memberId: input.memberId,
          correlationId: input.correlationId,
        },
        '[admin-renew-lapsed-member] concurrent double-submit lost the active-cycle uniq race → member_has_active_cycle',
      );
      return err({ kind: 'member_has_active_cycle' });
    }

    // createCycleInTx throws the typed `PlanNotResolvableError` ONLY when the
    // plan is unresolvable (it refuses to create a cycle without a frozen
    // price). 070 Item B — narrow on the type, NOT a brittle
    // `message.includes('not resolvable')` string-match (which mis-classified
    // any coincidentally-worded infra throw as a plan error). Any other throw
    // is a genuine infrastructure error.
    if (e instanceof PlanNotResolvableError) {
      return err({ kind: 'plan_not_found' });
    }
    const message = e instanceof Error ? e.message : String(e);
    logger.error(
      {
        err: e instanceof Error ? e : new Error(message),
        tenantId: input.tenantId,
        memberId: input.memberId,
        correlationId: input.correlationId,
      },
      '[admin-renew-lapsed-member] cycle-creation tx failed',
    );
    return err({ kind: 'server_error', message });
  }
  if (!stateResult.ok) return err(stateResult.error);
  const { cycle, omitMembershipCoverage } = stateResult.value;
  const cycleId: CycleId = cycle.cycleId;

  // L2 (068 security review) — derive plan_year SERVER-SIDE. The renewal
  // §86/4's "Membership {year}" label + the §87 fiscal-numbering bucket
  // must NOT be client-influenceable on a tax document. We derive the
  // fiscal year from the fresh cycle's `period_from` (server-set by the
  // Task-14 comeback-anchor decision — gapless / re-anchor / now) using the
  // SAME `deriveFiscalYear` the F4 sequential-number allocator uses — so this
  // renewal invoice buckets into the identical fiscal year a normal renewal
  // invoice issued in the same period would (no divergence vs the
  // confirm-renewal / invoices path).
  const planYear = deriveFiscalYear(cycle.periodFrom);

  // ---- Step 2: F4 invoice issuance OUTSIDE the F8 tx (F4 owns its own
  // tx for §87 numbering + PDF render). FR-022 — bill the cycle's FROZEN
  // VAT-exclusive price (server-sourced from the just-created cycle row),
  // NEVER a request body, because a renewal §86/4 is a price-tampering
  // surface on a tax document.
  //
  // Rolling-anchor refactor (design 2026-07-08 rev 3 §3, Task 8) — unlike
  // confirm-renewal / mark-paid-offline (which bill the NEXT period after
  // an already-open cycle completes), this fresh comeback cycle IS the
  // period being billed — there is no predecessor open cycle to complete.
  // Its period is already known (`periodFrom` set at Step-1 creation above by
  // the Task-14 comeback anchor — gapless prior.periodTo when still live, else
  // the re-anchored payment-month start), so the §86/4 prints the EXACT window
  // (`periodFrom → periodTo`) instead of the generic "12 months from month of
  // payment" fallback.
  //
  // FIX-1 (PR #173 review, 2026-07-09) — classification-gated (was
  // unconditional). A `first_payment` shape (the zero-history cohort —
  // see the classify call in Step 1 above) OMITS `membershipCoverage`
  // entirely: `createInvoiceDraft` falls back to its own `{ kind:
  // 'from_payment' }` default, matching confirm-renewal's + mark-paid-
  // offline's first-payment branch — the printed window would otherwise
  // describe a period that gets re-anchored away once the member pays.
  // R2-FIX-2 — `omitMembershipCoverage` is now `classification.kind !==
  // 'renewal'` (computed in Step 1), so the GDPR-erased `not_applicable`
  // shape ALSO omits the window, not only `first_payment`.
  const membershipCoverage = omitMembershipCoverage
    ? undefined
    : ({
        kind: 'window' as const,
        fromIso: cycle.periodFrom,
        toIso: cycle.periodTo,
      });
  const invoiceResult = await deps.f4InvoicingBridge.issueInvoiceForRenewal({
    tenantId: input.tenantId,
    memberId: input.memberId,
    planId: cycle.planIdAtCycleStart,
    planYear,
    frozenPlanPriceThb: cycle.frozenPlanPriceThb,
    // FIX-8(c) (PR #173 review, 2026-07-09) — `omitUndefined` replaces the
    // conditional-spread idiom; exactOptionalPropertyTypes still omits the
    // key entirely on the first-payment branch rather than assigning an
    // explicit `undefined`.
    ...omitUndefined({ membershipCoverage }),
    autoEmailOnIssue: true,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    requestId: input.requestId ?? null,
  });
  if (invoiceResult.status !== 'issued') {
    // The fresh cycle is left `awaiting_payment` with no linked invoice —
    // the SAME recoverable state as a member who abandons their pay page.
    // The admin can retry; createCycleInTx is idempotent on retry (the
    // member now has an active cycle, so a retry returns
    // member_has_active_cycle rather than creating a duplicate). Logged so
    // support sees the orphaned-cycle state.
    logger.warn(
      {
        tenantId: input.tenantId,
        memberId: input.memberId,
        cycleId,
        stage: invoiceResult.status,
        errorCode: invoiceResult.errorCode,
        correlationId: input.correlationId,
      },
      '[admin-renew-lapsed-member] §86/4 issuance failed — fresh awaiting_payment cycle left unlinked (recoverable)',
    );
    return mapInvoiceError(invoiceResult);
  }

  // ---- Step 3 (tx2): link invoice + reconcile frozen price + emit audit
  // atomically under the per-cycle advisory lock (mirror confirm-renewal
  // Step-4 — the lock + the adapter's `WHERE (linked_invoice_id IS NULL OR
  // = $1)` guard close the orphan-invoice race).
  return runInTenant(deps.tenant, async (tx) => {
    await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);

    // FIX H1 (Finding #20 follow-up) — Step-1's fresh-cycle creation and
    // Step-2's §86/4 ISSUE run OUTSIDE this advisory lock (tx1 held no lock; it
    // committed before Step-2). A concurrent admin `change-plan` immediate-
    // refreeze can land in that gap and CAS-refreeze this still-open, still-
    // unlinked fresh cycle to a DIFFERENT plan/price (recording
    // applied_to_open_cycle). The §86/4 we issued in Step-2 bills the price the
    // admin billed — the fresh cycle's OWN frozen fields as captured at Step-1
    // creation, an immutable tax document — so we LINK and simultaneously
    // RECONCILE the cycle's frozen fields back to that billed snapshot in one
    // guarded statement (under the re-acquired lock, so no concurrent refreeze
    // can slip between the two). The plan change defers to the next cycle — the
    // member is never rebilled a price they did not confirm. `previous` carries
    // the cycle's pre-link frozen fields so we emit a truthful corrective audit
    // ONLY when a real divergence was healed. This path has no member-plan-change
    // branch of its own — the billed snapshot is simply the cycle's own frozen
    // fields used to price/issue the invoice at Step-2.
    let linkResult: {
      readonly cycle: RenewalCycle;
      readonly previous: RenewalCycle;
    };
    try {
      linkResult = await deps.cyclesRepo.linkInvoiceAndReconcileFrozenPlanInTx(
        tx,
        input.tenantId,
        cycleId,
        invoiceResult.invoiceId,
        {
          planIdAtCycleStart: cycle.planIdAtCycleStart,
          tierAtCycleStart: cycle.tierAtCycleStart,
          frozenPlanPriceThb: cycle.frozenPlanPriceThb,
          frozenPlanTermMonths: cycle.frozenPlanTermMonths,
          frozenPlanCurrency: cycle.frozenPlanCurrency,
        },
      );
    } catch (e) {
      if (e instanceof CycleNotFoundError) {
        logger.error(
          { cycleId, invoiceId: invoiceResult.invoiceId },
          '[admin-renew-lapsed-member] cycle gone between create + linkInvoice — orphan invoice in F4 (void via admin)',
        );
        return err({
          kind: 'server_error',
          message: 'cycle vanished after invoice issued — see runbook',
        });
      }
      if (e instanceof InvoiceLinkConflictError) {
        logger.error(
          {
            cycleId,
            attemptedInvoiceId: e.attemptedInvoiceId,
            existingInvoiceId: e.existingInvoiceId,
          },
          '[admin-renew-lapsed-member] concurrent link won the race — our invoice orphaned in F4 (void via admin)',
        );
        return err({
          kind: 'server_error',
          message:
            'concurrent link won the race — our invoice orphaned, void via F4 admin',
        });
      }
      throw e;
    }

    // FIX H1 — a concurrent change-plan refroze this cycle mid-issue iff any of
    // the pre-link frozen_plan_* fields differ from what the §86/4 billed (the
    // cycle's own frozen fields captured at Step-1 creation). The link above
    // already reconciled the DATA for ALL five frozen fields; here we make the
    // AUDIT trail truthful only when a real reconciliation was healed — a
    // corrective `renewal_cycle_price_frozen` recording the cycle's final frozen
    // fields are the billed ones (superseding the concurrent change-plan's
    // applied_to_open_cycle). Same tx as the link, so an emit failure rolls the
    // reconcile+link back (Principle VIII). Mirrors confirm-renewal Step-4.
    //
    // M1 — widened from a PRICE-only gate to "any of the 5 frozen fields differ"
    // (`frozenPlanSnapshotsDiffer`, satang-normalized price) so a same-price
    // cross-plan swap (which resets plan_id/tier while the price invariant holds)
    // still emits the corrective row for plan-mix / reporting.
    const frozenReconciled = frozenPlanSnapshotsDiffer(linkResult.previous, cycle);
    if (frozenReconciled) {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_cycle_price_frozen' as const,
          payload: {
            cycle_id: cycle.cycleId,
            plan_id: cycle.planIdAtCycleStart,
            frozen_price_thb: cycle.frozenPlanPriceThb,
            frozen_term_months: cycle.frozenPlanTermMonths,
            // Reconciliation forensics (permissive payload; keys mirror the
            // confirm-renewal corrective emit). `reverted_*` records the
            // price/plan the concurrent change-plan had refrozen the cycle to,
            // which this reconcile undid — the plan change defers to the next cycle.
            reconciled_from_concurrent_plan_change: true,
            reverted_frozen_price_thb: linkResult.previous.frozenPlanPriceThb,
            reverted_plan_id: linkResult.previous.planIdAtCycleStart,
            invoice_id: invoiceResult.invoiceId,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: 'admin',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
      logger.warn(
        {
          cycleId,
          invoiceId: invoiceResult.invoiceId,
          billedFrozenPriceThb: cycle.frozenPlanPriceThb,
          revertedFrozenPriceThb: linkResult.previous.frozenPlanPriceThb,
        },
        '[admin-renew-lapsed-member] reconciled fresh cycle frozen price back to the billed §86/4 — a concurrent plan-change refroze this open cycle mid-issue; the plan change defers to the next cycle',
      );
      renewalsMetrics.planChangeDivergenceReconciled(input.tenantId);
    }

    try {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_invoice_created' as const,
          payload: {
            cycle_id: cycle.cycleId,
            member_id: cycle.memberId,
            invoice_id: invoiceResult.invoiceId,
            invoice_number: invoiceResult.invoiceNumber,
            total_satang: invoiceResult.totalSatang.toString(),
            plan_changed: false,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: 'admin',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e), cycleId },
        '[admin-renew-lapsed-member] audit emit failed inside tx — rolling back link',
      );
      throw e;
    }

    return ok({
      cycleId: cycle.cycleId,
      invoiceId: invoiceResult.invoiceId,
      cycleStatus: 'awaiting_payment' as const,
    });
  });
}

function mapInvoiceError(
  result: Exclude<IssueInvoiceForRenewalResult, { status: 'issued' }>,
): Result<never, AdminRenewLapsedMemberError> {
  return err({
    kind: 'invoice_issue_failed',
    stage: result.status === 'create_failed' ? 'create' : 'issue',
    errorCode: result.errorCode,
    detail: result.detail,
  });
}
