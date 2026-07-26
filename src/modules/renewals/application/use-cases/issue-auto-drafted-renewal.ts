/**
 * 107-auto-invoice Task 9 — `issueAutoDraftedRenewal`.
 *
 * The review-queue "Issue" action, and the most tax-sensitive path in this
 * feature: it promotes a cron-created `origin='auto_renewal'` DRAFT into a
 * real, numbered membership bill (§86/4-era document). Everything below
 * exists to guarantee ONE bill per (member, fiscal year).
 *
 * ## Topology — 3 transactions, mirroring `confirm-renewal.ts`
 *
 * The F4 bridge opens and commits its OWN transaction, so the per-cycle
 * advisory lock (`pg_advisory_xact_lock`, transaction-scoped) must NEVER be
 * held across it — same constraint `confirm-renewal.ts:179-550` and
 * `auto-draft-due-renewals.ts:330-566` were built around.
 *
 *   tx1  lock → re-read → shape checks → DISCARD sibling auto-drafts
 *                       → content guard → close (lock released)
 *   issue  `issueExistingDraftForRenewal`, standalone, no F8 tx/lock held
 *   tx2  fresh lock → flip cycle to `awaiting_payment` + stamp the link
 *
 * ### Why the discard runs INSIDE tx1, before the issue (review Critical 1)
 *
 * An earlier revision ran the discard AFTER the issue, in its own transaction,
 * and narrowed the content guard so a sibling `auto_renewal` draft did not
 * block. That reopened a duplicate-numbered-bill window, and it needed no
 * concurrent `confirmRenewal` at all — two queue rows were enough:
 *
 *   D1, D2 = sibling auto-drafts, same (member, planYear)
 *   t0  Issue(D1) tx1: sees D2 as draft → not blocking → COMMIT, lock released
 *   t1  Issue(D2) tx1: sees D1 still draft (not yet issued) → COMMIT
 *   t2  Issue(D1) mints SC-0001    t3  Issue(D2) mints SC-0002   ← TWO §86/4
 *
 * The number is minted OUTSIDE the lock, so a sibling draft is not merely an
 * inert row — it is the outstanding CLAIM on a number about to be minted, and
 * it is the only such claim tx1 can observe. It must therefore stay in the
 * blocking set, and the draft must be REMOVED before the guard rather than
 * after the issue. Task 14 ships bulk-issue-over-selected, so this is a
 * routine path, not an exotic race.
 *
 * With the discard inside tx1 under the lock, the second issuer's tx1 finds
 * its own draft already deleted and returns `draft_not_found` — the correct
 * answer. In the pathological interleaving where two drafts sit on DIFFERENT
 * cycles (so different locks) and each transaction deletes the other's draft,
 * both issues fail with no number minted — still no duplicate.
 *
 * The discard MUST therefore share tx1's transaction handle (`tx`), never open
 * its own `runInTenant`: doing that while holding a transaction-scoped
 * advisory lock would pin a second pooled connection for tx1's whole lifetime.
 * The bridge's `discardAutoDraftForRenewal` accepts `tx` for exactly this.
 *
 * (The earlier revision justified keeping the discard outside the lock as
 * deadlock avoidance. That rationale was wrong: concurrent issues for
 * DIFFERENT members touch disjoint rows, and the SAME member means the same
 * cycle and therefore the same lock — already serialised.)
 *
 * ## Guard 1 (HARD REQ #1) — shape check before issuing
 *
 * `f4InvoicingBridge.issueExistingDraftForRenewal` issues ANY invoice id it
 * is given; it has no origin, status, or ownership check. A wrong or stale id
 * reaching it would silently mint a number on an unrelated manual draft. So
 * tx1 verifies, under the lock:
 *
 *   - the invoice exists and is a MEMBERSHIP invoice   → else `draft_not_found`
 *   - `origin = 'auto_renewal'`                        → else `invalid_draft`
 *   - `status = 'draft'`                               → else `invalid_draft`
 *   - a cycle is stamped with it                       → else `cycle_not_found`
 *   - `invoice.memberId === cycle.memberId`            → else `invalid_draft`
 *   - `invoice.planYear === deriveFiscalYear(cycle.periodFrom)`
 *                                                      → else `invalid_draft`
 *
 * The planYear equality is not pedantry: `reanchorPeriodInTx` can move a
 * cycle's `period_from` AFTER the draft was created, and `invoices.plan_year`
 * is the year that PRINTS on the tax document. Refusing on drift keeps the
 * printed year and the cycle's year provably identical — which also makes
 * "which year keys the duplicate guard" a non-question. A refused draft is
 * discardable and the cron re-drafts it correctly; that is the right failure
 * direction for a tax document.
 *
 * ## Guard 2 (HARD REQ #2) — the duplicate-§86/4 barrier
 *
 * Task 7's split-tx shape leaves a window where a concurrent `confirmRenewal`
 * creates a live invoice for the same (member, planYear) while an auto-draft
 * is in flight (see `auto-draft-due-renewals.ts:444-457`). THIS guard is the
 * designed barrier for that window, and it is the last check before a number
 * is burned.
 *
 * It refuses when another COMMITTED membership §86/4 already COVERS the charged
 * next-term window this draft would issue for (`[cycle.periodTo, periodTo +
 * frozenPlanTermMonths)`) — the coverage-overlap guard shared with the other
 * mint paths (`findOverlappingMembershipCoverageBill`,
 * `domain/membership-bill-coverage.ts`, mig 0281), excluding the draft being
 * issued (`excludeInvoiceId`):
 *
 *   blocks iff status ∈ BLOCKING_STATUSES = { issued | paid | partially_credited }
 *   AND its persisted coverage window overlaps (half-open `[from, to)`).
 *
 * `draft` does NOT block here (no `includeDrafts`): the ISSUE path mints ONE and
 * the sibling auto-draft sweep clears the rest, so a coexisting draft is not a
 * duplicate. Money-safety does not depend on draft-blocking — the DB EXCLUDE on
 * committed rows rejects any concurrent double-ISSUE regardless (mapped to
 * `invoice_already_issued`).
 *
 * `void` + fully-`credited` never block — the refunded period is re-billable —
 * and a NULL-coverage bill (legacy/first-payment) never participates, exactly
 * matching the DB `blocks_coverage` predicate.
 *
 * ## Membership-access gate — `terminated` ONLY, not `suspended`
 *
 * `deriveMembershipAccess` maps `awaiting_payment` → `suspended/unpaid`, and
 * an expired `upcoming|reminded` cycle → `suspended/unpaid` as well. A draft
 * created inside the lead window (T-30ish) routinely sits in the review queue
 * across T-0, at which point `enterAwaitingPaymentOnExpiry` flips its cycle to
 * `awaiting_payment`. Gating on `access !== 'full'` (as
 * `auto-draft-due-renewals.ts:375` correctly does at DRAFT time, where the
 * cycle is guaranteed unexpired) would therefore refuse the ORDINARY issue.
 *
 * Billing a member who is "suspended (unpaid)" is exactly what a renewal bill
 * IS — issuing is what CREATES that state. `terminated` (lapsed, or cancelled
 * past coverage end) is the real do-not-bill signal, so that is the gate.
 *
 * ## Erasure gate (GDPR Art.17 / PDPA §33) — SEPARATE from the access gate
 *
 * The membership-access gate above provably does NOT catch an erased member,
 * so this needs its own predicate. Erasure (`scrubPiiInTx`) deliberately
 * leaves `status` and the renewal cycle alone — "erasure is orthogonal to
 * archive" — and stamps only `erased_at`. A queued auto-draft's cycle is
 * unexpired BY CONSTRUCTION (`listCyclesEligibleForAutoDraft` requires
 * `expires_at > now`), and `deriveMembershipAccess` returns `full` for an
 * unexpired `upcoming`/`reminded`/`cancelled` cycle. So even after a fully
 * SUCCESSFUL erasure cascade the draft stays issuable on the ordinary path,
 * and `member_terminated` never fires. A treasurer clicking Issue would mint
 * an immutable §87-numbered §86/4 naming `[erased]`, pin a
 * `member_identity_snapshot` of scrubbed data, and render a PDF to Blob —
 * new money-path processing for a subject who exercised Art.17, AFTER
 * `member_erased` was emitted as completion proof.
 *
 * This is the SAME hard exclusion the drafter query already enforces
 * (`drizzle-renewal-cycle-repo.ts` — `AND m.erased_at IS NULL`); before this
 * gate the invariant was only one predicate deep, so anything that reached
 * the queue by another route (a draft created BEFORE the erasure, which is
 * the ordinary case) sailed through.
 *
 * NOTE the deliberate contrast with `admin-renew-lapsed-member.ts` /
 * `confirm-renewal.ts`, which read the SAME `erased` flag but use it only to
 * gate the printed coverage-window TEXT, explicitly NOT to refuse ("a hard
 * erased refusal is a separate COMP-1 policy decision"). Those are
 * human-initiated renewals of a membership. This is AUTOMATED billing, which
 * erasure already opted the member out of by resetting
 * `auto_invoice_enrolled_at` — so refusing here contradicts nothing.
 *
 * ### Ordering — the gate sits ABOVE `discardSupersededDrafts`
 *
 * `return err(...)` inside a `runInTenant` callback does NOT throw: the
 * callback returns normally and the transaction COMMITS. A guard placed below
 * the sweep would therefore leave the sibling deletions AND their
 * `renewal_auto_draft_discarded { reason:'superseded_on_issue' }` audit rows
 * persisted for an issue that never happened. Integration case (l) asserts
 * the sibling survives, so moving this gate down turns that test red.
 *
 * ## Audit
 *
 * No `renewal_entered_awaiting_payment` is emitted. Its `source` is a closed
 * `'cron' | 'confirm'` union and widening it is out of scope; the transition
 * is already evidenced by `linked_invoice_id` plus F4's own `invoice_issued`
 * row from the issue path. tx3 emits `renewal_auto_draft_discarded` per
 * discarded sibling (F4 additionally emits its own `invoice_draft_deleted`).
 *
 * ## Failure direction
 *
 * Every guard failure happens BEFORE the number is minted, so a refusal never
 * leaves a burned number behind. After a successful issue, the only remaining
 * failure is the link step; that returns success-with-warning (the bill is
 * real and the member owes it) and logs a greppable
 * `F8.AUTO_ISSUE.LINK_FAILED` — Task 11's `reconcile-issued-orphans` cron is
 * the backstop.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { asMemberId } from '@/modules/members';
import { parseInput } from './_lib/parse-input';
import { addMonthsUtc } from '@/lib/dates';
import { findOverlappingMembershipCoverageBill } from '../../domain/membership-bill-coverage';
import { deriveMembershipAccess } from '../../domain/renewal-cycle';
import type { CycleId } from '../../domain/renewal-cycle';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { RenewalInvoiceErrorCode } from '../ports/f4-invoicing-bridge';
import { InvoiceLinkConflictError } from '../ports/renewal-cycle-repo';

export const issueAutoDraftedRenewalInputSchema = z.object({
  tenantId: z.string().min(1),
  invoiceId: z.string().uuid(),
  actorUserId: z.string().min(1),
  /**
   * The operator's definite send-vs-silent choice — never a "no opinion"
   * placeholder. Threads to the bridge's `autoEmailOnIssue`, which becomes
   * `issueMembershipBill`'s `autoEmailOverride` and OUTRANKS both the draft's
   * stored `autoEmailOnIssue` (always `false` for a cron draft) and the
   * tenant's `auto_email_enabled` default. Without the override, "Issue
   * silently" on a tenant with auto-email ON would still send.
   */
  sendEmail: z.boolean(),
  requestId: z.string().nullable().optional(),
});

