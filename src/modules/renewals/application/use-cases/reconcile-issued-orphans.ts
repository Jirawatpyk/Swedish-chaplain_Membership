/**
 * 107-auto-invoice Task 11 — `reconcileIssuedOrphans`.
 *
 * Daily housekeeping cron: the backstop for `issueAutoDraftedRenewal`'s
 * `linkWithRetry` (Task 9) exhausting its one idempotent retry
 * (`F8.AUTO_ISSUE.LINK_FAILED`, logged there) or never running at all (a
 * process crash between the F4 issue commit and tx2). Finds every
 * `origin='auto_renewal' status='issued'` membership invoice whose
 * originating cycle (`renewal_cycles.auto_draft_invoice_id = invoice.id`)
 * still has `linked_invoice_id IS NULL`, and repairs the link — it must
 * NOT depend on an admin revisiting that cycle (design intent named
 * directly in `issue-auto-drafted-renewal.ts`'s docstring: "Task 11's
 * reconcile-issued-orphans cron is the backstop").
 *
 * The bill itself is ALREADY real and payable (F4 minted the §87 number
 * and committed before this cron ever runs) — only the F8 cycle's
 * forensic linkage is missing. Repairing it is therefore the EXACT same
 * mutation `linkWithRetry` performs on the ordinary path, replayed here as
 * a single attempt per cron pass (the cron's own daily re-run IS the
 * retry policy):
 *
 *   - cycle `upcoming`/`reminded` → flip to `awaiting_payment` AND stamp
 *     `linked_invoice_id` in one guarded CAS (`transitionStatus`). Throws
 *     `CycleTransitionConflictError` if a concurrent writer already moved
 *     the cycle off the expected `from` status between our re-read and
 *     this call — a genuine race, not a bug (review Minor fix: caught
 *     symmetrically with the `awaiting_payment` branch's conflict below).
 *   - cycle `awaiting_payment` with `linked_invoice_id` already null →
 *     `linkInvoice` (idempotent guarded UPDATE; throws
 *     `InvoiceLinkConflictError` if a DIFFERENT invoice raced in first —
 *     a genuine conflict, left for manual reconciliation, never forced).
 *   - terminal (`completed`/`lapsed`/`cancelled`) or
 *     `pending_admin_reactivation` → left alone. Forcing a link onto a
 *     cycle that has already closed would be wrong — the bill is real,
 *     but re-activating a lapsed/cancelled cycle's bookkeeping is not this
 *     cron's job. Mirrors `linkWithRetry`'s own terminal-state handling
 *     verbatim.
 *
 * Per-cycle advisory lock (`acquireCycleLockInTx`, namespace
 * `renewals:{tenant}:{cycle}`) — the SAME lock `linkWithRetry` and every
 * other cycle-mutating F8 use-case takes, so a reconcile pass can never
 * race a live `issueAutoDraftedRenewal` retry attempting to link the SAME
 * cycle concurrently.
 *
 * **Review Important-1 fix — invoice-status TOCTOU guard.** Unlike
 * `pruneAutoDrafts` (protected end-to-end by the F4 bridge's in-statement
 * `status='draft'` DELETE guard), this use-case originally re-checked only
 * the CYCLE row, never the INVOICE. If an admin voids/credits the orphan
 * invoice in the window between the candidate scan and this write, the old
 * code would have linked the cycle to a no-longer-`issued` invoice — and
 * because `linked_invoice_id` would then be non-null, that cycle would
 * PERMANENTLY drop out of `listIssuedAutoInvoiceOrphans`'s candidate set
 * with no self-healing path (no DB constraint catches it — the FK is
 * `(tenant_id, invoice_id)` with no status predicate). Fixed by re-reading
 * the invoice's LIVE status via `findMembershipInvoiceInTx` immediately
 * after acquiring the lock, INSIDE the same tx as the eventual write, and
 * bailing into `skipped_invoice_not_issued` when it is no longer `issued`
 * (or has vanished) — never linking a stale invoice.
 *
 * **Review Important-2 fix — dedicated audit event.** Unlike
 * `issueAutoDraftedRenewal`'s tx2 link (which happens in the SAME
 * operation/second as F4's own `invoice_issued` row, so that row's
 * timestamp already dates it — hence no separate
 * `renewal_entered_awaiting_payment` there), this cron is a SEPARATE
 * operation that can run DAYS later. `transitionStatus`/`linkInvoice`
 * carry no `actor_user_id`, so without a dedicated event there is no
 * append-only record of WHEN the repair happened — a compliance gap for a
 * money-linkage mutation. Emits `renewal_orphan_invoice_relinked`
 * (migration 0262) in the SAME tx as the link, mirroring the
 * `tier_upgrade_pending_orphan_detected` shape (an orphan-repair event
 * with the same "detected + fixed in one cron pass" semantics).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asMemberId } from '@/modules/members';
import { parseInput } from './_lib/parse-input';
import {
  CycleTransitionConflictError,
  InvoiceLinkConflictError,
} from '../ports/renewal-cycle-repo';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export const reconcileIssuedOrphansInputSchema = z.object({
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
});

export type ReconcileIssuedOrphansInput = z.infer<
  typeof reconcileIssuedOrphansInputSchema
>;

export interface ReconcileIssuedOrphansOutput {
  readonly candidatesFound: number;
  readonly relinked: number;
  /** Cycle reached a terminal/pending-reactivation status — left alone. */
  readonly skippedTerminal: number;
  /**
   * A concurrent writer raced us to the SAME cycle — either
   * `InvoiceLinkConflictError` (a DIFFERENT invoice already linked while
   * `awaiting_payment`) or `CycleTransitionConflictError` (the cycle moved
   * off the expected `upcoming`/`reminded` status between our re-read and
   * the transition). Both are genuine races, never forced; symmetric
   * bucket per review Minor fix.
   */
  readonly skippedConflict: number;
  /** Cycle no longer exists (extremely unlikely — cycles are never hard-deleted). */
  readonly skippedGone: number;
  /**
   * Review Important-1 fix — the invoice is no longer `status='issued'`
   * (voided/credited/paid by the time this row was processed) or has
   * vanished entirely. Never linked; left for manual reconciliation.
   */
  readonly skippedInvoiceNotIssued: number;
  readonly errors: number;
  readonly durationMs: number;
}

