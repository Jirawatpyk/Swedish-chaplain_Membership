/**
 * F8 Phase 5 Wave B · T123 — `markCycleCompleteFromInvoicePaid`.
 *
 * F4 `onPaidCallback` target. Fires once F4 transitions an invoice
 * from `issued → paid`. Resolves the linked F8 renewal cycle and
 * transitions it per FR-023 + FR-005b:
 *
 *   - Default: cycle.awaiting_payment → completed
 *     (emits `renewal_completed`)
 *   - Member has `blocked_from_auto_reactivation = TRUE`:
 *     cycle.awaiting_payment → pending_admin_reactivation
 *     (emits `renewal_completed_post_lapse`; cycle holds for admin
 *     review per T136/T137/T138)
 *
 * Atomicity caveat (research.md R12 / Constitution Principle VIII):
 *   F4's `F4InvoicePaidEvent` carries no `tx` handle, so this
 *   callback opens its own `runInTenant` tx that COMMITS SEPARATELY
 *   from F4's invoice-flip tx. There is a brief eventual-consistency
 *   window between "F4 marks invoice paid" and "F8 cycle updated"
 *   visible to concurrent readers. The window is bounded by:
 *     - This use-case's runtime (~5-50ms typical)
 *     - F4's `recordPayment` not throwing back through
 *       `onPaidCallback` rejections (it does — see F4InvoicePaidEvent
 *       docstring lines 14-18; an F8 throw rolls F4's tx back)
 *
 *   So the actual semantics are: F4 commit observes F8 commit ON
 *   SUCCESS (because F8 throw → F4 rollback), and an F8 success
 *   guarantees both rows commit. The "eventual consistency" risk is
 *   only on the FAILURE path (F8 throws → F4 rolls back → F8 already
 *   committed), which we MUST avoid by NEVER throwing from the
 *   callback after F8 has committed. The use-case implements this
 *   discipline: all F8 work runs inside ONE `runInTenant`; if it
 *   commits, no further code can throw.
 *
 *   A future F4 API change to thread `tx` into the callback would
 *   collapse this into a single tx — tracked as an enhancement.
 *
 * Cycle resolution: `cyclesRepo.findByInvoiceIdInTx` returns null when
 * the invoice is not F8-managed (e.g., ad-hoc admin invoice unrelated
 * to a renewal). Use-case logs + returns `'no_cycle_for_invoice'`
 * (NOT an error — F4 has many invoice types).
 *
 * Idempotency: re-firing the callback with the same event must be a
 * no-op. The cycle status check (`awaiting_payment` only) provides
 * this — a second callback finds the cycle in `completed` and short-
 * circuits.
 *
 * Out of scope (deferred to follow-on):
 *   - Cancelling remaining `renewal_reminder_events` rows (FR-023)
 *   - Dispatching the welcome email (FR-023)
 *   - Advancing `members.expires_at` (R3) + creating next cycle
 *
 * These need additional repo methods + gateway access; tracked via
 * tasks.md T123 follow-up sub-bullets.
 */
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { classifyMembershipPayment } from '../../domain/classify-membership-payment';
import { loadClassificationCounts } from './_lib/classification-input';
import {
  asCycleId,
  type RenewalCycle,
} from '../../domain/renewal-cycle';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '../ports/renewal-cycle-repo';
import { resolveUnlinkedMembershipPaymentInTx } from './resolve-unlinked-membership-payment';
import { reanchorFirstPaymentCycleInTx } from './_lib/reanchor-first-payment';

export type MarkCycleCompleteOutcome =
  | { readonly kind: 'no_cycle_for_invoice' }
  | { readonly kind: 'cycle_not_payable'; readonly currentStatus: string }
  | {
      readonly kind: 'completed';
      readonly cycleId: string;
      readonly memberId: string;
    }
  | {
      readonly kind: 'held_pending_admin';
      readonly cycleId: string;
      readonly memberId: string;
    }
  | {
      /**
       * Rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238),
       * Task 6 — the LINKED-path counterpart to the unlinked hook's
       * `'reanchored'` outcome. A first-ever payment on a cycle that
       * confirm-renewal (or a dispatched F8 invoice) already linked to
       * THIS invoice re-anchors instead of completing — see
       * `markCycleCompleteInTx`'s classify-before-guard block below.
       */
      readonly kind: 'reanchored';
      readonly cycleId: string;
      readonly memberId: string;
    };

