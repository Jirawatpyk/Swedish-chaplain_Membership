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
 *        - retrieve error/timeout → skip + count, no state change; escalate
 *                               (`retrieve_failed`) if aged.
 *   3. #50 — a row with a NULL `processor_refund_id` (an orphan) is looked up
 *      by its payment intent (`resolveOrphan`): one clean match is attached
 *      and reconciled as in step 2; a lookup that proves Stripe made no
 *      refund (`proveNoProcessorRefund`) closes it `failed`; a conflicting
 *      match escalates at once; anything else is skipped and escalated if
 *      aged, for ops to reconcile by hand.
 *
 * **Blind-fail is fully removed** — the ONLY paths to `failed` are a
 * Stripe-confirmed `failed|canceled`, and #50's processor-proven absence. The `stale_pending_refund_detected`
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
 * Runs hourly via Vercel Cron (`7 * * * *`) at
 * `/api/cron/sweep-stale-pending-refunds`. Idempotent — dual-firing safe.
 * Per-tenant; the cron iterates tenants and calls once each.
 *
 * Raised from daily by money-remediation Task 6, which leaves MORE rows
 * `pending` on purpose (a processor-settled refund whose credit note could not
 * be booked is no longer falsely marked `failed`), and a pending row blocks
 * every subsequent refund on that payment. NOTE the cadence is not the
 * governor: `olderThanHours` defaults to 24 below, so a row is not eligible
 * until it is a day old. Hourly takes the worst case ~48h → ~25h, not to ~1h.
 * See the cron route's docstring for why the floor was left alone.
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
import {
  proveNoProcessorRefund,
  proveProcessorSettledFailed,
} from '../../domain/settlement/money-moved';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { STALE_REFUND_ESCALATION_AGE_MS as ESCALATION_AGE_MS } from '../../domain/refund-escalation';
import { finalizeSucceededRefund } from './_finalize-succeeded-refund';
import { commitTx, rollbackTx, runTxDecided } from '../settlement/tx-decision';
import { paymentsMetrics, type StalePendingRefundEscalationReason } from '@/lib/metrics';
import { errKind } from '@/lib/log-id';

// --- M-i bounds (module consts per Constitution X) --------------------------
// Sized against the cron route's Vercel function budget (`maxDuration=60`)
// AND the cron-job.org request timeout (60s per docs/runbooks/cron-jobs.md).

/**
 * Hard cap on refund rows processed per tenant per run. Excess rows are
 * left for the next (idempotent) sweep — logged, never silently dropped.
 */
const MAX_STALE_REFUNDS_PER_SWEEP = 50;

/**
 * Per-Stripe-call wall-clock ceiling (`retrieveRefund`, and #50's
 * `listRefundsForPaymentIntent`). The Stripe SDK's own default timeout is
 * ~80 s — far beyond a serverless budget — so we bound each external call
 * ourselves; a timeout is treated as a call error (skip + count).
 */
const STRIPE_CALL_TIMEOUT_MS = 8_000;

/**
 * Total wall-clock budget across all retrieves in one tenant run. When
 * exceeded, the loop stops starting new rows (remaining → next sweep) and
 * logs the deferral.
 *
 * **Review-hardening (headroom math).** The guard only stops the loop
 * BEFORE *starting* a new row — the row that was already in flight when the
 * budget tipped over still pays its own (retrieve + finalise) cost:
 * `STRIPE_CALL_TIMEOUT_MS` (≤8s) for the Stripe read, plus
 * `finalizeSucceededRefund` on the `succeeded` path (F4 credit-note render +
 * Blob upload — effectively unbounded on a bad day). A kill mid-finalise is
 * safe (tx rolls back → row stays `pending` → next sweep reconciles; the CN
 * bridge is idempotent) but wastes the external Stripe call, so budget
 * enough headroom that the last row's tail usually finishes:
 *
 *   35s budget + ≤8s last retrieve + finalize allowance < 60s maxDuration
 *
 * #50 — an orphan row makes TWO Stripe calls (the intent check, then the
 * list) and is then reconciled from the listed entry, with no retrieve. The
 * budget is re-checked between the two calls, so the in-flight tail is still
 * one call: a row whose intent check tips the budget is left whole for the
 * next run.
 *
 * This is coupled to BOTH the route's `maxDuration=60`
 * (`src/app/api/cron/sweep-stale-pending-refunds/route.ts`) AND the
 * cron-job.org per-job request timeout for this endpoint (currently 60s per
 * `docs/runbooks/stale-pending-refund-sweep.md`) — LOWER this const in
 * lockstep if either of those is ever reduced (e.g. cron-job.org timeout
 * dropped to 30s → set this to ~20s).
 */
