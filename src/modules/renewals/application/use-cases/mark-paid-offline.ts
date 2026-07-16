/**
 * F8 Phase 3 Wave H2 · T059 — `mark-paid-offline` use-case.
 *
 * Admin records an out-of-band payment for a renewal cycle. F4 invoice
 * is created, issued, and immediately marked paid in **one outer
 * runInTenant tx** — the F4 `recordPayment` reuses our outer tx via
 * `externalTx` threading + `onPaidCallback` flips the cycle to
 * `completed` inside the same atomic boundary (Constitution Principle
 * VIII / research.md R12 Option A).
 *
 * Concurrency guard:
 *   `pg_advisory_xact_lock(hashtextextended('renewals:'||tenantId||':'||cycleId, 0))`
 *   per (tenant, cycle) — namespace `renewals:` is disjoint from F4
 *   `invoicing:` and F5 `payments:`. Auto-released at tx end. Prevents
 *   double-mark-paid races between two concurrent admin clicks.
 *
 * State precondition: cycle status must be `upcoming` or
 * `awaiting_payment`. (Grace is an urgency-bucket overlay on
 * `awaiting_payment`, not a separate status — see PAYABLE_STATUSES
 * note below.) Other statuses yield `cycle_not_payable`.
 *
 * Rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238),
 * Task 7 (spec §1 consuming-site 3) — BEFORE the F4 chain runs, the
 * locked cycle's payment is classified via the SAME shared
 * `classifyMembershipPayment` every settlement site consumes. A
 * `first_payment` result (the member's one-and-only cycle, never
 * anchored to a real payment) RE-ANCHORS the cycle to the actual
 * payment month instead of completing it — the cycle stays `upcoming`.
 * Every other outcome keeps the original `completed` behaviour
 * byte-identical. See `MarkPaidOfflineOutput`'s `outcome` discriminator.
 *
 * Audit emits inside tx (atomic state+audit):
 *   - `renewal_cycle_completed_offline` (completed branch) OR
 *     `renewal_cycle_reanchored` (re-anchor branch, emitted by the
 *     shared `reanchorFirstPaymentCycleInTx` helper) — never both.
 *   - `renewal_invoice_created` + `renewal_completed` are NOT yet in
 *     pgEnum; the H1 emitter logs to pino via stub fallback in dev,
 *     loud-fails in production. Their pgEnum migration ships in
 *     Phase 4 alongside the dispatcher cron emit sites.
 */
import { z } from 'zod';
import { omitUndefined } from '@/lib/object-helpers';
import { loadClassificationCounts } from './_lib/classification-input';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { addMonthsUtc } from '@/lib/dates';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  parseCycleId,
  isMembershipLapsed,
  type CycleId,
} from '../../domain/renewal-cycle';
import { classifyMembershipPayment } from '../../domain/classify-membership-payment';
import { createNextCycleOnPaidInTx } from './create-next-cycle-on-paid';
import { applyPendingTierUpgradeInTx } from './apply-pending-tier-upgrade';
import { finaliseF2PlanChangeOnPaid } from './finalise-f2-plan-change-on-paid';
import {
  reanchorFirstPaymentCycleInTx,
  type ReanchorFirstPaymentResult,
} from './_lib/reanchor-first-payment';
// `asInvoiceId` is the F4 brand constructor — a TYPE-CHECKED cast (takes a
// `string`, returns the `InvoiceId` brand; no runtime validation). It's used
// for the `applyPendingTierUpgradeInTx` invoiceId arg so that if
// `F4InvoicePaidEvent.invoiceId` is ever tightened away from a plain string
// the call errors at compile time — unlike a bare `as unknown as` cast, which
// silences everything. Same public-barrel import as the sibling
// `admin-reject-reactivation.ts`. The remaining audit-payload
// `invoiceId`/`memberId` stay inline-cast at the emit site (typed payload
// shapes); type-only for the rest keeps cross-module coupling minimal
// (Constitution Principle III).
import { asInvoiceId } from '@/modules/invoicing';
import type {
  F4InvoicePaidEvent,
  InvoiceId,
  EmailDispatchOutcome,
} from '@/modules/invoicing';
import type { MemberId } from '@/modules/members';

export const markPaidOfflineInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  paymentMethod: z.enum(['bank_transfer', 'cash', 'cheque']),
  paymentReference: z.string().min(1).max(100),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actorUserId: z.string().min(1),
  actorRole: z.enum(['admin']),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type MarkPaidOfflineInput = z.infer<typeof markPaidOfflineInputSchema>;