/**
 * Fold a resolved cycle into the shared classifier's `openCycle` input
 * shape, or `null` when the cycle is not in an "open" status at all
 * (`completed` / `lapsed` / `cancelled` / `pending_admin_reactivation`).
 * `'reminded'` (vestigial, no writer in `src/`) folds to `'upcoming'` —
 * mirrors `resolve-unlinked-membership-payment.ts`'s `toClassifierOpenCycle`,
 * generalised to accept ANY cycle (that helper's input is guaranteed
 * pre-filtered to open statuses by `findOpenCycleForMemberInTx`; this one
 * is called on a cycle resolved by invoice-id, which can be in ANY
 * status — e.g. an idempotent re-fire against an already-`completed`
 * cycle must NOT be treated as open).
 */
function toOpenCycleClassifierInput(
  cycle: RenewalCycle,
): { readonly status: 'upcoming' | 'awaiting_payment'; readonly anchoredAt: string | null } | null {
  if (cycle.status === 'awaiting_payment') {
    return { status: 'awaiting_payment', anchoredAt: cycle.anchoredAt };
  }
  if (cycle.status === 'upcoming' || cycle.status === 'reminded') {
    return { status: 'upcoming', anchoredAt: cycle.anchoredAt };
  }
  return null;
}

export type MarkCycleCompleteDeps = Pick<
  RenewalsDeps,
  | 'tenant'
  | 'cyclesRepo'
  | 'auditEmitter'
  | 'memberRenewalFlagsRepo'
  // Rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238) —
  // widened for the unlinked-payment resolution hook
  // (`resolveUnlinkedMembershipPaymentInTx`) the `!cycle` branch below
  // delegates to. `memberPlanLookup` is required by the hook's
  // `heal_no_cycle` branch (resolves the member's current plan — see that
  // file's docstring) even though the original task brief only named the
  // other three.
  | 'planLookupForRenewal'
  | 'cycleIdFactory'
  // FIX-8(d) (PR #173 review, 2026-07-09) — `'clock'` was Pick'd but never
  // referenced anywhere in this file; dropped (dead dependency).
  | 'memberPlanLookup'
  // FIX-3 (PR #173 review, 2026-07-09) — threaded into BOTH the unlinked
  // hook's `firstPayment` branch and the linked path's own reanchor call
  // below, so the FY-crossing re-freeze check uses the tenant's REAL
  // configured fiscal-year-start-month.
  | 'fiscalYearSettings'
>;

/**
 * Domain failures (no cycle / non-payable status) are non-throws
 * because F4 has paid the invoice — the cycle is just not F8-managed
 * or already settled. F4 must NOT roll back on those, so we return
 * success-with-explanation rather than err.
 *
 * Genuine infra throws (DB connection lost) propagate up to F4's tx
 * which rolls back the invoice flip — atomic-failure invariant.
 *
 * Round 2 review-fix (S-10): the previous return type
 * `Promise<Result<MarkCycleCompleteOutcome, never>>` advertised "this
 * Result branch never happens" which was misleading: the body throws
 * on infra failures (the err channel is in fact never used). Replaced
 * with `Promise<MarkCycleCompleteOutcome>` so the type tells the
 * truth about which mechanism handles which failure mode.
 *
 * Round 2 review-fix (S-11): the function is now split into two
 * variants with one tx-ownership invariant each:
 *   - `markCycleCompleteInTx(deps, event, tx)` — body; requires
 *     caller to provide the tx. Used by the F4 onPaidCallback path
 *     where F4 threads its own tx for atomic single-tx completion.
 *   - `markCycleCompleteFromInvoicePaid(deps, event)` — wrapper that
 *     opens its own `runInTenant` and delegates to the InTx body.
 *     Used by legacy / standalone callers that don't have a tx.
 *
 * I3 review-fix (Phase 5 backlog close): when the F4 onPaidCallback
 * threads its own tx, F8 reuses it via `markCycleCompleteInTx`. This
 * collapses the two-tx eventual-consistency window — F4 commit + F8
 * commit are now ONE atomic operation.
 */
