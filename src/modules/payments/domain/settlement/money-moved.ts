/**
 * Money-exit classification (money-remediation Task 2).
 *
 * ## What this encodes
 *
 * A refund row marked `failed` is a claim about the world: **no money left
 * the account.** Downstream logic treats it as exactly that — `failed` rows
 * are excluded from `succeeded_sum_satang` and do not trip the
 * `refund_in_progress` guard. So a wrong `failed` does
 * not merely mislabel a row; it clears every guard that would stop the next
 * attempt from paying the customer a second time (finding F-3).
 *
 * Only one gateway failure kind supports that claim:
 *
 * | kind                   | exit       | why |
 * | ---------------------- | ---------- | --- |
 * | `permanent`            | `rejected` | the processor refused; nothing moved |
 * | `retryable`            | `unknown`  | the request may have landed and the response was lost |
 * | `idempotency_conflict` | `unknown`  | a request with that key already exists — possibly settled |
 *
 * An `unknown` exit must leave the row `pending` so the stale-pending sweep
 * can ask Stripe what actually happened. That machinery already exists; what
 * was missing is anything forcing the caller to notice the distinction.
 *
 * ## How the proof is meant to be used
 *
 * `RejectionProof` is unforgeable outside this module. Task 6 threads it
 * through `RefundsRepo.updateStatus`'s `nextStatus: 'failed'` overload, at
 * which point terminalising an `unknown` exit stops compiling instead of
 * merely being wrong.
 *
 * Pure Domain — zero framework imports (Principle III).
 */

/**
 * Processor failure kinds, mirrored from `ProcessorGatewayError['kind']`.
 *
 * Declared here rather than imported because Domain may not depend on
 * Application. The two are kept in lockstep by a compile-time assignability
 * assertion in `tests/unit/payments/domain/money-moved.test.ts` — if the port
 * grows a fourth kind, that test stops compiling and someone has to decide
 * which exit it maps to rather than it silently defaulting to `unknown`.
 */
export type ProcessorFailureKind = 'permanent' | 'retryable' | 'idempotency_conflict';

/**
 * The failure as reported by the gateway. `code` is populated only on the
 * port's `permanent` variant.
 *
 * A bare `kind` is NOT sufficient to classify the money exit — see
 * `MONEY_MOVED_PERMANENT_CODES`.
 */
export interface ProcessorFailure {
  readonly kind: ProcessorFailureKind;
  readonly code?: string | undefined;
}

/**
 * `permanent` codes the gateway emits from a point where the processor had
 * ALREADY ACCEPTED the request.
 *
 * `stripe-gateway.ts` returns `processor_response_amount_invalid` after
 * `client.refunds.create` resolved — the refund exists at Stripe and
 * `refund.id` is in hand; only the response's `amount` field failed
 * validation, and the adapter refuses to persist a known-wrong amount. Its own
 * comment says the out-of-band sweep should reconcile it, which terminalising
 * the row as `failed` would defeat.
 *
 * So `permanent` means "the processor refused" for every code EXCEPT these.
 * Listing them here rather than in the adapter keeps the money claim in the
 * layer that owns it.
 *
 * Reachable today: `confirm-payment.ts:838` and `:1204` both call
 * `createRefund` without `amountSatang`, which is the precondition for this
 * code. `issueRefund` always passes an amount, so it cannot currently produce
 * one — but relying on that is exactly the kind of second-order argument that
 * stops being true when someone adds a full-refund path.
 */
export const MONEY_MOVED_PERMANENT_CODES = ['processor_response_amount_invalid'] as const;

/**
 * Where the money ended up.
 *
 * - `settled`  — it left, confirmed.
 * - `rejected` — it did not leave, confirmed.
 * - `unknown`  — nobody knows yet. Treat as "may have left".
 */
export type MoneyExit = 'settled' | 'rejected' | 'unknown';

/** Module-private brand — see `RejectionProof`. */
const REJECTION_PROOF = Symbol('payments.settlement.rejectionProof');

/**
 * Evidence that a settlement attempt moved no money. Obtainable only from
 * `proveNothingMoved`, and only for a `rejected` exit, so a caller cannot
 * assert `failed` on a hunch.
 */
export interface RejectionProof {
  readonly [REJECTION_PROOF]: true;
}

