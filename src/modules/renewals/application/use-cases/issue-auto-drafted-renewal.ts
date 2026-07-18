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
 *   tx1  lock → re-read → ALL guards → close (lock released)
 *   issue  `issueExistingDraftForRenewal`, standalone, no F8 tx/lock held
 *   tx2  fresh lock → flip cycle to `awaiting_payment` + stamp the link
 *   tx3  own tx → discard superseded sibling auto-drafts
 *
 * tx3 is deliberately NOT folded into tx2: two concurrent issues for
 * DIFFERENT members can each hold their own cycle lock while deleting the
 * other's sibling draft rows, which deadlocks if both run inside a
 * lock-holding transaction. Running the discard in its own transaction, after
 * the lock is released, removes the cycle from the wait graph entirely.
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
 * It refuses when another membership invoice for the same (member, planYear)
 * — excluding the draft being issued — has reached a NUMBERED state, or is a
 * competing MANUAL draft:
 *
 *   {@link BLOCKING_LIVE_BILL_STATUSES} = issued | paid | partially_credited
 *                                         | credited
 *   plus: status='draft' AND origin='manual'
 *
 * `void` is excluded by design — a voided document is precisely the one that
 * no longer counts, and blocking on it would permanently wedge a member whose
 * first bill was voided for correction.
 *
 * ### Deviation from the task brief — FLAGGED FOR REVIEW
 *
 * The brief and plan both specify the blocking set as
 * `{draft, issued, paid, partially_credited, credited}` — i.e. ANY sibling
 * draft blocks. That cannot be right, because it makes tx3 unreachable: a
 * sibling `origin='auto_renewal'` draft would refuse the issue outright, so
 * the discard step the same brief mandates could never run, and the
 * `renewal_auto_draft_discarded { reason:'superseded_on_issue' }` audit event
 * (Task 2, already shipped) would be dead.
 *
 * Resolved in favour of the narrower set because a DRAFT is not a tax
 * document: it carries no §87 number and no §86/4 identity, so two drafts
 * cannot be a duplicate bill (design §5.4 calls double-drafting "harmless").
 * The duplicate-document risk is entirely in the numbered states, and those
 * all still block. A competing MANUAL draft blocks anyway — a treasurer
 * mid-way through their own bill for that year is a human-intent signal not
 * to auto-issue underneath them.
 *
 * Net effect: at most one numbered bill can exist per (member, planYear), and
 * the leftover auto-drafts get discarded by tx3 instead of wedging the queue.
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
import { deriveMembershipAccess } from '../../domain/renewal-cycle';
import type { CycleId } from '../../domain/renewal-cycle';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { RenewalInvoiceErrorCode } from '../ports/f4-invoicing-bridge';
import type { MembershipInvoiceRef } from '../ports/renewal-cycle-repo';
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
  'tenant' | 'cyclesRepo' | 'auditEmitter' | 'clock' | 'f4InvoicingBridge'
>;

/**
 * Statuses that mean "a real, numbered bill already exists for this
 * (member, planYear)". Exported so a reviewer can see the tax-critical set in
 * one place — and so the deviation documented in the module header is a
 * one-line change if it is ever overruled.
 *
 * `void` is intentionally absent: a voided document is the one that no longer
 * counts, and blocking on it would wedge any member whose bill was voided for
 * correction. `draft` is intentionally absent (see module header).
 */
export const BLOCKING_LIVE_BILL_STATUSES: ReadonlySet<string> = new Set([
  'issued',
  'paid',
  'partially_credited',
  'credited',
]);

