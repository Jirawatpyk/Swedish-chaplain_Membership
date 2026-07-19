/**
 * Money-exit classification (money-remediation Task 2).
 *
 * ## What this encodes
 *
 * A refund row marked `failed` is a claim about the world: **no money left
 * the account.** Downstream logic treats it as exactly that — `failed` rows
 * are excluded from `succeeded_sum_satang`, do not trip the
 * `refund_in_progress` guard, and are counted by the `COUNT(*)`-based
 * sequence that derives the Stripe idempotency key. So a wrong `failed` does
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
 * NO CALL SITE YET — this is the primitive Task 6 consumes.
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

/** Map a processor failure kind onto what it proves about the money. */
export function classifyGatewayFailure(kind: ProcessorFailureKind): MoneyExit {
  return kind === 'permanent' ? 'rejected' : 'unknown';
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
