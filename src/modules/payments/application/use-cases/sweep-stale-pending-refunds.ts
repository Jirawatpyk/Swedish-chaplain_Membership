/**
 * T130a + A.14 — sweepStalePendingRefunds use-case (F5 refund-lifecycle).
 *
 * Recovery sweep for the `pending` refund rows that `issueRefund`'s
 * two-phase tx model can leave stranded:
 *
 *   - Phase A commits the `pending` refund row + audit `refund_initiated`.
 *   - External: Stripe `createRefund` (+ `attachProcessorRefundId`) then,
 *     on a synchronous `succeeded`, the F4 CN + Phase-B finalise.
 *   - A `pending`/`requires_action` Stripe status legitimately leaves the
 *     row `pending` awaiting the async `charge.refund.updated` webhook
 *     (A.11), OR a Postgres double-fault leaves it stuck `pending` forever.
 *
 * Either way the `refund_in_progress` guard at `issueRefund` then blocks
 * all future refunds on that payment until the row reaches a terminal state.
 *
 * **A.14 — Stripe-aware finalisation (replaces the old blind-fail).** For
 * each stale `pending` refund the sweep now asks Stripe for the REAL
 * outcome and reconciles accordingly, instead of unconditionally flipping
 * the row to `failed` (which was a money-lie whenever Stripe had in fact
 * succeeded the refund):
 *
 *   1. `retrieveRefund(re_…)` OUTSIDE any row lock (external Stripe I/O),
 *      bounded by a per-call timeout.
 *   2. Then, in a per-row tx: lock the refund row `FOR UPDATE` FIRST
 *      (A.11 invariant — refund-row before payment-row), re-check it is
 *      still `pending` (skip if a concurrent writer finalised it), and
 *      branch on the retrieved status:
 *        - `succeeded`        → `finalizeSucceededRefund(…, path:'sweep_recovery')`
 *                               (idempotent F4 CN + refund/payment flip) → swept.
 *        - `failed|canceled`  → inline flip refund→failed (NO CN) → swept.
 *        - `pending`/other    → **skip** (NEVER mark failed — A.8 coerces a
 *                               null Stripe status to 'pending', so a
 *                               'pending' result may be a genuinely-null
 *                               status). Escalate to an ops signal if aged.
 *        - retrieve error/timeout → skip + count, no state change.
 *   3. A row with a NULL `processor_refund_id` cannot be reconciled against
 *      Stripe (the rare window where `createRefund` succeeded but the
 *      `attachProcessorRefundId` tx crashed). It is **skipped** (never
 *      blind-failed — a real Stripe refund may exist) and escalated if aged;
 *      ops reconciles it manually via the Stripe dashboard.
 *
 * **Blind-fail is fully removed** — the ONLY path to `failed` is now a
 * Stripe-confirmed `failed|canceled`. The `stale_pending_refund_detected`
 * audit is no longer emitted here (it survives only at `issueRefund`'s
 * synchronous double-fault site); the sweep's own signal is the
 * `stalePendingRefundEscalated` metric + a structured warn.
 *
 * **Bounds (M-i, triple).** External calls per run are bounded three ways so
 * they can never exceed the Vercel function budget (route `maxDuration=60`):
 * a row cap, a per-`retrieveRefund` timeout, and a total wall-clock budget
 * (remaining rows deferred to the next idempotent sweep). All three log on
 * truncation/deferral — never silent.
 *
 * Runs daily via Vercel Cron (`0 3 * * *`) + cron-job.org (`0 15 * * *`,
 * redundant) at `/api/cron/sweep-stale-pending-refunds`. Idempotent —
 * dual-firing safe. Per-tenant; the cron iterates tenants and calls once each.
 *
 * PCI SAQ-A (Principle IV): every audit payload + log carries id-refs +
 * status + satang ONLY — no card metadata, no raw Stripe error text.
 *
 * Pure Application — no framework / ORM imports.
 */