/** The content guard — returns the conflicting row, or null when clear. */
function findBlockingBill(
  siblings: ReadonlyArray<MembershipInvoiceRef>,
  issuingInvoiceId: string,
): MembershipInvoiceRef | null {
  for (const row of siblings) {
    if (row.invoiceId === issuingInvoiceId) continue;
    if (BLOCKING_LIVE_BILL_STATUSES.has(row.status)) return row;
    // A treasurer's own in-progress membership draft for the same year — not
    // a duplicate DOCUMENT, but a human-intent signal not to auto-issue under
    // them. An `auto_renewal` sibling draft is NOT blocking; tx3 discards it.
    if (row.status === 'draft' && row.origin === 'manual') return row;
  }
  return null;
}

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

    // --- HARD REQ #2: the duplicate-§86/4 barrier -------------------------
    const siblings =
      await deps.cyclesRepo.listMembershipInvoicesForPlanYearInTx(
        tx,
        input.tenantId,
        cycle.memberId,
        planYear,
      );
    const blocking = findBlockingBill(siblings, input.invoiceId);
    if (blocking) {
      logger.warn(
        {
          tenantId: input.tenantId,
          cycleId: cycle.cycleId,
          invoiceId: input.invoiceId,
          conflictingInvoiceId: blocking.invoiceId,
          conflictingStatus: blocking.status,
          planYear,
        },
        '[issue-auto-drafted-renewal] refused — a live membership bill already exists for this (member, plan_year)',
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
    });
  });
  if (!guardResult.ok) return err(guardResult.error);
  const { cycleId, memberId, planYear } = guardResult.value;

  // ---- issue: STANDALONE, no F8 tx or lock held --------------------------
  const issued = await deps.f4InvoicingBridge.issueExistingDraftForRenewal({
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    actorUserId: input.actorUserId,
    autoEmailOnIssue: input.sendEmail,
    requestId,
  });
  if (issued.status !== 'issued') {
    logger.warn(
      {
        tenantId: input.tenantId,
        cycleId,
        invoiceId: input.invoiceId,
        errorCode: issued.errorCode,
        detail: issued.detail,
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

  // ---- tx3: discard superseded sibling auto-drafts (own tx) --------------
  const discardedInvoiceIds = await discardSupersededDrafts(deps, {
    tenantId: input.tenantId,
    cycleId,
    memberId,
    planYear,
    issuedInvoiceId: input.invoiceId,
    actorUserId: input.actorUserId,
    requestId,
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
 * tx3 — discard sibling `origin='auto_renewal' status='draft'` invoices for
 * the same (member, planYear), excluding the one just issued.
 *
 * Runs in its own transaction with NO cycle lock held (see the module
 * header's deadlock note). The delete itself is status-guarded inside the SQL
 * statement (`deleteDraft`), so a sibling that a concurrent writer promoted
 * to `issued` in the meantime is left untouched rather than clobbered — the
 * bridge reports `not_draft` and we skip the audit for it.
 *
 * Best-effort by construction: a leftover draft is harmless (design §5.4) and
 * Task 11's prune cron sweeps it, so a failure here must never fail an
 * already-issued bill.
 */
async function discardSupersededDrafts(
  deps: IssueAutoDraftedRenewalDeps,
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
  try {
    const siblings = await runInTenant(deps.tenant, (tx) =>
      deps.cyclesRepo.listMembershipInvoicesForPlanYearInTx(
        tx,
        args.tenantId,
        args.memberId,
        args.planYear,
      ),
    );
    const stale = siblings.filter(
      (row) =>
        row.invoiceId !== args.issuedInvoiceId &&
        row.origin === 'auto_renewal' &&
        row.status === 'draft',
    );

    for (const row of stale) {
      // Per-row isolation — one failed discard must not abandon the rest.
      try {
        const result = await deps.f4InvoicingBridge.discardAutoDraftForRenewal({
          tenantId: args.tenantId,
          invoiceId: row.invoiceId,
          actorUserId: args.actorUserId,
          requestId: args.requestId,
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
        await runInTenant(deps.tenant, (tx) =>
          deps.auditEmitter.emitInTx(
            tx,
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
          ),
        );
      } catch (e) {
        logger.error(
          {
            errorId: 'F8.AUTO_ISSUE.DISCARD_FAILED',
            tenantId: args.tenantId,
            invoiceId: row.invoiceId,
            err: e instanceof Error ? e : new Error(String(e)),
          },
          '[issue-auto-drafted-renewal] sibling auto-draft discard failed — prune cron will sweep it',
        );
      }
    }
  } catch (e) {
    logger.error(
      {
        errorId: 'F8.AUTO_ISSUE.DISCARD_SCAN_FAILED',
        tenantId: args.tenantId,
        cycleId: args.cycleId,
        err: e instanceof Error ? e : new Error(String(e)),
      },
      '[issue-auto-drafted-renewal] could not scan for superseded drafts — prune cron will sweep them',
    );
  }
  return discarded;
}