/**
 * Cluster 5 (Finding 1) parity — the payment-time auto-email outcome for the
 * §86/4 renewal receipt, threaded up from the F4 bridge (which reads it off
 * `recordPayment`'s `Invoice & { emailDispatch }`). The route echoes it as
 * `email_dispatch` so the admin toast can warn "receipt not emailed" when a
 * bare imported member has no contact email on file — the SAME silent-skip
 * gap G10 closed on the three invoice paths. Present on BOTH outcome variants
 * because the receipt is issued regardless of whether the cycle completes or
 * re-anchors.
 */
export type MarkPaidOfflineOutput =
  | {
      readonly outcome: 'completed';
      readonly cycleStatus: 'completed';
      readonly invoiceId: string;
      readonly newExpiresAt: string;
      readonly emailDispatch: EmailDispatchOutcome;
    }
  | {
      readonly outcome: 'reanchored';
      readonly cycleStatus: 'upcoming';
      readonly invoiceId: string;
      readonly newExpiresAt: string;
      /**
       * Task 7 (RRA task 7 fix) — the true period start (first of month)
       * after re-anchor, for the admin toast to display the correct
       * renewal period boundary.
       */
      readonly newPeriodFrom: string;
      readonly emailDispatch: EmailDispatchOutcome;
    };

/**
 * Cluster 5 (Finding 2) — F4 bridge rejects that will NEVER succeed on retry
 * (the underlying member/plan/settings data must be fixed first). These are a
 * CLOSED set of known enum discriminators — unlike the free-text
 * `f4_failure.reason` (which the route scrubs from the HTTP body), each of
 * these is safe to echo to the client as a distinct, operator-actionable code.
 */
export type MarkPaidOfflinePermanentReason =
  | 'plan_not_found'
  | 'settings_missing'
  | 'member_archived'
  | 'member_not_found';

export type MarkPaidOfflineError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'cycle_not_found' }
  | { readonly kind: 'cycle_not_payable'; readonly currentStatus: string }
  /**
   * 066 review polish #1 — the MEMBER is terminated (their LATEST cycle
   * resolves to `terminated` under `deriveMembershipAccess`) even though the
   * cycle being marked is in a payable status. Mirrors the F4 record-payment
   * §4.4(1) gate: refuse the offline settlement + direct the admin to the
   * reactivation flow, so no §86/4 receipt is minted to a non-member. Distinct
   * from `cycle_not_payable` (that cycle IS payable; the member is not).
   */
  | { readonly kind: 'member_terminated' }
  /**
   * Cluster 5 (Finding 2) — a PERMANENT F4 reject (retry will not help). Kept
   * distinct from `f4_failure` (transient/infra faults → "please try again")
   * so the route can surface actionable copy: "add the plan-year", "restore the
   * member", "configure invoice settings first".
   */
  | {
      readonly kind: 'f4_permanent_failure';
      readonly reason: MarkPaidOfflinePermanentReason;
    }
  | { readonly kind: 'f4_failure'; readonly stage: string; readonly reason: string }
  // K1-C7: explicit server_error variant — Application throws are
  // forbidden by Principle III. Surface as Result so the route handler
  // type-checks the case rather than relying on the outer try/catch.
  | { readonly kind: 'server_error'; readonly message: string }
  /**
   * F4 step 3 (recordPayment) failed AFTER an invoice was issued with
   * a consumed §87 sequence number. The orphan invoice exists in F4 in
   * 'issued' state. Admin MUST resume from the F4 invoice list and mark
   * paid there — DO NOT retry mark-paid-offline (it will issue a
   * duplicate §87 invoice).
   */
  | {
      readonly kind: 'f4_orphan_invoice';
      readonly orphanInvoiceId: string;
      readonly reason: string;
    };

/**
 * Cluster 5 (Finding 2) — the F4 bridge `reason` codes that are PERMANENT
 * (retry never helps). Sourced from `CreateInvoiceDraftError` + `IssueInvoiceError`
 * (the two pre-payment bridge steps): `plan_not_found` / `member_not_found` /
 * `member_archived` / `settings_missing`. Any other reason (PDF/blob faults,
 * overflow, races) stays transient → the generic "please try again".
 */
const PERMANENT_F4_REASONS: ReadonlySet<string> = new Set([
  'plan_not_found',
  'settings_missing',
  'member_archived',
  'member_not_found',
]);