export async function markCycleCompleteInTx(
  deps: MarkCycleCompleteDeps,
  event: F4InvoicePaidEvent,
  tx: TenantTx,
  /**
   * Rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238) —
   * gates whether the `!cycle` branch may delegate to
   * `resolveUnlinkedMembershipPaymentInTx`. Defaults `true`: the atomic
   * in-tx path (F4 threads a real `TenantTx`) always resolves unlinked
   * membership payments. `markCycleCompleteFromInvoicePaid` (the
   * degraded/legacy wrapper — see its own docstring for the three
   * sanctioned uses) forces `false`: a separately-committed re-anchor or
   * renewal-completion followed by an unrelated payment-tx rollback must
   * be impossible, so the wrapper's non-atomic tx NEVER runs the hook.
   * The dispatcher skip-guard + reconciliation cover the resulting miss.
   *
   * F3 (final-review, 2026-07-09) — ALSO gates the LINKED-path
   * classify→re-anchor block below (Task 6). `false` skips the
   * re-anchor branch too, falling through to the pre-existing
   * guard/autoComplete/holdForAdminReview flow with the SAME
   * "non-atomic tx must not commit a consequential mutation"
   * rationale — see that branch's comment for detail.
   */
  allowUnlinkedResolution = true,
): Promise<MarkCycleCompleteOutcome> {
  let cycle = await deps.cyclesRepo.findByInvoiceIdInTx(
    tx,
    event.tenantId,
    event.invoiceId,
  );
  if (!cycle) {
    if (!allowUnlinkedResolution) {
      logger.error(
        {
          invoiceId: event.invoiceId,
          tenantId: event.tenantId,
          memberId: event.memberId,
        },
        '[mark-cycle-complete] degraded mode (non-atomic tx) — refusing unlinked-payment resolution; dispatcher skip-guard + reconciliation cover the miss',
      );
      renewalsMetrics.unlinkedPaymentResolved('skipped');
      return { kind: 'no_cycle_for_invoice' as const };
    }

    const resolution = await resolveUnlinkedMembershipPaymentInTx(
      {
        cyclesRepo: deps.cyclesRepo,
        planLookup: deps.planLookupForRenewal,
        memberPlanLookup: deps.memberPlanLookup,
        auditEmitter: deps.auditEmitter,
        idFactory: deps.cycleIdFactory,
        memberRenewalFlagsRepo: deps.memberRenewalFlagsRepo,
        fiscalYearSettings: deps.fiscalYearSettings,
      },
      event,
      tx,
    );
    // F2 fix (Task 5 review) — logging the raw `resolution` object here
    // would nest a `reason` field (the `skipped` branch's discriminant)
    // one level deep whenever the outcome is `skipped`. `src/lib/logger.ts`
    // blacklists BOTH `reason`/`*.reason` AND `skipped_reason`/
    // `skippedReason` for defence-in-depth against PCI/PII leakage via a
    // gateway-error `reason` field — pino would silently redact it to
    // `[REDACTED]`, losing the forensic signal this log line exists for.
    // Flattened to neutral field names (`resolutionKind` / `resolutionCode`
    // — neither is on the redact list) instead.
    logger.info(
      {
        invoiceId: event.invoiceId,
        tenantId: event.tenantId,
        memberId: event.memberId,
        resolutionKind: resolution.kind,
        ...(resolution.kind === 'skipped'
          ? { resolutionCode: resolution.reason }
          : {}),
      },
      '[mark-cycle-complete] no F8 cycle linked to invoice — resolved via unlinked-payment hook',
    );
    return { kind: 'no_cycle_for_invoice' as const };
  }

  // FR-005b + COMP-1 — read BOTH reactivation guards in ONE round-trip
  // (COMP-1 L3 fold): the admin `blocked_from_auto_reactivation` override AND
  // the GDPR-erased state. Hoisted into this `openCycleInput` block (round 2
  // fix — a prior version hardcoded `memberErased: false` into
  // classification below, "since the erased/blocked gate a few lines down
  // governs every outcome anyway"; that reasoning was WRONG for the
  // `first_payment` shape: an erased member whose only-ever cycle is
  // unanchored would misclassify as `first_payment` and RE-ANCHOR instead
  // of falling through to the hold-for-admin path below — re-anchor is not
  // literally a "reactivation" transition, but it silently revives a
  // GDPR-erased member's renewal timeline, which COMP-1 forbids just as
  // much). Reading the real flag here brings this LINKED path to parity
  // with the UNLINKED hook (`resolveUnlinkedMembershipPaymentInTx`), which
  // has always checked `erased` before classifying. Placed inside this
  // block (not unconditionally at the top of the function) so a cycle
  // that's already terminal/pending-admin (idempotent re-fire) still costs
  // zero reads here, exactly as before — it hits the `awaiting_payment`
  // guard below without ever needing these values. `null` (member
  // RLS-hidden / absent) → both guards treated as false → auto-complete
  // (defensive — preserves the prior null-read behaviour).
  //
  // Rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238),
  // Task 6 (spec §1 consuming-site 2) — classify the payment for the
  // LINKED cycle's member using the SAME shared classifier every
  // settlement site consumes, BEFORE the awaiting_payment guard below. A
  // `first_payment` result (the member's one-and-only cycle, never
  // anchored to a real payment — exactly confirm-renewal's pre-linked-
  // invoice shape) RE-ANCHORS instead of completing: confirm-renewal
  // previously settled such a member at the cycle's provisional
  // registration-date period rather than the actual payment month. An
  // erased member's classification instead resolves to
  // `not_applicable(erased)` (never `first_payment`), so it falls through
  // to the UNCHANGED `awaiting_payment` guard + `holdForAdminReview` flow
  // below — this is the ONLY gate an erased member's payment can reach.
  let blocked = false;
  let isErased = false;
  const openCycleInput = toOpenCycleClassifierInput(cycle);
  if (openCycleInput) {
    const guards = await deps.memberRenewalFlagsRepo.readReactivationGuardsInTx(
      tx,
      event.tenantId,
      cycle.memberId,
    );
    blocked = guards?.blocked === true;
    isErased = guards?.erased === true;

    // FIX-8(a) (PR #173 review, 2026-07-09) — shared loader (was inline
    // duplicated at every settlement site).
    const { cycleCountForMember, settledCycleCountForMember } =
      await loadClassificationCounts(
        deps,
        tx,
        event.tenantId,
        cycle.memberId,
        cycle.cycleId,
      );
    const classification = classifyMembershipPayment({
      cycleCountForMember,
      settledCycleCountForMember,
      openCycle: openCycleInput,
      memberErased: isErased,
    });

    if (classification.kind === 'first_payment') {
      if (!allowUnlinkedResolution) {
        // F3 (final-review, 2026-07-09) — degraded mode (the wrapper's
        // own, SEPARATELY-committed tx — see this function's
        // `allowUnlinkedResolution` param docstring) must NOT commit a
        // re-anchor here either. A re-anchor is a far more consequential
        // mutation than the plain status flip below (period dates move,
        // frozen fields re-freeze, reminder events reset) — the
        // atomic-tx guarantee the linked path normally rides on is
        // exactly what makes it safe to run, and degraded mode has no
        // such guarantee. Fall through to the PRE-EXISTING
        // guard/autoComplete/holdForAdminReview flow below instead —
        // the same legacy behaviour this linked path had before the
        // rolling-anchor refactor (Task 6) introduced the reanchor
        // branch: a first-ever payment settles the cycle at its
        // provisional (pre-anchor) dates rather than re-anchoring to
        // the actual payment month. The dispatcher skip-guard +
        // reconciliation cover the resulting miss — mirrors the sibling
        // `!cycle` degraded-mode refusal a few lines above, including
        // reusing the SAME `unlinkedPaymentResolved('skipped')` metric
        // bucket so both degraded-mode refusals land on one dashboard
        // counter.
        logger.error(
          {
            cycleId: cycle.cycleId,
            invoiceId: event.invoiceId,
            tenantId: event.tenantId,
            memberId: event.memberId,
          },
          '[mark-cycle-complete] degraded mode (non-atomic tx) — refusing linked-path first-payment re-anchor; falling through to legacy complete/hold flow',
        );
        renewalsMetrics.unlinkedPaymentResolved('skipped');
      } else {
        const reanchoredResult = await reanchorFirstPaymentCycleInTx(
          {
            cyclesRepo: deps.cyclesRepo,
            planLookup: deps.planLookupForRenewal,
            auditEmitter: deps.auditEmitter,
            fiscalYearSettings: deps.fiscalYearSettings,
          },
          event,
          tx,
          cycle,
        );
        if (reanchoredResult) {
          return {
            kind: 'reanchored' as const,
            cycleId: reanchoredResult.cycle.cycleId,
            memberId: cycle.memberId,
          };
        }
        // Lost the re-anchor race (a concurrent write moved the cycle
        // out of the un-anchored-open state between our classify read
        // and the guarded UPDATE) — re-read the SAME row by id once and
        // fall through to the EXISTING guard+autoComplete/
        // holdForAdminReview flow below with fresh data. Never loop
        // (design rev 2 §2 race-recovery discipline — mirrors the
        // unlinked hook's `reclassifyAfterRace`, but the linked path's
        // fallback IS its own pre-existing flow, so no separate
        // reclassify function is needed).
        const refreshed = await deps.cyclesRepo.findByIdInTx(
          tx,
          event.tenantId,
          cycle.cycleId,
        );
        if (refreshed) {
          cycle = refreshed;
        }
      }
    }
  }

  if (cycle.status !== 'awaiting_payment') {
    logger.warn(
      {
        cycleId: cycle.cycleId,
        currentStatus: cycle.status,
        invoiceId: event.invoiceId,
      },
      '[mark-cycle-complete] cycle not in awaiting_payment — skip (idempotent re-fire or out-of-band transition)',
    );
    return {
      kind: 'cycle_not_payable' as const,
      currentStatus: cycle.status,
    };
  }

  // `blocked` / `isErased` were already resolved above (one combined read,
  // reused here — see COMP-1 L3 fold comment at the top of this function).
  // An erased member must never AUTO-reactivate: erasure keeps `status` +
  // forces `blocked_from_auto_reactivation = FALSE` (the 0094 CHECK forbids
  // the flag staying TRUE once its provenance is scrubbed), so the block
  // flag alone no longer fences an erased member. Routing a payment that
  // lands against a GDPR-anonymised tombstone to the admin-hold path
  // surfaces it to an admin instead of silently reactivating it.
  const closedAt = event.paidAt;
  if (blocked || isErased) {
    // Hold for admin review — NOT a terminal state. cycle moves to
    // pending_admin_reactivation; T136 / T137 / T138 govern exit.
    return holdForAdminReview(deps, tx, cycle, event, closedAt);
  }

  // Default auto-complete branch.
  return autoComplete(deps, tx, cycle, event, closedAt);
}