export type IssueAutoDraftedRenewalInput = z.infer<
  typeof issueAutoDraftedRenewalInputSchema
>;

export interface IssueAutoDraftedRenewalOutput {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  /** 106-void-on-reissue supersede-void warnings, threaded verbatim from F4. */
  readonly supersedeWarnings: readonly string[];
  /**
   * Non-null when the bill was issued but the cycle could NOT be flipped/linked
   * even after the idempotent retry. The bill is valid and payable; the cycle
   * is temporarily out of sync until Task 11's reconcile cron repairs it.
   */
  readonly linkWarning: string | null;
  /** Sibling auto-drafts discarded by tx3 (usually empty). */
  readonly discardedInvoiceIds: readonly string[];
}

/** Why a draft failed the HARD REQ #1 shape check — all pre-issue. */
export type InvalidDraftReason =
  | 'not_auto_renewal'
  | 'not_draft'
  | 'member_mismatch'
  | 'plan_year_drift';

export type IssueAutoDraftError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'draft_not_found' }
  | { readonly kind: 'cycle_not_found' }
  | {
      readonly kind: 'invalid_draft';
      readonly reason: InvalidDraftReason;
      readonly detail: string;
    }
  | { readonly kind: 'member_terminated'; readonly reason: string }
  /** The member exercised GDPR Art.17 / PDPA §33 — see the header's erasure note. */
  | { readonly kind: 'member_erased' }
  | {
      readonly kind: 'duplicate_live_bill';
      readonly conflictingInvoiceId: string;
      readonly conflictingStatus: string;
    }
  | {
      readonly kind: 'issue_failed';
      readonly errorCode: RenewalInvoiceErrorCode;
      readonly detail: string;
    };