function isPermanentF4Reason(
  reason: string,
): reason is MarkPaidOfflinePermanentReason {
  return PERMANENT_F4_REASONS.has(reason);
}

// Cycles in these statuses can be marked paid offline. Lapsed cycles
// require the explicit reactivation flow (US3+); cancelled and completed
// cycles are terminal. `pending_admin_reactivation` is in the admin's
// review queue — not the offline-mark path.
//
// Note: there is no separate `grace` status in the 7-state machine —
// grace is an URGENCY bucket (post-expiry, pre-lapse) that overlays
// `awaiting_payment` cycles whose expires_at is in the past but within
// the tenant's grace_period_days. Admins marking those paid use the
// same `awaiting_payment` codepath; the urgency derivation is read-only.
const PAYABLE_STATUSES = new Set(['awaiting_payment', 'upcoming']);

export async function markPaidOffline(
  deps: RenewalsDeps,
  rawInput: MarkPaidOfflineInput,
): Promise<Result<MarkPaidOfflineOutput, MarkPaidOfflineError>> {
  const parsed = markPaidOfflineInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const cycleIdResult = parseCycleId(input.cycleId);
  if (!cycleIdResult.ok) {
    return err({ kind: 'invalid_input', message: 'invalid cycle id' });
  }
  const cycleId: CycleId = cycleIdResult.value;

  // Pre-load cycle to surface clean errors before opening the F4 chain.
  const preLoad = await deps.cyclesRepo.findById(input.tenantId, cycleId);
  if (!preLoad) {
    // Probe audit defence-in-depth — never block the 404 (see EH4).
    try {
      await deps.auditEmitter.emit(
        {
          type: 'renewal_cross_tenant_probe',
          payload: {
            attempted_cycle_id: cycleId,
            route: 'mark-paid-offline',
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          cycleId,
          correlationId: input.correlationId,
        },
        'markPaidOffline: probe audit emit failed (swallowed — never blocks 404)',
      );
    }
    return err({ kind: 'cycle_not_found' });
  }
  if (!PAYABLE_STATUSES.has(preLoad.status)) {
    return err({
      kind: 'cycle_not_payable',
      currentStatus: preLoad.status,
    });
  }

  // 066 review polish #1 — defense-in-depth terminated gate for the F8 offline
  // rail (the F4 record-payment gate at §4.4(1) does NOT cover this rail: it
  // creates the invoice inside this use-case's externalTx, invisible to that
  // gate's non-tx findById). Refuse the offline-mark when the MEMBER is
  // terminated even though the cycle being marked is payable: a member whose
  // LATEST cycle is `lapsed` (deriveMembershipAccess → 'terminated') could
  // still own an OLDER upcoming/awaiting cycle (a coexisting lapsed+upcoming
  // data anomaly), and marking that older cycle paid would mint a §86/4 receipt
  // to a non-member. Mirror the F4 gate's verdict: block → reactivate first.
  //
  // Non-tx read (membership state is immutable across the click, same rationale
  // as the F4 gate). The COMMON case — the cycle being marked IS the member's
  // latest and is in a payable status — derives `full`/`suspended`, never
  // `terminated`, so a normal renewal is never blocked. `input.paymentDate`
  // (the settlement instant) is the evaluation clock; a `lapsed` latest cycle
  // resolves terminated regardless of it.
  const latestCycle = await deps.cyclesRepo.findLatestCycleForMember(
    input.tenantId,
    preLoad.memberId,
  );
  if (latestCycle && isMembershipLapsed(latestCycle, new Date(input.paymentDate))) {
    logger.warn(
      {
        cycleId,
        memberId: preLoad.memberId,
        tenantId: input.tenantId,
        latestCycleId: latestCycle.cycleId,
        latestStatus: latestCycle.status,
      },
      'markPaidOffline: member is terminated (latest cycle lapsed) — refusing offline-mark; reactivate first',
    );
    return err({ kind: 'member_terminated' });
  }

  // FR-022 frozen-price invariant (068 cluster A): the offline §86/4 bills
  // the cycle's FROZEN price (`lockedCycle.frozen_plan_price_thb`), NOT the
  // live F2 catalogue fee. The frozen price is threaded into the F4 chain as
  // the `renewalSignal` ~145 lines below (see the `frozenPlanPriceThb` arg on
  // `issueAndMarkPaid`), which overrides the membership-line price + suppresses
  // the reg-fee re-bill — mirroring the online confirm-renewal path. This
  // protects a member from a mid-cycle catalogue price bump and keeps the tax
  // document off the price-tampering surface. The cycle-vs-invoice price
  // assertion lives in the offline mark-paid integration test.
  //
  // Round 5 S-04 / 070 code-review — Bangkok-local fiscal year via the
  // SHARED `deriveFiscalYear` (js-joda Asia/Bangkok, honours the tenant's
  // fiscal-year start-month) — the identical helper confirm-renewal,
  // admin-renew and the §87 sequential-number allocator use. UTC
  // `getUTCFullYear()` is wrong at BKK boundaries; the prior local +7h
  // helper also hardcoded a January start, so it would diverge from every
  // other billing path for a non-January-start tenant. One source of truth
  // for the §86/4 fiscal year across the online + offline rails.
  const planYear = deriveFiscalYear(preLoad.periodFrom);
  const planId = preLoad.planIdAtCycleStart;
  const memberId = preLoad.memberId;

  // 070 Item D — hoisted to the use-case scope so the POST-commit F2
  // scheduled-plan-change finalise can read the F4 paid event after the
  // outer `runInTenant` tx commits. Set inside the in-tx `onPaid` closure
  // below; remains null on any path that never reaches the cycle flip.
  let paidEventForFinalise: F4InvoicePaidEvent | null = null;

  // Outer atomic boundary — F4 chain step 3 (recordPayment) reuses
  // this tx; cycle flip + audit emit ride along.
  try {
    const result = await runInTenant(deps.tenant, async (tx) => {
      // Per-(tenant, cycle) advisory lock — race-protects two admins.
      // Lock acquisition delegated to Infrastructure (Constitution
      // Principle III — Application has no SQL/ORM dependency).
      await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);

      // Re-load inside lock to defeat TOCTOU. Round 5 B2 fix: use
      // findByIdInTx with the lock-holding tx so the re-read sees the
      // same snapshot as the lock — `findById` would open a separate
      // tx and could observe stale state.
      const lockedCycle = await deps.cyclesRepo.findByIdInTx(
        tx,
        input.tenantId,
        cycleId,
      );
      if (!lockedCycle) {
        return err({ kind: 'cycle_not_found' as const });
      }
      if (!PAYABLE_STATUSES.has(lockedCycle.status)) {
        return err({
          kind: 'cycle_not_payable' as const,
          currentStatus: lockedCycle.status,
        });
      }

      // Rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238),
      // Task 7 (spec §1 consuming-site 3) — classify the payment for the
      // LOCKED cycle's member using the SAME shared classifier every
      // settlement site consumes. `openCycle` is built directly from
      // `lockedCycle` itself (never null — its status was just verified
      // against PAYABLE_STATUSES, a subset of the classifier's open-cycle
      // status union), so `cycleCountForMember` + the GDPR-erased guard are
      // the only additional reads needed. Both reads + the branch decision
      // happen INSIDE the tx that holds the per-(tenant,cycle) advisory
      // lock acquired above, so no concurrent write sharing this codebase's
      // lock convention can race the classification.
      //
      // A `first_payment` result re-anchors the cycle inside `onPaid`
      // below instead of completing it (see `isFirstPayment`); every other
      // result (`renewal`, or the erased/terminal `not_applicable`
      // classifications, neither reachable here in a way that changes
      // behaviour) falls through to the pre-existing `completed` path —
      // this classify call exists ONLY to detect the first-payment shape,
      // matching `markCycleCompleteInTx`'s linked-path rationale (Task 6).
      // FIX-8(a) (PR #173 review, 2026-07-09) — shared loader (was inline
      // duplicated at every settlement site).
      const { cycleCountForMember, settledCycleCountForMember } =
        await loadClassificationCounts(
          deps,
          tx,
          input.tenantId,
          lockedCycle.memberId,
          lockedCycle.cycleId,
        );
      const reactivationGuards =
        await deps.memberRenewalFlagsRepo.readReactivationGuardsInTx(
          tx,
          input.tenantId,
          lockedCycle.memberId,
        );
      const classification = classifyMembershipPayment({
        cycleCountForMember,
        settledCycleCountForMember,
        openCycle:
          lockedCycle.status === 'awaiting_payment'
            ? { status: 'awaiting_payment', anchoredAt: lockedCycle.anchoredAt }
            : { status: 'upcoming', anchoredAt: lockedCycle.anchoredAt },
        memberErased: reactivationGuards?.erased === true,
      });
      const isFirstPayment = classification.kind === 'first_payment';
      let reanchorResult: ReanchorFirstPaymentResult | null = null;

      // Round 5 W-05 — re-derive `newExpiresAt` from the LOCKED cycle's
      // periodTo, not the pre-lock snapshot. If a concurrent path
      // mutated period anchors between preLoad and lock acquisition,
      // the response + audit would otherwise carry a stale value.
      // 068 cluster G — shared `addMonthsUtc` (was the byte-identical local
      // `deriveNewExpiresAt`). Same UTC arithmetic; Asia/Bangkok is UTC+7 with
      // no DST so the next expires_at lands on the same Bangkok calendar date.
      const newExpiresAt = addMonthsUtc(
        lockedCycle.periodTo,
        lockedCycle.frozenPlanTermMonths,
      );

      // Rolling-anchor refactor (design 2026-07-08 rev 3 §3, Task 8) — a
      // RENEWAL-classified payment already knows the exact NEXT-period
      // window (the locked cycle's `periodTo → periodTo +
      // frozenPlanTermMonths`, i.e. `newExpiresAt` above) — thread it into
      // the F4 bridge so the §86/4 prints exact dates instead of the
      // generic "12 months from payment" wording. A first-payment
      // classification omits it entirely — `createInvoiceDraft` defaults
      // to `{ kind: 'from_payment' }` because the re-anchored period
      // doesn't exist yet at invoice-creation time (the re-anchor itself
      // only happens inside `onPaid` below, AFTER the bridge call).
      const membershipCoverage = isFirstPayment
        ? undefined
        : ({
            kind: 'window' as const,
            fromIso: lockedCycle.periodTo,
            toIso: newExpiresAt,
          });

      // F4 chain — bridge composes createInvoiceDraft + issueInvoice +
      // recordPayment(externalTx=tx). The `onPaid` callback fires inside
      // F4's recordPayment tx (which IS our outer tx via externalTx),
      // flipping the cycle atomically.
      let onPaidFired = false;
      const onPaid = async (evt: F4InvoicePaidEvent): Promise<void> => {
        onPaidFired = true;
        // 070 Item D — capture the paid event so the POST-commit F2
        // scheduled-plan-change finalise (mirroring the online callback[1]
        // post-tx half) can run after the outer tx commits. The F2 row flip
        // MUST happen outside the tx (its repo opens its own runInTenant) so
        // a finalise failure cannot roll back the now-durable payment.
        paidEventForFinalise = evt;

        if (isFirstPayment) {
          // Task 7 (spec §1 consuming-site 3) — the member's one-and-only
          // cycle has never been anchored to a real payment; THIS offline
          // settlement IS that first payment. Re-anchor (shared Task 6
          // core) moves the period dates to the actual payment month +
          // re-freezes frozen fields across a fiscal-year boundary, and
          // leaves `status='upcoming'` — it never flips to `completed`, so
          // NO `renewal_cycle_completed_offline` audit fires on this
          // branch. `reanchorFirstPaymentCycleInTx` emits
          // `renewal_cycle_reanchored` itself (no duplicate emit here).
          const reanchored = await reanchorFirstPaymentCycleInTx(
            {
              cyclesRepo: deps.cyclesRepo,
              planLookup: deps.planLookupForRenewal,
              auditEmitter: deps.auditEmitter,
              fiscalYearSettings: deps.fiscalYearSettings,
            },
            evt,
            tx,
            lockedCycle,
          );
          if (!reanchored) {
            // Should be unreachable: this closure runs inside the SAME tx
            // that has held the per-(tenant,cycle) advisory lock since
            // before the classify read above, for the cycle's ENTIRE
            // duration — every other cycle-mutating code path in this
            // codebase takes the same lock before writing, so no
            // concurrent writer can move this row out of the
            // un-anchored-open state between the classify read and this
            // guarded UPDATE. Throw loudly (rather than silently falling
            // back to `completed`, which would mis-record a first payment
            // as a renewal) so the outer runInTenant rolls back and the
            // anomaly surfaces as a contract-regression alarm, not a
            // silently wrong audit trail.
            throw new Error(
              `mark-paid-offline: first-payment re-anchor guard matched 0 rows for cycle ${cycleId} — unexpected race under held advisory lock`,
            );
          }
          reanchorResult = reanchored;
        } else {
          // Flip cycle inside same tx — closedReason='completed_offline'.
          await deps.cyclesRepo.transitionStatus(
            tx,
            input.tenantId,
            cycleId,
            {
              from: lockedCycle.status,
              to: 'completed',
              closedAt: evt.paidAt,
              closedReason: 'completed_offline',
              linkedInvoiceId: evt.invoiceId,
            },
          );
          await deps.auditEmitter.emitInTx(
            tx,
            {
              type: 'renewal_cycle_completed_offline',
              payload: {
                cycle_id: cycleId,
                member_id: memberId as MemberId,
                invoice_id: evt.invoiceId as InvoiceId,
                payment_method: input.paymentMethod,
                payment_reference: input.paymentReference,
                payment_date: input.paymentDate,
                new_expires_at: newExpiresAt,
              },
            },
            {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              actorRole: input.actorRole,
              correlationId: input.correlationId,
              requestId: input.requestId ?? null,
              summary: `Admin marked cycle ${cycleId} paid offline (${input.paymentMethod} ref=${input.paymentReference})`,
            },
          );
        }

        // 070 Item D — apply any pending tier-upgrade on the OFFLINE path,
        // mirroring the online `f8OnPaidCallbacks[1]` IN-TX half (same
        // ordering + throw-on-failure rollback discipline; the actor +
        // post-commit retry semantics differ — see below).
        // The online chain orders [0] complete → [1] apply-tier-upgrade →
        // [2] create-next-cycle; this call sits between the completion flip
        // above and `createNextCycleOnPaidInTx` below so the offline path
        // matches that ordering. A member who had an `accepted_pending_apply`
        // tier-upgrade now has the F8 suggestion transitioned → `applied`
        // (+ `tier_upgrade_applied_at_renewal` audit) atomically with the
        // offline-mark tx — previously it was left pending forever (the
        // 070 Item-D gap).
        //
        // ACTOR: this path is admin-driven (the admin records the offline
        // settlement + already emits the `renewal_cycle_completed_offline`
        // audit as themselves above), so the apply audit carries the ADMIN
        // actor — NOT `'webhook'` (the online default). `RenewalActorRole`
        // already includes `'admin'`, so no enum change is needed.
        //
        // THROWS on failure (same in-tx discipline as the online path's
        // threaded callback[1]): a throw rolls the whole offline-mark tx
        // back; the admin's "mark paid" returns an error + retries. The
        // CAS guard inside `applyPendingTierUpgradeInTx` makes retry safe
        // (idempotent on already-applied). NEVER swallowed: a swallow would
        // complete the payment while the tier-upgrade silently strands.
        await applyPendingTierUpgradeInTx(deps, tx, {
          tenantId: input.tenantId,
          cycleId,
          invoiceId: asInvoiceId(evt.invoiceId),
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
          actor: { actorUserId: input.actorUserId, actorRole: input.actorRole },
        });

        // 068-f8-completion (slice 1) — renewal-loop closer on the OFFLINE
        // path. The online/record-payment paths run the full
        // `f8OnPaidCallbacks` array whose callback[2] creates the next
        // cycle; the offline path builds this single `onPaid` instead (the
        // bridge wraps it as `[onPaid]`), so callback[2] never fires here.
        // Without this call the cycle completes but the member silently
        // drops out of the renewal pipeline — broken renewal loop for the
        // bank-transfer-dominant SweCham/TSCC tenant.
        //
        // SAME-TX ordering: this runs AFTER the branch above either (a)
        // marked the prior cycle →completed in THIS tx, or (b) re-anchored
        // the member's first-ever cycle (Task 7). On (a),
        // `createCycleInTx`'s in-tx idempotency guard
        // (`findActiveForMemberInTx`) sees the uncommitted completion and
        // EXCLUDES the prior cycle, so the next cycle IS created on the
        // first mark (identical correctness contract to the online
        // callback[2]). On (b), `createNextCycleOnPaidInTx`'s own
        // `findByInvoiceIdInTx(evt.invoiceId)` lookup finds NO cycle — the
        // re-anchor stamped `anchor_invoice_id`, not `linked_invoice_id`,
        // and explicitly cleared `linked_invoice_id` in the same guarded
        // UPDATE — so this call is a documented no-op (asserted by a
        // dedicated integration test); the member's re-anchored cycle
        // stays the sole active cycle. `tx` is the outer `runInTenant` tx
        // the F4 bridge reuses via `externalTx` — the same tx either
        // branch above rode.
        //
        // THROWS on failure (consistent with the online path + this path's
        // in-tx discipline): a throw rolls the whole offline-mark tx back,
        // the admin's "mark paid" returns an error, and they retry — the
        // `findActiveForMemberInTx` guard + `renewal_cycles_active_member_uniq`
        // partial index make retry safe (no duplicate next cycle). NEVER
        // swallowed: a swallow would complete the payment while the member
        // drops out of the pipeline with no retry trigger.
        await createNextCycleOnPaidInTx(
          {
            cyclesRepo: deps.cyclesRepo,
            planLookup: deps.planLookupForRenewal,
            auditEmitter: deps.auditEmitter,
            idFactory: deps.cycleIdFactory,
          },
          evt,
          tx,
        );
      };

      const bridgeResult = await deps.f4InvoiceBridge.issueAndMarkPaid({
        tenantId: input.tenantId,
        memberId,
        planId,
        planYear,
        // FR-022 — bill the cycle's FROZEN price on the offline §86/4, NOT
        // the live F2 catalogue price (which may have been bumped since the
        // cycle was created). Server-sourced from the LOCKED cycle row (the
        // same snapshot the period anchors + completion flip ride), never a
        // request body — a renewal §86/4 is a price-tampering surface on a
        // tax document. The bridge converts to VAT-exclusive satang +
        // suppresses the reg-fee re-bill. Mirrors the online confirm-renewal
        // path. (cluster A, 068 code-review fix.)
        frozenPlanPriceThb: lockedCycle.frozenPlanPriceThb,
        // FIX-8(c) (PR #173 review, 2026-07-09) — `omitUndefined` replaces
        // the conditional-spread idiom; exactOptionalPropertyTypes still
        // omits the key entirely on the first-payment branch rather than
        // assigning an explicit `undefined`.
        ...omitUndefined({ membershipCoverage }),
        paymentMethod: input.paymentMethod,
        paymentReference: input.paymentReference,
        paymentDate: input.paymentDate,
        actorUserId: input.actorUserId,
        externalTx: tx,
        onPaid,
        requestId: input.requestId ?? null,
      });

      if (!bridgeResult.ok) {
        // Distinct error code on the orphan-invoice path so the route
        // handler can surface "DO NOT retry — resume from F4 list".
        if (bridgeResult.error.kind === 'record_payment_failed') {
          return err({
            kind: 'f4_orphan_invoice' as const,
            orphanInvoiceId: bridgeResult.error.orphanInvoiceId,
            reason: bridgeResult.error.reason,
          });
        }
        // Cluster 5 (Finding 2) — the failure is at step 1 (create draft) or
        // step 2 (issue), BEFORE any §87 number was burned, so there is no
        // orphan. Branch on the underlying F4 code (`reason`): a known PERMANENT
        // reject gets a distinct, actionable route code; everything else stays
        // the transient `f4_failure` ("please try again"). Retrying a
        // permanent reject (plan-year not in the catalogue, member archived,
        // settings unconfigured, member missing) will NEVER succeed until the
        // data is fixed — telling the admin to retry sends them in circles.
        if (isPermanentF4Reason(bridgeResult.error.reason)) {
          return err({
            kind: 'f4_permanent_failure' as const,
            reason: bridgeResult.error.reason,
          });
        }
        return err({
          kind: 'f4_failure' as const,
          stage: bridgeResult.error.kind,
          reason: bridgeResult.error.reason,
        });
      }

      // Cross-module invariant guard: the F4 bridge MUST fire onPaid
      // inside recordPayment's tx (which IS our outer tx). If a future
      // F4 refactor decouples bridge.ok from onPaid invocation (e.g.
      // a "skip if already paid" optimisation), the cycle would NOT be
      // flipped while the response says completed — silent member-
      // state desync. Throw so the outer runInTenant rolls back +
      // surfaces the inconsistency loudly with cycle context.
      if (!onPaidFired) {
        throw new Error(
          `mark-paid-offline: F4 bridge returned ok but onPaid never fired — ` +
            `cycle ${cycleId} not flipped. F4 contract regression?`,
        );
      }
      if (isFirstPayment) {
        // Invariant: `onPaid` (which just ran, since `onPaidFired` is
        // true) throws BEFORE returning on the first-payment branch if
        // the guarded re-anchor UPDATE matched 0 rows (see the throw a
        // few lines inside `onPaid` above) — so reaching here with
        // `isFirstPayment` true guarantees `reanchorResult` is set. The
        // non-null assertion documents that invariant instead of adding
        // an unreachable defensive branch.
        const reanchored = reanchorResult!;
        return ok({
          outcome: 'reanchored' as const,
          cycleStatus: 'upcoming' as const,
          invoiceId: bridgeResult.value.invoiceId,
          // Task 7 — the re-anchored cycle's OWN periodTo, not the
          // pre-branch `newExpiresAt` local (which was derived from the
          // now-superseded pre-anchor period). Never recompute by hand.
          newExpiresAt: reanchored.cycle.periodTo,
          // RRA task 7 fix — true period start (first of month) after re-anchor.
          newPeriodFrom: reanchored.cycle.periodFrom,
          // Cluster 5 (Finding 1) parity — surface the receipt auto-email skip.
          emailDispatch: bridgeResult.value.emailDispatch,
        });
      }
      return ok({
        outcome: 'completed' as const,
        cycleStatus: 'completed' as const,
        invoiceId: bridgeResult.value.invoiceId,
        newExpiresAt,
        // Cluster 5 (Finding 1) parity — surface the receipt auto-email skip.
        emailDispatch: bridgeResult.value.emailDispatch,
      });
    });

    // 070 Item D — POST-commit F2 scheduled-plan-change finalise. Mirrors
    // the online callback[1] post-tx half: the F2 row flip pending →
    // applied (+ `plan_change_applied` audit) MUST run OUTSIDE the state
    // tx (the F2 repo opens its OWN `runInTenant`), so it can only run
    // after the outer tx has committed. It is best-effort + non-rollback:
    // the payment + cycle flip + in-tx suggestion apply are already durable;
    // a finalise failure is logged + swallowed (the F2 row stays `pending`,
    // never re-bills). Only runs on the success path where `onPaid` actually
    // fired (so a real paid event was captured).
    //
    // RETRY-HEAL DIFFERS FROM THE ONLINE PATH: the online callback self-
    // heals because the Stripe webhook is at-least-once — a redelivery re-
    // fires the whole onPaid chain incl. this finalise. The OFFLINE rail has
    // NO such trigger: mark-paid is a one-shot synchronous admin click, the
    // cycle is now `completed` (a re-click returns `cycle_not_payable`), and
    // no reconcile cron sweeps `scheduled_plan_changes`. A stranded offline
    // F2 row needs MANUAL operator replay (grep errorId
    // `F2.PLAN_CHANGE.OFFLINE_FINALISE_THREW`).
    //
    // ACTOR: the admin (offline settlement) — the F2 `plan_change_applied`
    // audit carries the admin's user id, matching the in-tx F8 apply audit
    // above + the post-tx F2 emit pattern in `accept-tier-upgrade.ts`.
    if (result.ok && paidEventForFinalise !== null) {
      // Defensive own try/catch: the payment + cycle flip are already
      // committed, so a finalise throw must NEVER downgrade the use-case
      // to `server_error` (the outer catch would do exactly that — see the
      // post-commit-listener pitfall). The helper is internally swallow-
      // only; this is belt-and-braces against a future regression.
      try {
        await finaliseF2PlanChangeOnPaid(deps, paidEventForFinalise, cycleId, {
          actorUserId: input.actorUserId,
          requestId: input.requestId ?? `mark-paid-offline:${cycleId}`,
        });
      } catch (finaliseErr) {
        logger.error(
          {
            err:
              finaliseErr instanceof Error
                ? finaliseErr
                : new Error(String(finaliseErr)),
            cycleId,
            tenantId: input.tenantId,
            invoiceId: result.value.invoiceId,
            memberId,
            errorId: 'F2.PLAN_CHANGE.OFFLINE_FINALISE_THREW',
          },
          'markPaidOffline: post-commit F2 finalise threw — payment already committed; F2 row left pending — MANUAL replay required (no offline retry path)',
        );
      }
    }

    return result;
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        cycleId,
        tenantId: input.tenantId,
      },
      'markPaidOffline: unexpected error',
    );
    // R4-W2 (staff-review-2026-05-09): never surface raw exception
    // messages — they may carry DB column names, query fragments, or
    // connection strings. Forensic detail stays in the logger.error
    // call above only.
    return err({
      kind: 'server_error',
      message: 'internal error — see server logs',
    });
  }
}