/**
 * Standalone wrapper — opens a fresh `runInTenant` and delegates to
 * `markCycleCompleteInTx`. Use when no caller-provided tx is
 * available (legacy paths, standalone admin replays, integration
 * tests). The F4 onPaidCallback path uses `markCycleCompleteInTx`
 * directly to participate in F4's tx for atomic single-tx completion.
 *
 * **R5-S3 / R6-IMP2c usage guidance** (refined): the F4 onPaidCallback
 * path SHOULD use `markCycleCompleteInTx(deps, event, tx)` with the
 * caller-provided F4 tx for atomic single-tx completion. The
 * composition root at
 * `src/modules/renewals/infrastructure/renewals-deps.ts:472-510`
 * already implements this discipline: when F4 threads a `TenantTx`
 * value, the in-tx variant is invoked; otherwise this wrapper is
 * invoked as a **degraded-mode fallback** with the alert metric
 * `onPaidInvalidTx{tenant_id}` paging on-call so the F4 contract
 * drift surfaces.
 *
 * Direct callers OUTSIDE the composition root MUST use
 * `markCycleCompleteInTx` if they have a caller-provided tx.
 * This wrapper is the right choice ONLY for:
 *   - Admin replay tools (no caller tx by definition)
 *   - Integration tests that exercise the wrapper specifically
 *   - The composition-root degraded-mode fallback above
 *
 * The wrapper's separate-tx semantics mean: if F4 has already
 * committed the invoice flip then this wrapper throws, F4's invoice
 * stays 'paid' but F8's cycle stays in 'awaiting_payment'. That
 * state↔audit drift is what the `onPaidInvalidTx` alert exists to
 * detect — a non-zero rate on the counter means the F4 contract is
 * threading something that isn't a `TenantTx`, which the SRE
 * runbook documents as needing F4-side investigation.
 */