/** Map a processor failure onto what it proves about the money. */
export function classifyGatewayFailure(failure: ProcessorFailure): MoneyExit {
  if (failure.kind !== 'permanent') return 'unknown';
  const movedCodes: readonly string[] = MONEY_MOVED_PERMANENT_CODES;
  return failure.code !== undefined && movedCodes.includes(failure.code)
    ? 'unknown'
    : 'rejected';
}

/**
 * Mint proof that nothing moved, or `null` when the exit cannot support that
 * claim.
 *
 * `unknown` and `settled` both return `null` — deliberately. `unknown`
 * returning a proof would be F-3 itself; `settled` returning one would be a
 * direct contradiction.
 */
export function proveNothingMoved(exit: MoneyExit): RejectionProof | null {
  return exit === 'rejected' ? { [REJECTION_PROOF]: true } : null;
}

/**
 * Mint proof from the processor's own terminal verdict on a refund it created.
 *
 * ## The evidence that justifies this
 *
 * A Stripe refund that settles `failed` or `canceled` is the processor
 * asserting that the money went back to the platform balance — the customer
 * was not paid. That is a `rejected` exit established by a DIFFERENT source
 * than `classifyGatewayFailure`: not "our request errored" but "the refund
 * object we created reached a terminal non-settling state".
 *
 * Three call sites hold that evidence today (`proveNoProcessorRefund`, below,
 * is the other minting function, with its own evidence):
 *   - `issue-refund.ts` — `createRefund` returned status `failed`/`canceled`
 *   - `process-refund-updated.ts` — a `charge.refund.updated` webhook said so
 *   - `sweep-stale-pending-refunds.ts` — `retrieveRefund` said so
 *
 * ## Before adding another minting function
 *
 * The point of the brand is that it is hard to obtain. Each new minting
 * function is a new way to claim "no money moved", so it needs its own
 * paragraph like this one naming the evidence. If the honest answer is "the
 * caller is probably right", that is `unknown` — leave the row `pending` and
 * let the stale-pending sweep ask the processor.
 */
export function proveProcessorSettledFailed(
  status: 'failed' | 'canceled',
): RejectionProof {
  // `status` is unused at runtime — it exists so the call site must name the
  // evidence it holds, and so a future non-terminal status cannot be passed.
  void status;
  return { [REJECTION_PROOF]: true };
}

/**
 * #50 — mint proof that an orphan refund row (no processor refund id) never
 * reached the processor.
 *
 * ## The evidence that justifies this
 *
 * The stale-pending sweep lists every refund the processor holds for the
 * parent payment intent and looks for one that names this row
 * (`metadata.refundId`, set on every `createRefund`). The request that would
 * have created it was a single call with a stable idempotency key, and
 * nothing retries it. So, once that call is certainly over, a COMPLETE list
 * in which no refund names this row and every refund is one already recorded
 * on another of this payment's rows is the processor saying it made none:
 * the money never moved.
 *
 * Each condition is part of the proof, so each is checked here, not trusted
 * to the caller:
 *   - `rowAgeMs >= ORPHAN_PROOF_MIN_AGE_MS`: the `createRefund` call (SDK
 *     timeout and retries, well under a minute) has ended. Without it, an
 *     operator's short `olderThanHours` override could close a row whose
 *     refund Stripe is still making;
 *   - `complete`: no further pages;
 *   - `matchCount === 0`: no refund names this row;
 *   - `unaccountedCount === 0`: every refund on the intent is recorded on
 *     one of this payment's rows. One that is not (made before the marker
 *     existed, by hand in the Dashboard, or with a marker copied from
 *     another row) might be this row's money.
 *
 * Anything else proves nothing: the caller attaches a single clean match and
 * leaves the rest `pending` for a person. An error never reaches here.
 */
export function proveNoProcessorRefund(lookup: {
  readonly complete: boolean;
  readonly matchCount: number;
  readonly unaccountedCount: number;
  readonly rowAgeMs: number;
}): RejectionProof | null {
  return lookup.complete &&
    lookup.matchCount === 0 &&
    lookup.unaccountedCount === 0 &&
    lookup.rowAgeMs >= ORPHAN_PROOF_MIN_AGE_MS
    ? { [REJECTION_PROOF]: true }
    : null;
}

/**
 * #50 — the youngest an orphan row may be before `proveNoProcessorRefund`
 * accepts a lookup as proof. Far longer than any `createRefund` call; short
 * enough that the documented `?olderThanHours=2` override still closes rows.
 */
export const ORPHAN_PROOF_MIN_AGE_MS = 60 * 60 * 1000;