const SWEEP_TOTAL_BUDGET_MS = 35_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Upper bound on `olderThanHours` — prevents a pathological query (e.g.
 * `olderThanHours=8760` listing every pending refund ever) that risks a
 * Vercel function timeout.
 */
const MAX_OLDER_THAN_HOURS = 720; // 30 days

/**
 * Ops-facing `errKind` label for the F4-credit-note-decline row skip.
 *
 * Preserved VERBATIM from the `SweepFinalizeError` sentinel this branch used
 * to throw (money-remediation Task 2 replaced the throw with a
 * `rollbackTx(...)` decision). It is a log label that dashboards, the runbook
 * and `sweep-stale-pending-refunds.test.ts` all key on — the retrofit's
 * contract is zero observable change, so the string stays put. Renaming it is
 * a separate, deliberate change once those consumers are checked.
 */
const DIVERGENCE_ERR_KIND = 'SweepFinalizeError';

/**
 * Per-row outcome carried out of the transaction.
 *
 * `terminal_divergence` is the F4-credit-note-bridge decline on a
 * Stripe-CONFIRMED `succeeded` refund: the money HAS moved, so the row must
 * NOT be marked failed, and the transaction must unwind so the next sweep (or
 * the webhook) can retry against the idempotent bridge.
 *
 * It travels as a VALUE rather than the old thrown sentinel so the outer
 * `catch` no longer has to tell a deliberate refusal apart from a Neon fault
 * by `instanceof` — `catch` now means "something broke", full stop.
 */
type SweepRowOutcome =
  | { readonly kind: 'swept' }
  | { readonly kind: 'skip' }
  | {
      readonly kind: 'terminal_divergence';
      /**
       * The declining bridge error code. Carried but deliberately NOT logged,
       * because the sentinel it replaces also carried an unread `detail` and
       * this retrofit changes no observable behaviour. Surfacing it is a
       * free win for the forensic-emit task.
       */
      readonly detail: string;
    };

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
 * Per-Stripe-call timeout wrapper (both calls are pure reads). Resolves the
 * sentinel (never rejects) so the caller branches without a try/catch; the
 * underlying Stripe promise is abandoned (a late resolution of a read is
 * harmless). Always clears the timer.
 */