export type IssueAutoDraftedRenewalDeps = Pick<
  RenewalsDeps,
  | 'tenant'
  | 'cyclesRepo'
  | 'auditEmitter'
  | 'clock'
  | 'f4InvoicingBridge'
  | 'memberRenewalFlagsRepo'
>;

export async function issueAutoDraftedRenewal(
  deps: IssueAutoDraftedRenewalDeps,
  rawInput: IssueAutoDraftedRenewalInput,
): Promise<Result<IssueAutoDraftedRenewalOutput, IssueAutoDraftError>> {
  const inputResult = parseInput(issueAutoDraftedRenewalInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;
  const requestId = input.requestId ?? null;

  // ---- tx1: lock → re-read → every guard. Closes before the F4 call. ------
  const guardResult = await runInTenant(deps.tenant, async (tx) => {
    // The invoice read comes FIRST because the cycle is reachable only via
    // the invoice (`auto_draft_invoice_id`), but the lock must be held for
    // the guards that follow — so we take the lock as soon as the cycle id is
    // known, then RE-READ everything under it. The pre-lock read is used only
    // to find the cycle, never to make a decision.
    const preRead = await deps.cyclesRepo.findMembershipInvoiceInTx(
      tx,
      input.tenantId,
      input.invoiceId,
    );
    if (!preRead) return err({ kind: 'draft_not_found' as const });

    const preCycle = await deps.cyclesRepo.findByAutoDraftInvoiceIdInTx(
      tx,
      input.tenantId,
      input.invoiceId,
    );
    if (!preCycle) return err({ kind: 'cycle_not_found' as const });

    await deps.cyclesRepo.acquireCycleLockInTx(
      tx,
      input.tenantId,
      preCycle.cycleId,
    );

    // --- authoritative re-reads, now serialised by the lock ---------------
    const invoice = await deps.cyclesRepo.findMembershipInvoiceInTx(
      tx,
      input.tenantId,
      input.invoiceId,
    );
    if (!invoice) return err({ kind: 'draft_not_found' as const });
    const cycle = await deps.cyclesRepo.findByIdInTx(
      tx,
      input.tenantId,
      preCycle.cycleId,
    );
    if (!cycle) return err({ kind: 'cycle_not_found' as const });

    // --- HARD REQ #1: shape checks ----------------------------------------
    if (invoice.origin !== 'auto_renewal') {
      return err({
        kind: 'invalid_draft' as const,
        reason: 'not_auto_renewal' as const,
        detail: `invoice origin is '${invoice.origin}' — only auto_renewal drafts may be issued from the renewals queue`,
      });
    }
    if (invoice.status !== 'draft') {
      return err({
        kind: 'invalid_draft' as const,
        reason: 'not_draft' as const,
        detail: `invoice status is '${invoice.status}', expected 'draft'`,
      });
    }
    if (invoice.memberId !== cycle.memberId) {
      return err({
        kind: 'invalid_draft' as const,
        reason: 'member_mismatch' as const,
        detail: 'the stamped cycle belongs to a different member than the invoice',
      });
    }
    // Same derivation as `confirm-renewal.ts:492` and
    // `auto-draft-due-renewals.ts:351` — `periodFrom`, NOT `periodTo` (the
    // design doc's §5.2 prose predates the 070/FR-022 calendar-edge fix).
    // Tax-document consistency across all three renewal paths is mandatory.
    const planYear = deriveFiscalYear(cycle.periodFrom);
    if (invoice.planYear !== planYear) {
      return err({
        kind: 'invalid_draft' as const,
        reason: 'plan_year_drift' as const,
        detail: `invoice plan_year ${invoice.planYear} != cycle-derived fiscal year ${planYear} (cycle re-anchored after drafting?)`,
      });
    }

    // --- membership-access re-assert (terminated only — see header) --------
    const latestCycle = await deps.cyclesRepo.findLatestCycleForMemberInTx(
      tx,
      input.tenantId,
      cycle.memberId,
    );
    const access = deriveMembershipAccess(latestCycle, deps.clock.now());
    if (access.access === 'terminated') {
      return err({
        kind: 'member_terminated' as const,
        reason: access.reason,
      });
    }

    // --- GDPR Art.17 / PDPA §33 erasure gate (see header) ------------------
    // MUST stay directly above `discardSupersededDrafts` — the first write in
    // this transaction. See the header's ordering note.
    const guards = await deps.memberRenewalFlagsRepo.readReactivationGuardsInTx(
      tx,
      input.tenantId,
      cycle.memberId,
    );
    // `null` (member row RLS-hidden / absent) refuses TOO — erasure state
    // unknown is not erasure state false. A DELIBERATE divergence from the port
    // docstring's default caller behaviour ("treats this the same as
    // both-guards-false"), which is written for the F4 invoice-paid path where
    // proceeding is the benign outcome; here the guarded write mints a §86/4
    // that no re-drive can un-mint. Matches the sibling fail-closed default in
    // `bulk-enrol-auto-invoice.ts` (`?.access ?? 'terminated'`).
    if (guards === null || guards.erased) {
      logger.warn(
        {
          errorId: 'F8.AUTO_ISSUE.MEMBER_ERASED',
          tenantId: input.tenantId,
          cycleId: cycle.cycleId,
          invoiceId: input.invoiceId,
          planYear,
          guardsUnreadable: guards === null,
        },
        '[issue-auto-drafted-renewal] refused — the member is erased or unreadable; a §86/4 must never be minted for an anonymised tombstone',
      );
      return err({ kind: 'member_erased' as const });
    }

    // --- sweep superseded sibling auto-drafts, THEN guard -----------------
    // Order is load-bearing (review Critical 1): the sweep removes the drafts
    // this issue supersedes so they cannot linger as competing claims on a
    // number, and the guard below then treats ANY surviving draft as blocking.
    // Both run under the lock, in THIS transaction, so a concurrent issuer
    // observes either both or neither.
    const discardedInvoiceIds = await discardSupersededDrafts(deps, tx, {
      tenantId: input.tenantId,
      cycleId: cycle.cycleId,
      memberId: cycle.memberId,
      planYear,
      issuedInvoiceId: input.invoiceId,
      actorUserId: input.actorUserId,
      requestId,
    });

    // --- HARD REQ #2: the duplicate-§86/4 barrier -------------------------
    // membership-coverage-exclude-guard (mig 0281) — the pre-flight twin of the
    // DB EXCLUDE, using PERSISTED coverage rather than a plan_year
    // approximation. `wNew` is THIS draft's own stamped window
    // ([periodTo, periodTo+term)); the draft is EXCLUDED, so the guard refuses
    // only when a DIFFERENT live membership bill overlaps it.
    const wNew = {
      from: cycle.periodTo,
      to: addMonthsUtc(cycle.periodTo, cycle.frozenPlanTermMonths),
    };
    const coverageBills =
      await deps.cyclesRepo.listMembershipCoverageForMemberInTx(
        tx,
        input.tenantId,
        cycle.memberId,
      );
    const blocking = findOverlappingMembershipCoverageBill(coverageBills, wNew, {
      excludeInvoiceId: input.invoiceId,
    });
    if (blocking) {
      logger.warn(
        {
          tenantId: input.tenantId,
          cycleId: cycle.cycleId,
          invoiceId: input.invoiceId,
          conflictingInvoiceId: blocking.invoiceId,
          conflictingStatus: blocking.status,
          coverageFrom: wNew.from,
          coverageTo: wNew.to,
        },
        '[issue-auto-drafted-renewal] refused — a live membership bill already covers this period',
      );
      return err({
        kind: 'duplicate_live_bill' as const,
        conflictingInvoiceId: blocking.invoiceId,
        conflictingStatus: blocking.status,
      });
    }

    return ok({
      cycleId: cycle.cycleId,
      memberId: cycle.memberId,
      cycleStatus: cycle.status,
      planYear,
      discardedInvoiceIds,
    });
  });
  if (!guardResult.ok) return err(guardResult.error);
  const { cycleId, discardedInvoiceIds } = guardResult.value;

  // ---- issue: STANDALONE, no F8 tx or lock held --------------------------
  const issued = await deps.f4InvoicingBridge.issueExistingDraftForRenewal({
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    actorUserId: input.actorUserId,
    autoEmailOnIssue: input.sendEmail,
    requestId,
  });
  if (issued.status !== 'issued') {
    // review New-2 — `invoice_not_found` here has a specific, diagnosable
    // cause worth its own greppable id: the SYMMETRIC MUTUAL ABORT. Two
    // issues for the same (member, planYear) whose drafts sit on DIFFERENT
    // cycles take DIFFERENT advisory locks, so each tx1 can sweep the other's
    // draft before either mints. Both then fail here, and — because both
    // sweeps committed — BOTH queue rows have vanished, so the operator has
    // nothing to retry from the UI.
    //
    // Money-safe (zero numbers minted, which is the invariant that matters)
    // and self-healing: Task 7's cron re-drafts the member on its next run —
    // its eligibility query (`listCyclesEligibleForAutoDraft`) excludes only
    // members holding a live draft/issued membership invoice, and both drafts
    // are now gone, so a still-`upcoming|reminded` cycle in the lead window
    // becomes eligible again. It does NOT consult `auto_draft_invoice_id`, so
    // the stale stamp left pointing at the deleted draft does not block it.
    const mutualAbort = issued.errorCode === 'invoice_not_found';
    logger.warn(
      {
        errorId: mutualAbort
          ? 'F8.AUTO_ISSUE.DRAFT_VANISHED_BEFORE_MINT'
          : 'F8.AUTO_ISSUE.ISSUE_FAILED',
        tenantId: input.tenantId,
        cycleId,
        invoiceId: input.invoiceId,
        errorCode: issued.errorCode,
        detail: issued.detail,
        ...(mutualAbort
          ? {
              hint: 'draft deleted by a concurrent issue for the same (member, plan_year) before this one could mint; no number was burned — the auto-draft cron re-drafts on its next run',
            }
          : {}),
      },
      '[issue-auto-drafted-renewal] F4 issue failed — no number minted',
    );
    return err({
      kind: 'issue_failed',
      errorCode: issued.errorCode,
      detail: issued.detail,
    });
  }

  // ---- tx2: flip + link (idempotent, retried once) -----------------------
  const linkWarning = await linkWithRetry(deps, {
    tenantId: input.tenantId,
    cycleId,
    invoiceId: input.invoiceId,
  });

  return ok({
    invoiceId: issued.invoiceId,
    invoiceNumber: issued.invoiceNumber,
    supersedeWarnings: issued.supersedeWarnings ?? [],
    linkWarning,
    discardedInvoiceIds,
  });
}

/**
 * tx2 — flip the cycle to `awaiting_payment` and stamp `linked_invoice_id`.
 *
 * Branches on the re-read status because there is NO
 * `awaiting_payment → awaiting_payment` edge in `CYCLE_STATUS_TRANSITIONS`,
 * and `transitionStatus` runs `assertCanTransition` BEFORE its CAS — so
 * calling it on an already-flipped cycle throws `InvalidCycleTransitionError`
 * rather than the conflict error a converge-on-conflict shape would expect.
 * The T-0 enter-awaiting cron routinely wins this race for an aged draft, so
 * that branch is ordinary, not exotic.
 *
 * Returns `null` on success, or a warning string when the link could not be
 * made even after one idempotent retry.
 */
async function linkWithRetry(
  deps: IssueAutoDraftedRenewalDeps,
  args: {
    readonly tenantId: string;
    readonly cycleId: CycleId;
    readonly invoiceId: string;
  },
): Promise<string | null> {
  let lastError: unknown = null;
  // Two attempts: the first may lose a race with the T-0 cron or hit a
  // transient connection fault; the retry re-reads and converges.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const outcome = await runInTenant(deps.tenant, async (tx) => {
        await deps.cyclesRepo.acquireCycleLockInTx(tx, args.tenantId, args.cycleId);
        const cycle = await deps.cyclesRepo.findByIdInTx(
          tx,
          args.tenantId,
          args.cycleId,
        );
        if (!cycle) return 'cycle_gone' as const;

        if (cycle.status === 'upcoming' || cycle.status === 'reminded') {
          // The one-CAS path: flip AND stamp the link in a single guarded
          // UPDATE, so a concurrent writer can never observe a flipped cycle
          // that is not yet linked.
          await deps.cyclesRepo.transitionStatus(tx, args.tenantId, args.cycleId, {
            from: cycle.status,
            to: 'awaiting_payment',
            linkedInvoiceId: args.invoiceId,
          });
          return 'linked' as const;
        }

        if (cycle.status === 'awaiting_payment') {
          if (cycle.linkedInvoiceId === args.invoiceId) return 'already' as const;
          // Idempotent on the same id; throws InvoiceLinkConflictError when a
          // DIFFERENT invoice already owns this cycle.
          await deps.cyclesRepo.linkInvoice(
            tx,
            args.tenantId,
            args.cycleId,
            args.invoiceId,
          );
          return 'linked' as const;
        }

        // Terminal (completed/lapsed/cancelled) or pending_admin_reactivation
        // — forcing a flip would be wrong. The bill is real; leave the cycle.
        return 'terminal' as const;
      });

      if (outcome === 'linked' || outcome === 'already') return null;
      if (outcome === 'terminal') {
        return 'cycle reached a terminal status before the issued bill could be linked';
      }
      return 'cycle no longer exists — the issued bill is orphaned';
    } catch (e) {
      lastError = e;
      if (e instanceof InvoiceLinkConflictError) {
        // A DIFFERENT invoice owns this cycle. Retrying cannot help and would
        // only re-throw; surface it distinctly — this is a real conflict
        // (two bills contending for one cycle), not a transient fault.
        logger.error(
          {
            errorId: 'F8.AUTO_ISSUE.LINK_CONFLICT',
            tenantId: args.tenantId,
            cycleId: args.cycleId,
            attemptedInvoiceId: e.attemptedInvoiceId,
            existingInvoiceId: e.existingInvoiceId,
          },
          '[issue-auto-drafted-renewal] cycle already linked to a DIFFERENT invoice — our issued bill is orphaned; reconcile manually',
        );
        return `cycle is already linked to invoice ${e.existingInvoiceId}`;
      }
      if (attempt === 1) {
        logger.warn(
          {
            tenantId: args.tenantId,
            cycleId: args.cycleId,
            invoiceId: args.invoiceId,
            err: e instanceof Error ? e : new Error(String(e)),
          },
          '[issue-auto-drafted-renewal] link attempt 1 failed — retrying idempotently',
        );
      }
    }
  }

  // Both attempts failed. The bill IS issued and payable, so this is a
  // success-with-warning, not a failure — Task 11's reconcile-issued-orphans
  // cron repairs the missing link.
  logger.error(
    {
      errorId: 'F8.AUTO_ISSUE.LINK_FAILED',
      tenantId: args.tenantId,
      cycleId: args.cycleId,
      invoiceId: args.invoiceId,
      err: lastError instanceof Error ? lastError : new Error(String(lastError)),
    },
    '[issue-auto-drafted-renewal] could not link the issued bill to its cycle after a retry — reconcile cron must repair',
  );
  return 'issued bill could not be linked to its cycle — awaiting reconciliation';
}