export async function markCycleCompleteFromInvoicePaid(
  deps: MarkCycleCompleteDeps,
  event: F4InvoicePaidEvent,
): Promise<MarkCycleCompleteOutcome> {
  // Rolling-anchor refactor — `allowUnlinkedResolution=false`: this
  // wrapper's tx commits SEPARATELY from F4's payment tx, so it must never
  // run the unlinked-payment resolution hook (see `markCycleCompleteInTx`'s
  // parameter docstring).
  return runInTenant(deps.tenant, (tx) =>
    markCycleCompleteInTx(deps, event, tx, false),
  );
}

async function autoComplete(
  deps: MarkCycleCompleteDeps,
  tx: TenantTx,
  cycle: RenewalCycle,
  event: F4InvoicePaidEvent,
  closedAt: string,
): Promise<MarkCycleCompleteOutcome> {
  const cycleId = asCycleId(cycle.cycleId);
  let updated: RenewalCycle;
  try {
    updated = await deps.cyclesRepo.transitionStatus(
      tx,
      event.tenantId,
      cycleId,
      {
        from: 'awaiting_payment',
        to: 'completed',
        closedAt,
        closedReason: 'paid',
        linkedInvoiceId: event.invoiceId,
      },
    );
  } catch (e) {
    if (
      e instanceof CycleTransitionConflictError ||
      e instanceof CycleNotFoundError
    ) {
      // Race against an admin manual transition. Idempotent skip — the
      // cycle is already settled; F4's invoice-paid stands.
      logger.warn(
        { cycleId, err: e.message },
        '[mark-cycle-complete] auto-complete lost race — idempotent skip',
      );
      return {
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      };
    }
    throw e;
  }

  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_completed' as const,
      payload: {
        cycle_id: updated.cycleId,
        member_id: cycle.memberId,
        invoice_id: event.invoiceId,
        paid_at: event.paidAt,
        amount_satang: event.amountSatang.toString(),
        payment_method: event.paymentMethod,
      },
    },
    {
      tenantId: event.tenantId,
      actorUserId: null,
      actorRole: 'system',
      correlationId: `f4-paid:${event.invoiceId}`,
    },
  );

  return {
    kind: 'completed' as const,
    cycleId: cycle.cycleId,
    memberId: cycle.memberId,
  };
}

