/**
 * sweepPendingPaymentsOnUnpayableInvoices — hourly retry for pending payments
 * left on invoices that are no longer payable (follow-up to the #447 review).
 *
 * `voidInvoice` cancels the voided invoice's pending PaymentIntents
 * best-effort after it commits (`cancelPendingPaymentsForInvoice`). When that
 * call failed — Stripe retryable error, DB fault, missing payment settings —
 * the row stayed `pending` with nothing to retry it, and a card clientSecret
 * the PaySheet had cached could still capture money for a voided invoice.
 * This sweep finds `pending` attempts on invoices whose status is anything but
 * `issued` (void, paid, credited, partially_credited — none may ever capture)
 * and re-runs the same per-invoice cancel as the system actor.
 *
 * Safety comes from the per-invoice use-case, not from here: it takes
 * initiate's `payments:{tenant}:{invoice}` advisory lock, re-locks each row,
 * and flips it with a status-checked update — so overlapping runs, a
 * concurrent void-time cancel, and replays are all no-ops. This orchestrator
 * opens no transaction of its own.
 *
 * Runs at the end of the hourly `/api/cron/sweep-stale-pending-refunds` route
 * (no extra Vercel cron slot). Bounded by a batch limit and a time budget; what
 * is left is picked up next hour.
 */
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import type { ClockPort } from '../ports/clock-port';
import type { UnpayablePendingFinderPort } from '../ports/unpayable-pending-finder-port';
import {
  cancelPendingPaymentsForInvoice,
  type CancelPendingPaymentsForInvoiceDeps,
} from './cancel-pending-payments-for-invoice';

/** Leave attempts younger than this to the void's own post-commit cancel. */
export const PENDING_ON_UNPAYABLE_MIN_AGE_MINUTES = 15;
/** Stop retrying (and auditing) after this; the 24h stale-pending gauge alerts. */
export const PENDING_ON_UNPAYABLE_MAX_AGE_DAYS = 7;
/** Invoices per run; the rest wait for the next hourly run. */
export const PENDING_ON_UNPAYABLE_BATCH_LIMIT = 50;

export interface SweepPendingOnUnpayableDeps {
  readonly finder: UnpayablePendingFinderPort;
  /** Tenant-bound deps for the per-invoice cancel (RLS sees that tenant). */
  readonly cancelDepsFor: (tenantId: string) => CancelPendingPaymentsForInvoiceDeps;
  readonly clock: ClockPort;
}

export interface SweepPendingOnUnpayableInput {
  readonly requestId: string | null;
  /** Stop STARTING new invoices once this much time has elapsed. */
  readonly budgetMs: number;
}

export interface SweepPendingOnUnpayableResult {
  readonly invoicesFound: number;
  readonly invoicesProcessed: number;
  /** Per-invoice cancel threw (DB fault) — retried next run. */
  readonly invoicesErrored: number;
  /** Not started because the time budget ran out — retried next run. */
  readonly deferred: number;
  readonly canceled: number;
  readonly skipped: number;
  readonly failed: number;
}

export async function sweepPendingPaymentsOnUnpayableInvoices(
  deps: SweepPendingOnUnpayableDeps,
  input: SweepPendingOnUnpayableInput,
): Promise<SweepPendingOnUnpayableResult> {
  const startedMs = deps.clock.nowMs();
  const pairs = await deps.finder.listInvoicesWithPendingOnUnpayable({
    minAgeMinutes: PENDING_ON_UNPAYABLE_MIN_AGE_MINUTES,
    maxAgeDays: PENDING_ON_UNPAYABLE_MAX_AGE_DAYS,
    limit: PENDING_ON_UNPAYABLE_BATCH_LIMIT,
  });

  let invoicesProcessed = 0;
  let invoicesErrored = 0;
  let canceled = 0;
  let skipped = 0;
  let failed = 0;

  for (const { tenantId, invoiceId } of pairs) {
    if (deps.clock.nowMs() - startedMs > input.budgetMs) break;
    try {
      const r = await cancelPendingPaymentsForInvoice(deps.cancelDepsFor(tenantId), {
        tenantId,
        invoiceId,
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        cause: 'invoice_not_payable_sweep',
        requestId: input.requestId,
      });
      invoicesProcessed += 1;
      canceled += r.canceled;
      skipped += r.skipped;
      failed += r.failed;
    } catch {
      // One invoice's DB fault must not stop the rest; it is retried next run.
      invoicesErrored += 1;
    }
  }

  return {
    invoicesFound: pairs.length,
    invoicesProcessed,
    invoicesErrored,
    deferred: pairs.length - invoicesProcessed - invoicesErrored,
    canceled,
    skipped,
    failed,
  };
}