/**
 * Discard sibling `origin='auto_renewal' status='draft'` invoices for the same
 * (member, planYear), excluding the one about to be issued.
 *
 * Runs INSIDE tx1, under the per-cycle advisory lock, BEFORE the content guard
 * and before the issue — see the module header's Critical-1 note. Both the
 * delete and the audit share the caller's `tx`, so they commit atomically with
 * the guard decision: a concurrent issuer sees either both or neither.
 *
 * The delete is status-guarded inside the SQL statement (`deleteDraft`), so a
 * sibling a concurrent writer promoted to `issued` is left untouched rather
 * than clobbered — the bridge reports `not_draft` and we skip the audit.
 *
 * NOTE: unlike the previous post-issue revision, failures here are NOT
 * swallowed. This now runs before anything irreversible, so a failed sweep
 * must abort the issue (a leftover competing draft is exactly what Critical 1
 * showed can become a duplicate bill). The thrown error propagates out of tx1,
 * rolling it back; nothing has been minted at that point.
 */
async function discardSupersededDrafts(
  deps: IssueAutoDraftedRenewalDeps,
  tx: unknown,
  args: {
    readonly tenantId: string;
    readonly cycleId: CycleId;
    readonly memberId: string;
    readonly planYear: number;
    readonly issuedInvoiceId: string;
    readonly actorUserId: string;
    readonly requestId: string | null;
  },
): Promise<readonly string[]> {
  const discarded: string[] = [];
  const siblings = await deps.cyclesRepo.listMembershipInvoicesForPlanYearInTx(
    tx as never,
    args.tenantId,
    args.memberId,
    args.planYear,
  );
  const stale = siblings.filter(
    (row) =>
      row.invoiceId !== args.issuedInvoiceId &&
      row.origin === 'auto_renewal' &&
      row.status === 'draft',
  );

  for (const row of stale) {
    const result = await deps.f4InvoicingBridge.discardAutoDraftForRenewal({
      tenantId: args.tenantId,
      invoiceId: row.invoiceId,
      actorUserId: args.actorUserId,
      requestId: args.requestId,
      tx,
      // The id came from the tenant-scoped read above, so a vanished row is a
      // benign race (prune cron / manual discard), NOT a cross-tenant probe.
      expectMayHaveVanished: true,
    });
    if (result.status !== 'discarded') {
      logger.info(
        {
          tenantId: args.tenantId,
          invoiceId: row.invoiceId,
          outcome: result.status,
        },
        '[issue-auto-drafted-renewal] sibling auto-draft not discarded (concurrently promoted or already gone) — left intact',
      );
      continue;
    }
    discarded.push(row.invoiceId);
    await deps.auditEmitter.emitInTx(
      tx as never,
      {
        type: 'renewal_auto_draft_discarded' as const,
        payload: {
          cycle_id: args.cycleId,
          member_id: asMemberId(args.memberId),
          invoice_id: row.invoiceId,
          reason: 'superseded_on_issue' as const,
        },
      },
      {
        tenantId: args.tenantId,
        actorUserId: args.actorUserId,
        actorRole: 'admin',
        correlationId: args.issuedInvoiceId,
        requestId: args.requestId,
      },
    );
  }
  return discarded;
}