export type ReconcileIssuedOrphansError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

export type ReconcileIssuedOrphansDeps = Pick<
  RenewalsDeps,
  'tenant' | 'cyclesRepo' | 'auditEmitter'
>;

type RowOutcome =
  | 'relinked'
  | 'skipped_terminal'
  | 'skipped_conflict'
  | 'skipped_gone'
  | 'skipped_invoice_not_issued';

export async function reconcileIssuedOrphans(
  deps: ReconcileIssuedOrphansDeps,
  rawInput: ReconcileIssuedOrphansInput,
): Promise<Result<ReconcileIssuedOrphansOutput, ReconcileIssuedOrphansError>> {
  const inputResult = parseInput(reconcileIssuedOrphansInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const startedAt = Date.now();
  const candidates = await deps.cyclesRepo.listIssuedAutoInvoiceOrphans(
    input.tenantId,
  );

  let relinked = 0;
  let skippedTerminal = 0;
  let skippedConflict = 0;
  let skippedGone = 0;
  let skippedInvoiceNotIssued = 0;
  let errors = 0;

  for (const row of candidates) {
    try {
      const outcome = await runInTenant(
        deps.tenant,
        async (tx): Promise<RowOutcome> => {
          await deps.cyclesRepo.acquireCycleLockInTx(
            tx,
            input.tenantId,
            row.cycleId,
          );

          // Review Important-1 fix — re-check the invoice's LIVE status
          // under the lock, INSIDE this tx, immediately before deciding to
          // write. See module docstring for the non-self-healing bug this
          // closes.
          const invoice = await deps.cyclesRepo.findMembershipInvoiceInTx(
            tx,
            input.tenantId,
            row.invoiceId,
          );
          if (!invoice || invoice.status !== 'issued') {
            return 'skipped_invoice_not_issued';
          }

          const cycle = await deps.cyclesRepo.findByIdInTx(
            tx,
            input.tenantId,
            row.cycleId,
          );
          if (!cycle) return 'skipped_gone';

          if (cycle.status === 'upcoming' || cycle.status === 'reminded') {
            const previousCycleStatus = cycle.status;
            try {
              await deps.cyclesRepo.transitionStatus(
                tx,
                input.tenantId,
                row.cycleId,
                {
                  from: cycle.status,
                  to: 'awaiting_payment',
                  linkedInvoiceId: row.invoiceId,
                },
              );
            } catch (e) {
              // Review Minor fix — symmetric with the `awaiting_payment`
              // branch's `InvoiceLinkConflictError` catch below: a
              // concurrent writer (e.g. a lazy self-transition from
              // `confirmRenewal`) moved the cycle off the expected `from`
              // status between our re-read and this call. A genuine race,
              // not a bug — must not inflate the generic `errors` counter.
              if (e instanceof CycleTransitionConflictError) {
                logger.warn(
                  {
                    tenantId: input.tenantId,
                    cycleId: row.cycleId,
                    invoiceId: row.invoiceId,
                    expectedFrom: e.expectedFrom,
                    actualStatus: e.actualStatus,
                  },
                  '[reconcile-issued-orphans] cycle transitioned concurrently — leaving alone; a later pass or the live retry will resolve it',
                );
                return 'skipped_conflict';
              }
              throw e;
            }
            await deps.auditEmitter.emitInTx(
              tx,
              {
                type: 'renewal_orphan_invoice_relinked' as const,
                payload: {
                  cycle_id: row.cycleId,
                  member_id: asMemberId(row.memberId),
                  invoice_id: row.invoiceId,
                  previous_cycle_status: previousCycleStatus,
                },
              },
              {
                tenantId: input.tenantId,
                actorUserId: null,
                actorRole: 'cron',
                correlationId: input.correlationId,
              },
            );
            return 'relinked';
          }

          if (cycle.status === 'awaiting_payment') {
            // Already converged (a concurrent pass/retry won the race
            // between our list-scan and this lock acquisition) — idempotent
            // no-op, still counted as a success, but no new audit row (the
            // link already happened and was already audited by whichever
            // writer made it).
            if (cycle.linkedInvoiceId === row.invoiceId) return 'relinked';
            try {
              await deps.cyclesRepo.linkInvoice(
                tx,
                input.tenantId,
                row.cycleId,
                row.invoiceId,
              );
            } catch (e) {
              if (e instanceof InvoiceLinkConflictError) {
                logger.error(
                  {
                    errorId: 'F8.RECONCILE_ORPHANS.LINK_CONFLICT',
                    tenantId: input.tenantId,
                    cycleId: row.cycleId,
                    invoiceId: row.invoiceId,
                    attemptedInvoiceId: e.attemptedInvoiceId,
                    existingInvoiceId: e.existingInvoiceId,
                  },
                  '[reconcile-issued-orphans] cycle already linked to a DIFFERENT invoice — leaving alone; reconcile manually',
                );
                return 'skipped_conflict';
              }
              throw e;
            }
            await deps.auditEmitter.emitInTx(
              tx,
              {
                type: 'renewal_orphan_invoice_relinked' as const,
                payload: {
                  cycle_id: row.cycleId,
                  member_id: asMemberId(row.memberId),
                  invoice_id: row.invoiceId,
                  previous_cycle_status: 'awaiting_payment' as const,
                },
              },
              {
                tenantId: input.tenantId,
                actorUserId: null,
                actorRole: 'cron',
                correlationId: input.correlationId,
              },
            );
            return 'relinked';
          }

          // Terminal (completed/lapsed/cancelled) or
          // pending_admin_reactivation — forcing a link would be wrong.
          // The bill is real; leave the cycle (mirrors `linkWithRetry`'s
          // own terminal-state handling).
          return 'skipped_terminal';
        },
      );

      switch (outcome) {
        case 'relinked':
          relinked += 1;
          break;
        case 'skipped_terminal':
          skippedTerminal += 1;
          logger.info(
            {
              tenantId: input.tenantId,
              invoiceId: row.invoiceId,
              cycleId: row.cycleId,
            },
            '[reconcile-issued-orphans] cycle reached a terminal status before the link could be repaired — leaving alone',
          );
          break;
        case 'skipped_conflict':
          skippedConflict += 1;
          break;
        case 'skipped_gone':
          skippedGone += 1;
          logger.warn(
            {
              tenantId: input.tenantId,
              invoiceId: row.invoiceId,
              cycleId: row.cycleId,
            },
            '[reconcile-issued-orphans] cycle no longer exists — issued bill remains unlinked',
          );
          break;
        case 'skipped_invoice_not_issued':
          skippedInvoiceNotIssued += 1;
          logger.info(
            {
              tenantId: input.tenantId,
              invoiceId: row.invoiceId,
              cycleId: row.cycleId,
            },
            '[reconcile-issued-orphans] invoice is no longer issued (voided/credited/vanished) — leaving cycle unlinked',
          );
          break;
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
        }
      }
    } catch (e) {
      errors += 1;
      logger.error(
        {
          errorId: 'F8.RECONCILE_ORPHANS.ROW_FAILED',
          tenantId: input.tenantId,
          invoiceId: row.invoiceId,
          cycleId: row.cycleId,
          err: e instanceof Error ? e : new Error(String(e)),
        },
        '[reconcile-issued-orphans] candidate relink threw — counted in errors; cron continues',
      );
    }
  }

  return ok({
    candidatesFound: candidates.length,
    relinked,
    skippedTerminal,
    skippedConflict,
    skippedGone,
    skippedInvoiceNotIssued,
    errors,
    durationMs: Date.now() - startedAt,
  });
}