async function holdForAdminReview(
  deps: MarkCycleCompleteDeps,
  tx: TenantTx,
  cycle: RenewalCycle,
  event: F4InvoicePaidEvent,
  closedAt: string,
): Promise<MarkCycleCompleteOutcome> {
  const cycleId = asCycleId(cycle.cycleId);
  try {
    await deps.cyclesRepo.transitionStatus(
      tx,
      event.tenantId,
      cycleId,
      {
        from: 'awaiting_payment',
        to: 'pending_admin_reactivation',
        enteredPendingAt: closedAt,
        linkedInvoiceId: event.invoiceId,
      },
    );
  } catch (e) {
    if (
      e instanceof CycleTransitionConflictError ||
      e instanceof CycleNotFoundError
    ) {
      logger.warn(
        { cycleId, err: e.message },
        '[mark-cycle-complete] hold-for-admin lost race — idempotent skip',
      );
      return {
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      };
    }
    throw e;
  }

  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_completed_post_lapse' as const,
      payload: {
        cycle_id: cycle.cycleId,
        member_id: cycle.memberId,
        invoice_id: event.invoiceId,
        held_for_admin_review: true,
      },
    },
    {
      tenantId: event.tenantId,
      actorUserId: null,
      actorRole: 'system',
      correlationId: `f4-paid:${event.invoiceId}`,
    },
  );

  return {
    kind: 'held_pending_admin' as const,
    cycleId: cycle.cycleId,
    memberId: cycle.memberId,
  };
}