import { ok, err, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  InvoicingBridgePort,
  LoggerPort,
  PaymentsRepo,
  ProcessorGatewayError,
  ProcessorGatewayPort,
  RefundsRepo,
  RetrievedRefund,
  TenantPaymentSettingsRepo,
} from '../ports';
import { noopLogger } from '../ports/logger-port';
import { retentionFor } from '../ports/audit-port';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { finalizeSucceededRefund } from './_finalize-succeeded-refund';
import { paymentsMetrics } from '@/lib/metrics';

// --- M-i bounds (module consts per Constitution X) --------------------------
// Sized against the cron route's Vercel function budget (`maxDuration=60`)
// AND the cron-job.org request timeout (60s per docs/runbooks/cron-jobs.md).

/**
 * Hard cap on refund rows processed per tenant per run. Excess rows are
 * left for the next (idempotent) sweep — logged, never silently dropped.
 */
const MAX_STALE_REFUNDS_PER_SWEEP = 50;

/**
 * Per-`retrieveRefund` wall-clock ceiling. The Stripe SDK's own default
 * timeout is ~80 s — far beyond a serverless budget — so we bound each
 * external call ourselves; a timeout is treated as a retrieve error
 * (skip + count).
 */
const RETRIEVE_TIMEOUT_MS = 8_000;

/**
 * Total wall-clock budget across all retrieves in one tenant run. When
 * exceeded, the loop stops starting new rows (remaining → next sweep) and
 * logs the deferral.
 *
 * **Review-hardening (headroom math).** The guard only stops the loop
 * BEFORE *starting* a new row — the row that was already in flight when the
 * budget tipped over still pays its own (retrieve + finalise) cost:
 * `RETRIEVE_TIMEOUT_MS` (≤8s) for the Stripe read, plus
 * `finalizeSucceededRefund` on the `succeeded` path (F4 credit-note render +
 * Blob upload — effectively unbounded on a bad day). A kill mid-finalise is
 * safe (tx rolls back → row stays `pending` → next sweep reconciles; the CN
 * bridge is idempotent) but wastes the external Stripe call, so budget
 * enough headroom that the last row's tail usually finishes:
 *
 *   35s budget + ≤8s last retrieve + finalize allowance < 60s maxDuration
 *
 * This is coupled to BOTH the route's `maxDuration=60`
 * (`src/app/api/cron/sweep-stale-pending-refunds/route.ts`) AND the
 * cron-job.org per-job request timeout for this endpoint (currently 60s per
 * `docs/runbooks/stale-pending-refund-sweep.md`) — LOWER this const in
 * lockstep if either of those is ever reduced (e.g. cron-job.org timeout
 * dropped to 30s → set this to ~20s).
 */
const SWEEP_TOTAL_BUDGET_MS = 35_000;

/**
 * A stale-pending refund the sweep cannot terminalise (Stripe still
 * `pending`/`requires_action`, or the row has no `processor_refund_id`)
 * escalates to an ops signal once older than this. Signal ONLY — never a
 * state change; the row stays `pending`.
 */
const ESCALATION_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Upper bound on `olderThanHours` — prevents a pathological query (e.g.
 * `olderThanHours=8760` listing every pending refund ever) that risks a
 * Vercel function timeout.
 */
const MAX_OLDER_THAN_HOURS = 720; // 30 days

/**
 * Sentinel thrown to roll the per-row tx back when the F4 credit-note
 * bridge declines on the `succeeded` path (Stripe DEFINITIVELY confirmed
 * succeeded, so we must NOT mark the refund failed). The row stays pending
 * for the next sweep / webhook. `constructor.name` only surfaces in the
 * row-skip warn — no PII leaks.
 */
class SweepFinalizeError extends Error {
  constructor(readonly detail: string) {
    super('sweep refund finalize failed');
    this.name = 'SweepFinalizeError';
  }
}

/**
 * Classify the retrieved Stripe refund status into the three transition
 * classes. Anything non-terminal (`pending`, `requires_action`, an
 * unexpected string, or a null-coerced `'pending'` per A.8) maps to
 * `'skip'` — the safe default: NEVER finalise (book a CN or mark failed)
 * on a non-terminal status.
 */