const CALL_TIMED_OUT = Symbol('stripe-call-timed-out');
async function withTimeout<T>(
  call: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof CALL_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<typeof CALL_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(CALL_TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([call, timeoutP]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function retrieveWithTimeout(
  gateway: ProcessorGatewayPort,
  refundId: string,
  stripeAccount: string,
  timeoutMs: number,
): Promise<Result<RetrievedRefund, ProcessorGatewayError> | typeof CALL_TIMED_OUT> {
  return withTimeout(gateway.retrieveRefund(refundId, stripeAccount), timeoutMs);
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
  reason: StalePendingRefundEscalationReason,
): boolean {
  const ageMs = nowMs - row.initiatedAt.getTime();
  if (ageMs <= ESCALATION_AGE_MS) return false;
  escalate(logger, tenantId, row, ageMs, reason);
  return true;
}

/** The escalation signal itself (metric + warn), with no age gate. */
function escalate(
  logger: LoggerPort,
  tenantId: string,
  row: StaleRefundRow,
  ageMs: number,
  reason: StalePendingRefundEscalationReason,
): void {
  logger.warn('sweep_stale_pending_refunds.escalation', {
    tenantId,
    refundId: row.id,
    paymentId: row.paymentId,
    ageDays: Math.floor(ageMs / DAY_MS),
    reason,
  });
  paymentsMetrics.stalePendingRefundEscalated(tenantId, reason);
}

/** #50 — what the orphan lookup decided for one row. */
type OrphanResolution =
  /** Attached; `status` is the listed refund's, so no second Stripe call. */
  | { readonly kind: 'attached'; readonly processorRefundId: string; readonly status: string }
  | { readonly kind: 'closed' }
  /** Another writer got there first (webhook back-fill, a dual firing). */
  | { readonly kind: 'lost_race' }
  /**
   * Stripe's refunds naming this row disagree with it (two or more, one at
   * another amount, or one naming a row already closed on a no-money proof):
   * a possible double refund or a forged marker.
   */
  | { readonly kind: 'marker_conflict' }
  /** The run's budget ran out between the two Stripe calls. */
  | { readonly kind: 'deferred' }
  | { readonly kind: 'unresolved' };

/** The failure reason a row closed by the orphan lookup carries. */
const NO_PROCESSOR_REFUND = 'no_processor_refund';

/**
 * #50 — resolve an orphan row (NULL processor_refund_id) against Stripe's own
 * list of refunds for the parent payment intent. Writes only on a single
 * clean match (attach) or a proven absence (close `failed`); see the call
 * site. Two Stripe calls at most: the intent check, then the list.
 */
async function resolveOrphan(
  deps: SweepStalePendingRefundsDeps,
  input: SweepStalePendingRefundsInput,
  row: StaleRefundRow,
  stripeAccount: string,
  settingsEnvironment: string,
  budgetSpent: () => boolean,
  logger: LoggerPort,
): Promise<OrphanResolution> {
  const ids = { tenantId: input.tenantId, refundId: row.id, paymentId: row.paymentId };

  // Stripe's answer is about the account the current keys reach. A payment
  // taken under other keys (test → live, a reconnected account) is not in
  // that answer, so "no refund" from it would prove nothing. Two checks: the
  // environment it was taken in, and that the intent itself is found on this
  // account (payments carry no account id to compare).
  if (row.paymentProcessorEnvironment !== settingsEnvironment) {
    logger.warn('sweep_stale_pending_refunds.orphan_environment_mismatch', {
      ...ids,
      paymentEnvironment: row.paymentProcessorEnvironment,
      settingsEnvironment,
    });
    return { kind: 'unresolved' };
  }
  const intent = await withTimeout(
    deps.processorGateway.retrievePaymentIntent(row.paymentIntentId, stripeAccount),
    STRIPE_CALL_TIMEOUT_MS,
  );
  if (intent === CALL_TIMED_OUT || !intent.ok || intent.value.id !== row.paymentIntentId) {
    logger.warn('sweep_stale_pending_refunds.orphan_lookup_failed', {
      ...ids,
      step: 'intent',
      // `kind` only — never `reason` (PCI: may embed account ids).
      errKind:
        intent === CALL_TIMED_OUT ? 'timeout' : !intent.ok ? intent.error.kind : 'intent_id_mismatch',
    });
    return { kind: 'unresolved' };
  }
  // Keep the in-flight tail to one Stripe call: a row whose intent check
  // tipped the budget is left whole for the next run.
  if (budgetSpent()) return { kind: 'deferred' };

  const listed = await withTimeout(
    deps.processorGateway.listRefundsForPaymentIntent(row.paymentIntentId, stripeAccount),
    STRIPE_CALL_TIMEOUT_MS,
  );
  if (listed === CALL_TIMED_OUT || !listed.ok) {
    logger.warn('sweep_stale_pending_refunds.orphan_lookup_failed', {
      ...ids,
      step: 'list',
      errKind: listed === CALL_TIMED_OUT ? 'timeout' : listed.error.kind,
    });
    return { kind: 'unresolved' };
  }
  const matches = listed.value.refunds.filter((r) => r.appRefundId === row.id);

  const amountMatches = matches.length === 1 && matches[0]!.amountSatang === row.amountSatang;
  if (matches.length > 1 || (matches.length === 1 && !amountMatches)) {
    // Two Stripe refunds carrying one row's marker (money may have left
    // twice), or one at an amount the row did not ask for (the marker can be
    // typed into the Dashboard). Never pick one, never attach: a credit note
    // for the row's amount would not match the money that moved.
    logger.error('sweep_stale_pending_refunds.orphan_marker_conflict', {
      ...ids,
      matchCount: matches.length,
      amountMatches,
    });
    return { kind: 'marker_conflict' };
  }

  if (matches.length === 1) {
    const match = matches[0]!;
    // The same back-fill the webhook does (`_recognise-app-initiated-refund`),
    // under the same guard: re-read the row by its marker with
    // `processor_refund_id IS NULL`, and refuse a terminal row. The id is
    // stable per logical attempt, so a writer racing past the re-read writes
    // the same value. The row is then reconciled by the caller like any other.
    const { value: attached } = await runTxDecided<'lost_race' | 'terminal' | 'attached'>(
      deps.paymentsRepo,
      async (tx) => {
        const awaiting = await deps.refundsRepo.findAwaitingAttachByAppRefundId(
          tx,
          input.tenantId,
          row.id,
        );
        // Nothing written on either refusal: committing an empty tx is the
        // pre-existing behaviour of the sweep's skip arms.
        if (awaiting === null) return commitTx('lost_race');
        if (awaiting.status !== 'pending') {
          // Closed `failed` on a proof that no money moved, yet Stripe now
          // holds a refund naming it. The row is no longer pending, so no later
          // run revisits it: the caller escalates at once. The row keeps its
          // NULL id (never quietly overwritten).
          logger.error('sweep_stale_pending_refunds.orphan_match_on_terminal_row', {
            ...ids,
            processorRefundId: match.id,
            rowStatus: awaiting.status,
          });
          return commitTx('terminal');
        }
        await deps.refundsRepo.attachProcessorRefundId(tx, {
          refundId: row.id,
          tenantId: input.tenantId,
          processorRefundId: match.id,
        });
        return commitTx('attached');
      },
    );
    if (attached === 'lost_race') return { kind: 'lost_race' };
    if (attached === 'terminal') return { kind: 'marker_conflict' };
    logger.info('sweep_stale_pending_refunds.orphan_attached', {
      ...ids,
      processorRefundId: match.id,
    });
    return { kind: 'attached', processorRefundId: match.id, status: match.status };
  }

  // Every other refund must be one this payment already recorded. A refund
  // marked for some other row (copied metadata, a typo, a forged marker), or
  // with no marker at all, may be this row's money: it proves nothing.
  const { value: recordedIds } = await runTxDecided(deps.paymentsRepo, async (tx) =>
    commitTx(
      await deps.refundsRepo.listProcessorRefundIdsForPayment(tx, input.tenantId, row.paymentId),
    ),
  );
  const recorded = new Set(recordedIds);
  const unaccountedCount = listed.value.refunds.filter((r) => !recorded.has(r.id)).length;
  const rowAgeMs = deps.clock.nowMs() - row.initiatedAt.getTime();
  const proof = proveNoProcessorRefund({
    complete: listed.value.complete,
    matchCount: matches.length,
    unaccountedCount,
    rowAgeMs,
  });
  if (proof === null) {
    logger.warn('sweep_stale_pending_refunds.orphan_ambiguous', {
      ...ids,
      matchCount: matches.length,
      unaccountedCount,
      rowAgeMs,
      complete: listed.value.complete,
    });
    return { kind: 'unresolved' };
  }

  // Stripe holds no refund for this row: close it `failed`. No processor-id
  // lock exists, so both guards ride the UPDATE: still `pending`, and still
  // no processor id (a webhook back-fill meanwhile wins → zero rows → skip).
  const { value: closed } = await runTxDecided<boolean>(deps.paymentsRepo, async (tx) => {
    const updated = await deps.refundsRepo.updateStatus(tx, {
      refundId: row.id,
      tenantId: input.tenantId,
      nextStatus: 'failed',
      rejectionProof: proof,
      failureReasonCode: NO_PROCESSOR_REFUND,
      completedAt: new Date(deps.clock.nowMs()),
      expectedCurrentStatus: 'pending',
      expectProcessorRefundIdNull: true,
    });
    // Zero rows: another writer won; nothing was written.
    if (updated === null) return commitTx(false);
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'refund_failed',
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      summary: `Stale pending refund ${row.id} has no refund at Stripe for its payment intent — closed by stale-pending sweep`,
      payload: {
        refund_id: row.id,
        payment_id: row.paymentId,
        invoice_id: row.invoiceId,
        failure_reason_code: NO_PROCESSOR_REFUND,
      },
      retentionYears: retentionFor('refund_failed'),
    });
    return commitTx(true);
  });
  if (!closed) return { kind: 'lost_race' };
  paymentsMetrics.refundFailedCount(input.tenantId, NO_PROCESSOR_REFUND);
  return { kind: 'closed' };
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
  let settingsEnvironment: string;
  try {
    const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);
    if (settings === null) {
      return err({ code: 'sweep_failed', cause: 'tenant_settings_missing' });
    }
    stripeAccount = settings.processorAccountId;
    settingsEnvironment = settings.processorEnvironment;
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

  rows: for (let i = 0; i < batch.length; i++) {
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

    // #50 — a NULL processor_refund_id row (an orphan: the Stripe call's
    // outcome was unknown, or it succeeded and the attach tx crashed). Ask
    // Stripe which refunds it holds for the payment intent:
    //   - exactly one names this row, at its amount → attach its id and
    //     reconcile it below from the listed status (no second call);
    //   - a complete list with none → Stripe never made it: close `failed`
    //     under that proof, which unblocks the payment;
    //   - a conflicting match (several, another amount, a terminal row) →
    //     escalate at once;
    //   - anything else (more pages, an unaccounted refund, an error, a
    //     timeout) → NEVER guess. Skip, and escalate once aged.
    let processorRefundId: string;
    let stripeStatus: string;
    if (row.processorRefundId === null) {
      let resolved: OrphanResolution;
      try {
        resolved = await resolveOrphan(
          deps,
          input,
          row,
          stripeAccount,
          settingsEnvironment,
          () => deps.clock.nowMs() - startMs > SWEEP_TOTAL_BUDGET_MS,
          logger,
        );
      } catch (cause) {
        // A fault on the attach or close tx: this row only, like the per-row
        // catch below. constructor.name only. Still escalated once aged: a
        // blip never lasts three days, so an aged fault is a permanent one
        // (a constraint refusing the write) that must not go silent.
        logger.warn('sweep_stale_pending_refunds.row_skipped', {
          tenantId: input.tenantId,
          refundId: row.id,
          paymentId: row.paymentId,
          errKind: errKind(cause),
        });
        skippedCount += 1;
        if (maybeEscalate(logger, input.tenantId, row, iterNowMs, 'missing_processor_refund_id')) {
          escalatedCount += 1;
        }
        continue;
      }
      switch (resolved.kind) {
        case 'attached':
          // Reconciled from the listed entry: its id, status and amount (the
          // amount already matched the row) are what a retrieve would return.
          processorRefundId = resolved.processorRefundId;
          stripeStatus = resolved.status;
          break;
        case 'deferred':
          skippedCount += 1;
          logger.warn('sweep_stale_pending_refunds.budget_deferred', {
            tenantId: input.tenantId,
            processed: i,
            deferred: batch.length - i,
            budgetMs: SWEEP_TOTAL_BUDGET_MS,
          });
          break rows;
        case 'closed':
          sweptCount += 1;
          continue;
        case 'lost_race':
          // Another writer handled it; the row is no longer an orphan.
          skippedCount += 1;
          continue;
        case 'marker_conflict':
          // A possible double refund or forged marker: escalate now, whatever its age.
          skippedCount += 1;
          escalate(
            logger,
            input.tenantId,
            row,
            iterNowMs - row.initiatedAt.getTime(),
            'orphan_marker_conflict',
          );
          escalatedCount += 1;
          continue;
        case 'unresolved':
          skippedCount += 1;
          if (maybeEscalate(logger, input.tenantId, row, iterNowMs, 'missing_processor_refund_id')) {
            escalatedCount += 1;
          }
          continue;
        default: {
          const _exhaustive: never = resolved;
          void _exhaustive;
          skippedCount += 1;
          continue;
        }
      }
    } else {
      processorRefundId = row.processorRefundId;

      // Retrieve the real Stripe outcome OUTSIDE any row lock (external I/O),
      // bounded by a per-call timeout.
      const retrieved = await retrieveWithTimeout(
        deps.processorGateway,
        processorRefundId,
        stripeAccount,
        STRIPE_CALL_TIMEOUT_MS,
      );
      if (retrieved === CALL_TIMED_OUT) {
        skippedCount += 1;
        logger.warn('sweep_stale_pending_refunds.retrieve_timeout', {
          tenantId: input.tenantId,
          refundId: row.id,
          paymentId: row.paymentId,
          timeoutMs: STRIPE_CALL_TIMEOUT_MS,
        });
        if (maybeEscalate(logger, input.tenantId, row, iterNowMs, 'retrieve_failed')) {
          escalatedCount += 1;
        }
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
        // A retrieve that keeps failing (e.g. the amount guard on a refund
        // Stripe made at an amount we did not expect) would otherwise leave the
        // row pending, and the payment blocked, with no signal at all.
        if (maybeEscalate(logger, input.tenantId, row, iterNowMs, 'retrieve_failed')) {
          escalatedCount += 1;
        }
        continue;
      }
      stripeStatus = retrieved.value.status;
    }

    const cls = classifyRetrieved(stripeStatus);
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
      const outcome = await runTxDecided<SweepRowOutcome>(
        deps.paymentsRepo,
        async (tx) => {
          const locked = await deps.refundsRepo.lockForUpdateByProcessorRefundId(
            tx,
            input.tenantId,
            processorRefundId,
          );
          if (locked === null || locked.status !== 'pending') {
            // Concurrently finalised (or vanished) — idempotent skip. NO
            // audit emitted → no false stale/refund audit on a lost race.
            // Committed (not rolled back) to preserve the pre-retrofit
            // behaviour exactly; nothing was written either way.
            return commitTx({ kind: 'skip' });
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
              // Track B — off the locked row, which pinned it in Phase A.
              // REQUIRED by the finaliser rather than optional: a silent `null`
              // default here would send a waived refund into the credit-note
              // bridge, which refuses it, stranding a Stripe-settled refund
              // `pending` forever — the exact F-3 shape, recreated by the sweep
              // that exists to clean F-3 up.
              creditNoteWaiverReason: locked.creditNoteWaiverReason,
              // 0306 — pinned in Phase A; forwarded to the F4 credit note.
              membershipEffect: locked.membershipEffect,
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
              // we must NOT mark the refund failed. Unwind the per-row tx →
              // the row stays pending → the next sweep (or the webhook)
              // retries; the CN bridge is idempotent so a retry reconciles
              // cleanly.
              //
              // ── NOTE FOR TASK 4 ─────────────────────────────────────────
              // Tasks 3 and 6 have both landed and NEITHER fired this.
              // Task 3's forensic emits are `null`-tx emits in
              // `confirm-payment.ts`'s Phase-B catches — a different file,
              // and outside any transaction, so trigger (a) below is still
              // unclaimed. No sweep-level fake-tx test was written, because
              // with nothing written before the `err` it would assert
              // nothing.
              // This `rollbackTx` is currently DEFENSIVE, not load-bearing:
              // `finalizeSucceededRefund`'s only `return err` is at
              // `_finalize-succeeded-refund.ts:203`, and its first local write
              // is at `:240`, so when the bridge declines NOTHING has been
              // written yet and commit-vs-rollback is observationally
              // identical. That is why the retrofit was behaviour-neutral.
              //
              // It becomes load-bearing the moment any write is issued before
              // that `err`. Concrete triggers:
              //   (a) Task 3 adding a forensic audit emit inside this tx
              //       before the bridge call;
              //   (b) Task 6 adding a guard or `updateStatus` before it;
              //   (c) anyone moving the CN bridge off step 1.
              //
              // When that happens, write the sweep-level fake-tx test
              // (`tests/support/fake-tx.ts`): assert via `expectRolledBack`
              // that `discarded` CONTAINS the write and `committed` does NOT —
              // always both halves, because a bare `committed === []` also
              // passes when the stub never received the fake handle. Then
              // mutate `rollbackTx` → `commitTx` and confirm it turns RED. If
              // it stays green the stub is not getting the fake handle; fix
              // the wiring before trusting any green.
              // ────────────────────────────────────────────────────────────
              return rollbackTx({
                kind: 'terminal_divergence',
                detail: finalized.error.code,
              });
            }
            if (finalized.value.siblingWon) {
              // A concurrent writer finalised first — it owns the CN, the
              // payment flip, the `refund_succeeded` audit AND the metric.
              return commitTx({ kind: 'skip' });
            }
            paymentsMetrics.refundSucceededCount(input.tenantId);
            return commitTx({ kind: 'swept' });
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
            // `retrieveRefund` just asked Stripe directly and got a terminal
            // failed/canceled — the funds are back on the platform balance.
            // A proven rejection (money-remediation F-3), evidenced by the
            // processor rather than by a refused request.
            rejectionProof: proveProcessorSettledFailed(cls.status),
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
          return commitTx({ kind: 'swept' });
        },
      );

      if (outcome.value.kind === 'terminal_divergence') {
        // Per-row tx unwound by decision: the F4 credit-note bridge DECLINED
        // on a Stripe-CONFIRMED `succeeded` refund (FEATURE_F4_INVOICING off,
        // invoice hard-deleted, or a durable F4 fault). The money is refunded
        // at Stripe but NO §86/4/§87 credit note is booked, and the row
        // retries forever.
        //
        // Round-2 review fix (#35): escalate once aged past the threshold —
        // the SAME ops signal the two other stuck-forever classes
        // (missing_processor_refund_id / stripe_pending) already fire. A
        // transient decline that clears on the next sweep never ages in, so
        // no false page.
        logger.warn('sweep_stale_pending_refunds.row_skipped', {
          tenantId: input.tenantId,
          refundId: row.id,
          paymentId: row.paymentId,
          errKind: DIVERGENCE_ERR_KIND,
        });
        skippedCount += 1;
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
      } else if (outcome.value.kind === 'swept') {
        sweptCount += 1;
      } else {
        skippedCount += 1;
      }
    } catch (cause) {
      // Reaching here now means a GENUINE fault — the deliberate F4-decline
      // refusal is a value, handled above. Row stays pending for the next
      // sweep. constructor.name only (no `.message`) — Postgres/Stripe errors
      // can carry SQL params / partial values per the log-redact contract.
      //
      // NOT escalated: a generic DB fault is most likely a transient Neon
      // blip that the next sweep retries cleanly.
      logger.warn('sweep_stale_pending_refunds.row_skipped', {
        tenantId: input.tenantId,
        refundId: row.id,
        paymentId: row.paymentId,
        errKind: cause instanceof Error ? cause.constructor.name : 'unknown',
      });
      skippedCount += 1;
    }
  }

  return ok({
    sweptCount,
    skippedCount,
    escalatedCount,
    cutoff: cutoff.toISOString(),
  });
}
