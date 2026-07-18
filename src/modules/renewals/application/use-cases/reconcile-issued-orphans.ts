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
 *     `linked_invoice_id` in one guarded CAS (`transitionStatus`).
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
 * No new audit event: per `issue-auto-drafted-renewal.ts`'s own precedent
 * for this EXACT mutation ("No `renewal_entered_awaiting_payment` is
 * emitted ... already evidenced by `linked_invoice_id` plus F4's own
 * `invoice_issued` row from the issue path"), the repaired link is
 * evidenced by the `linked_invoice_id` column itself plus F4's existing
 * `invoice_issued` audit row — adding a new `audit_event_type` enum value
 * (a migration) purely to re-state that the SAME fact converged slightly
 * later would not add forensic information. A structured pino log +
 * OTel counter (`renewalsMetrics`, wired at the route) carry the
 * operational signal instead.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { parseInput } from './_lib/parse-input';
import { InvoiceLinkConflictError } from '../ports/renewal-cycle-repo';
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
  /** Cycle raced to a DIFFERENT invoice first — a genuine conflict, not ours to force. */
  readonly skippedConflict: number;
  /** Cycle no longer exists (extremely unlikely — cycles are never hard-deleted). */
  readonly skippedGone: number;
  readonly errors: number;
  readonly durationMs: number;
}

export type ReconcileIssuedOrphansError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

export type ReconcileIssuedOrphansDeps = Pick<
  RenewalsDeps,
  'tenant' | 'cyclesRepo'
>;

type RowOutcome =
  | 'relinked'
  | 'skipped_terminal'
  | 'skipped_conflict'
  | 'skipped_gone';

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
          const cycle = await deps.cyclesRepo.findByIdInTx(
            tx,
            input.tenantId,
            row.cycleId,
          );
          if (!cycle) return 'skipped_gone';

          if (cycle.status === 'upcoming' || cycle.status === 'reminded') {
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
            return 'relinked';
          }

          if (cycle.status === 'awaiting_payment') {
            // Already converged (a concurrent pass/retry won the race
            // between our list-scan and this lock acquisition) — idempotent
            // no-op, still counted as a success.
            if (cycle.linkedInvoiceId === row.invoiceId) return 'relinked';
            try {
              await deps.cyclesRepo.linkInvoice(
                tx,
                input.tenantId,
                row.cycleId,
                row.invoiceId,
              );
              return 'relinked';
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
    errors,
    durationMs: Date.now() - startedAt,
  });
}