type RetrievedClass =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed'; readonly status: 'failed' | 'canceled' }
  | { readonly kind: 'skip' };
function classifyRetrieved(status: string): RetrievedClass {
  if (status === 'succeeded') return { kind: 'succeeded' };
  if (status === 'failed' || status === 'canceled') {
    return { kind: 'failed', status };
  }
  return { kind: 'skip' };
}

/** A row from `listPendingOlderThan`. */
type StaleRefundRow = Awaited<
  ReturnType<RefundsRepo['listPendingOlderThan']>
>[number];

/**
 * Per-`retrieveRefund` timeout wrapper. Resolves the sentinel (never
 * rejects) so the caller branches without a try/catch; the underlying
 * Stripe promise is abandoned (Stripe is idempotent + a pure read, so a
 * late resolution is harmless). Always clears the timer.
 */
const RETRIEVE_TIMED_OUT = Symbol('retrieve-timed-out');
async function retrieveWithTimeout(
  gateway: ProcessorGatewayPort,
  refundId: string,
  stripeAccount: string,
  timeoutMs: number,
): Promise<Result<RetrievedRefund, ProcessorGatewayError> | typeof RETRIEVE_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<typeof RETRIEVE_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(RETRIEVE_TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([
      gateway.retrieveRefund(refundId, stripeAccount),
      timeoutP,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Escalate a not-terminalisable stale row if it has aged past the
 * threshold. Signal only (metric + warn) — NO state change. Returns
 * `true` when it escalated (so the caller can count it).
 */
function maybeEscalate(
  logger: LoggerPort,
  tenantId: string,
  row: StaleRefundRow,
  nowMs: number,
  reason:
    | 'stripe_pending'
    | 'missing_processor_refund_id'
    | 'credit_note_bridge_declined',
): boolean {
  const ageMs = nowMs - row.initiatedAt.getTime();
  if (ageMs <= ESCALATION_AGE_MS) return false;
  logger.warn('sweep_stale_pending_refunds.escalation', {
    tenantId,
    refundId: row.id,
    paymentId: row.paymentId,
    ageDays: Math.floor(ageMs / DAY_MS),
    reason,
  });
  paymentsMetrics.stalePendingRefundEscalated(tenantId);
  return true;
}

export interface SweepStalePendingRefundsInput {
  readonly tenantId: string;
  readonly olderThanHours?: number; // default 24
  readonly requestId: string | null;
}

export interface SweepStalePendingRefundsOutput {
  readonly sweptCount: number;
  readonly skippedCount: number;
  /**
   * Subset of `skippedCount`: stale rows that could not be terminalised
   * (Stripe still pending / no processor id) AND aged past
   * `ESCALATION_AGE_MS` → an ops manual-reconciliation signal fired.
   */
  readonly escalatedCount: number;
  readonly cutoff: string; // ISO
}

export type SweepStalePendingRefundsError = {
  readonly code: 'sweep_failed';
  readonly cause: string;
};

export interface SweepStalePendingRefundsDeps {
  readonly refundsRepo: RefundsRepo;
  readonly paymentsRepo: PaymentsRepo;
  /** A.14 — resolves the tenant's Stripe Connect account for `retrieveRefund`. */
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  /** A.14 — reads the real refund status from Stripe. */
  readonly processorGateway: ProcessorGatewayPort;
  /** A.14 — `finalizeSucceededRefund`'s idempotent F4 credit-note dependency. */
  readonly invoicingBridge: InvoicingBridgePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /**
   * Logger threaded as a port (Constitution Principle III — Application
   * layer must not import framework adapters). Defaults to `noopLogger`;
   * the cron-route composition root wires the real `paymentsLogger`.
   */
  readonly logger?: LoggerPort;
}

export async function sweepStalePendingRefunds(
  deps: SweepStalePendingRefundsDeps,
  input: SweepStalePendingRefundsInput,
): Promise<Result<SweepStalePendingRefundsOutput, SweepStalePendingRefundsError>> {
  const olderThanHours = input.olderThanHours ?? 24;
  if (olderThanHours <= 0 || olderThanHours > MAX_OLDER_THAN_HOURS) {
    return err({
      code: 'sweep_failed',
      cause: `olderThanHours must be 1–${MAX_OLDER_THAN_HOURS}`,
    });
  }
  const logger = deps.logger ?? noopLogger;
  const nowMs = deps.clock.nowMs();
  const cutoff = new Date(nowMs - olderThanHours * 60 * 60 * 1000);

  // Resolve the tenant's Stripe Connect account ONCE — `retrieveRefund` is
  // scoped to it. The cron only sweeps tenants with online_payment_enabled,
  // so a settings row is expected; a missing row is a misconfiguration the
  // route logs + counts as a tenant error.
  let stripeAccount: string;
  try {
    const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);
    if (settings === null) {
      return err({ code: 'sweep_failed', cause: 'tenant_settings_missing' });
    }
    stripeAccount = settings.processorAccountId;
  } catch (cause) {
    return err({
      code: 'sweep_failed',
      cause: cause instanceof Error ? cause.constructor.name : 'unknown',
    });
  }

  // Read phase — own short tx. Each row is then processed in its OWN write
  // tx below (Postgres aborts a tx on the first statement error, so a single
  // shared tx would degenerate after one bad row).
  let stale: readonly StaleRefundRow[];
  try {
    stale = await deps.paymentsRepo.withTx((tx) =>
      deps.refundsRepo.listPendingOlderThan(tx, input.tenantId, cutoff),
    );
  } catch (cause) {
    // constructor.name only — Postgres errors can carry SQL fragments /
    // column names / partial values per the project log-redact contract.
    return err({
      code: 'sweep_failed',
      cause: cause instanceof Error ? cause.constructor.name : 'unknown',
    });
  }

  // Row cap (M-i) — bound external calls per run; excess deferred to the
  // next idempotent sweep. Logged, never silently dropped.
  let batch = stale;
  if (stale.length > MAX_STALE_REFUNDS_PER_SWEEP) {
    logger.warn('sweep_stale_pending_refunds.row_cap_truncated', {
      tenantId: input.tenantId,
      total: stale.length,
      cap: MAX_STALE_REFUNDS_PER_SWEEP,
      deferred: stale.length - MAX_STALE_REFUNDS_PER_SWEEP,
    });
    batch = stale.slice(0, MAX_STALE_REFUNDS_PER_SWEEP);
  }

  let sweptCount = 0;
  let skippedCount = 0;
  let escalatedCount = 0;
  const startMs = deps.clock.nowMs();

  for (let i = 0; i < batch.length; i++) {
    const row = batch[i]!;
    const iterNowMs = deps.clock.nowMs();

    // Total wall-clock budget guard (M-i) — stop starting new external
    // retrieves once the cumulative budget is spent. Remaining rows are
    // durable (each processed in its own committed tx) and are picked up by
    // the next sweep. Logged, never silent.
    if (iterNowMs - startMs > SWEEP_TOTAL_BUDGET_MS) {
      logger.warn('sweep_stale_pending_refunds.budget_deferred', {
        tenantId: input.tenantId,
        processed: i,
        deferred: batch.length - i,
        budgetMs: SWEEP_TOTAL_BUDGET_MS,
      });
      break;
    }

    // A NULL processor_refund_id row cannot be reconciled against Stripe
    // (rare window: `createRefund` succeeded but the attach tx crashed).
    // NEVER blind-fail — a real Stripe refund may exist. Skip + escalate if
    // aged; ops reconciles manually via the Stripe dashboard.
    if (row.processorRefundId === null) {
      skippedCount += 1;
      if (maybeEscalate(logger, input.tenantId, row, iterNowMs, 'missing_processor_refund_id')) {
        escalatedCount += 1;
      }
      continue;
    }
    const processorRefundId = row.processorRefundId;

    // Retrieve the real Stripe outcome OUTSIDE any row lock (external I/O),
    // bounded by a per-call timeout.
    const retrieved = await retrieveWithTimeout(
      deps.processorGateway,
      processorRefundId,
      stripeAccount,
      RETRIEVE_TIMEOUT_MS,
    );
    if (retrieved === RETRIEVE_TIMED_OUT) {
      skippedCount += 1;
      logger.warn('sweep_stale_pending_refunds.retrieve_timeout', {
        tenantId: input.tenantId,
        refundId: row.id,
        paymentId: row.paymentId,
        timeoutMs: RETRIEVE_TIMEOUT_MS,
      });
      continue;
    }
    if (!retrieved.ok) {
      // Retrieve error → skip + count, no state change. `kind` is the
      // bounded gateway discriminator (never `reason` — PCI: may embed
      // account ids / key prefixes).
      skippedCount += 1;
      logger.warn('sweep_stale_pending_refunds.retrieve_failed', {
        tenantId: input.tenantId,
        refundId: row.id,
        paymentId: row.paymentId,
        errKind: retrieved.error.kind,
      });
      continue;
    }

    const cls = classifyRetrieved(retrieved.value.status);
    if (cls.kind === 'skip') {
      // Stripe still pending / requires_action (or a null-coerced 'pending',
      // A.8) → NEVER mark failed. Skip + escalate if aged.
      skippedCount += 1;
      // A.16 (H-e) — the refund is confirmed STILL awaiting the async
      // `charge.refund.updated` webhook. Emit the monitoring signal on every
      // still-pending skip (independent of the aged-escalation gate below); a
      // sustained rate>0 flags a disabled subscription (refunds hang).
      paymentsMetrics.refundPendingAwaitingProcessor(input.tenantId);
      if (maybeEscalate(logger, input.tenantId, row, iterNowMs, 'stripe_pending')) {
        escalatedCount += 1;
      }
      continue;
    }

    // Terminal Stripe outcome — finalise in a per-row tx. Lock the refund
    // row FOR UPDATE FIRST (A.11 invariant: refund-row → payment-row) via
    // its processor id (the same lock method the webhook reconciler uses),
    // then re-check it is still `pending` (a concurrent webhook / Phase-B may
    // have finalised it between our list-read and now → skip, NO false audit
    // → RR-1 invariant preserved by the under-lock re-check).
    try {
      const outcome = await deps.paymentsRepo.withTx(
        async (tx): Promise<'swept' | 'skip'> => {
          const locked = await deps.refundsRepo.lockForUpdateByProcessorRefundId(
            tx,
            input.tenantId,
            processorRefundId,
          );
          if (locked === null || locked.status !== 'pending') {
            // Concurrently finalised (or vanished) — idempotent skip. NO
            // audit emitted → no false stale/refund audit on a lost race.
            return 'skip';
          }

          if (cls.kind === 'succeeded') {
            // Shared finaliser in WEBHOOK mode (omit `paymentNextStatus`):
            // idempotent F4 CN + refund flip (expectedCurrentStatus guard) +
            // SB-1 self-lock/aggregate/recovery of the payment. The refund
            // row is already FOR-UPDATE locked above → lock order stays
            // refund → payment.
            const finalized = await finalizeSucceededRefund(deps, tx, {
              refundId: locked.id,
              tenantId: input.tenantId,
              paymentId: locked.paymentId,
              invoiceId: locked.invoiceId,
              amountSatang: locked.amountSatang,
              reason: locked.reason,
              processorRefundId,
              // SECURITY / FK: the F4 credit-note `issued_by_user_id` FKs to
              // users(id); the sweep is unattended so it must NOT attribute
              // the CN to the original human initiator. Reuse the seeded
              // Stripe-webhook system actor (same as processRefundUpdated's
              // identical reconcile) rather than add a new seeded actor. The
              // `path:'sweep_recovery'` discriminator preserves the "sweep,
              // not webhook" forensic signal on the refund_succeeded audit.
              actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
              requestId: input.requestId,
              path: 'sweep_recovery',
            });
            if (!finalized.ok) {
              // F4 CN bridge declined. Stripe DEFINITIVELY says succeeded, so
              // we must NOT mark the refund failed. Throw to roll the per-row
              // tx back → the row stays pending → the next sweep (or the
              // webhook) retries; the CN bridge is idempotent so a retry
              // reconciles cleanly.
              throw new SweepFinalizeError(finalized.error.code);
            }
            if (finalized.value.siblingWon) {
              // A concurrent writer finalised first — it owns the CN, the
              // payment flip, the `refund_succeeded` audit AND the metric.
              return 'skip';
            }
            paymentsMetrics.refundSucceededCount(input.tenantId);
            return 'swept';
          }

          // cls.kind === 'failed' (Stripe settled failed | canceled). Flip
          // the locked-pending row → failed (NO credit note — no §86/4
          // receipt was reduced) + forensic audit, inline in this tx
          // (issueRefund's `finaliseFailedRefund` opens its OWN tx, which
          // would break the one-tx atomicity — mirror processRefundUpdated's
          // inline flip). The row is FOR-UPDATE-locked + read `pending`
          // above, so a plain throw-on-zero updateStatus is correct.
          const failureReasonCode = `stripe_refund_${cls.status}`;
          const completedAt = new Date(deps.clock.nowMs());
          await deps.refundsRepo.updateStatus(tx, {
            refundId: locked.id,
            tenantId: input.tenantId,
            nextStatus: 'failed',
            failureReasonCode,
            processorRefundId,
            completedAt,
          });
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'refund_failed',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Stale pending refund ${locked.id} settled ${cls.status} on Stripe (${processorRefundId}) — recovered by stale-pending sweep`,
            payload: {
              refund_id: locked.id,
              payment_id: locked.paymentId,
              invoice_id: locked.invoiceId,
              failure_reason_code: failureReasonCode,
              processor_refund_id: processorRefundId,
            },
            retentionYears: retentionFor('refund_failed'),
          });
          paymentsMetrics.refundFailedCount(input.tenantId, failureReasonCode);
          return 'swept';
        },
      );
      if (outcome === 'swept') sweptCount += 1;
      else skippedCount += 1;
    } catch (cause) {
      // Per-row tx rolled back (SweepFinalizeError on F4 decline OR a DB
      // fault). Row stays pending for the next sweep. constructor.name only
      // (no `.message`) — Postgres/Stripe errors can carry SQL params /
      // partial values per the log-redact contract.
      logger.warn('sweep_stale_pending_refunds.row_skipped', {
        tenantId: input.tenantId,
        refundId: row.id,
        paymentId: row.paymentId,
        errKind: cause instanceof Error ? cause.constructor.name : 'unknown',
      });
      skippedCount += 1;
      // Round-2 review fix (#35): a `SweepFinalizeError` is the F4 credit-note
      // bridge DECLINING on a Stripe-CONFIRMED `succeeded` refund (FEATURE_F4_
      // INVOICING off, invoice hard-deleted, or a durable F4 fault). The money
      // is refunded at Stripe but NO §86/4/§87 credit note is booked, and the
      // row retries forever. Escalate it once aged past the threshold — the
      // SAME ops signal the two other stuck-forever classes (missing_processor_
      // refund_id / stripe_pending) already fire. A transient decline that
      // clears on the next sweep never ages in, so no false page. A generic DB
      // fault (non-SweepFinalizeError) is NOT escalated — it is most likely a
      // transient Neon blip that the next sweep retries cleanly.
      if (cause instanceof SweepFinalizeError) {
        if (
          maybeEscalate(
            logger,
            input.tenantId,
            row,
            iterNowMs,
            'credit_note_bridge_declined',
          )
        ) {
          escalatedCount += 1;
        }
      }
    }
  }

  return ok({
    sweptCount,
    skippedCount,
    escalatedCount,
    cutoff: cutoff.toISOString(),
  });
}
