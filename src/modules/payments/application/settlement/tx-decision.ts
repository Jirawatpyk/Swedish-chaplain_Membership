/**
 * Settlement transaction-decision primitive (money-remediation Task 2).
 *
 * ## The defect this makes unrepresentable
 *
 * `PaymentsRepo.withTx` is `runInTenant(ctx, fn)`, which commits whenever the
 * callback does not throw. So this shape:
 *
 * ```ts
 * await paymentsRepo.withTx(async (tx) => {
 *   await paymentsRepo.updateStatus(tx, { nextStatus: 'succeeded' });
 *   const bridged = await invoicingBridge.recordPayment(tx, …);
 *   if (!bridged.ok) return err({ code: 'bridge_error' });   // ← COMMITS
 * });
 * ```
 *
 * refuses and persists the write it was refusing. That is finding F-1
 * (`confirm-payment.ts:801`: money captured, payment row `succeeded`, invoice
 * stranded `issued` with no §87 receipt number, and a 200 to Stripe so
 * nothing ever retries) and it is the same shape as F-3.
 *
 * The failure is not that anyone wrote a bug — it is that the ambiguous
 * `return` is the most natural thing to write and the type system has no
 * opinion about it. `runTxDecided` removes the ambiguity by making the
 * callback's return type a decision, so `return err(...)` no longer compiles
 * and the author has to say `commitTx(...)` or `rollbackTx(...)`.
 *
 * ## Why a rollback is a value, not an exception
 *
 * The obvious alternative is "throw a sentinel". The sweep already does that
 * (`SweepFinalizeError`) and it costs a permanent hazard: the outer `catch`
 * now receives both deliberate refusals and genuine Neon faults, and has to
 * tell them apart by `instanceof`. Get that wrong and an escalation branch
 * starts paging on transient DB errors. Returning the refusal as a value
 * keeps the two channels separate by construction — `catch` means "something
 * broke", full stop.
 *
 * ## Why this is a helper and not a `PaymentsRepo` port method
 *
 * The remediation plan put `withTxDecided` on the port. That works, but it
 * breaks every hand-rolled `PaymentsRepo` stub in `tests/**` (25 files, 69
 * `withTx:` stubs) at runtime rather than at compile time — the repo's
 * documented stale-stub footgun, paid in full for no benefit. A free function
 * over the existing `withTx` contract ("rollback on throw", already the
 * port's stated behaviour) gets the identical type-level guarantee with zero
 * stub churn, and works unchanged against the real `runInTenant`, the fake in
 * `tests/support/fake-tx.ts`, and any existing mock.
 *
 * Pure Application — no ORM, framework, or React imports (Principle III).
 */

/**
 * Module-private brand. Because it is neither exported nor reachable, an
 * object literal cannot satisfy `TxDecision` — the only way to produce one is
 * `commitTx` / `rollbackTx`, which is what makes the intent explicit at every
 * call site instead of merely conventional.
 */
const TX_DECISION = Symbol('payments.settlement.txDecision');

export interface CommitDecision<T> {
  readonly [TX_DECISION]: 'commit';
  readonly value: T;
}

export interface RollbackDecision<T> {
  readonly [TX_DECISION]: 'rollback';
  readonly value: T;
}

/** The callback's verdict: persist this transaction, or unwind it. */
export type TxDecision<T> = CommitDecision<T> | RollbackDecision<T>;

/**
 * Persist the transaction's writes and resolve with `value`.
 *
 * **`Err<E>` does not compile here.** The parameter is intersected with
 * `{ ok?: true }`, so an `Err` (whose `ok` is `false`) reduces the parameter
 * to `never` and the call fails.
 *
 * That narrowing is the whole point of the primitive rather than a nicety.
 * The F-1 site is `confirm-payment.ts:801`, which today reads
 * `return err<ConfirmPaymentError>({ code: 'bridge_error' })` straight out of
 * the `withTx` callback. The most mechanical possible conversion is to wrap
 * that in `commitTx(` — which reproduces F-1 exactly, with a new API on top.
 * The correct conversion is `rollbackTx(err(...))`, and without this
 * constraint the type system has no opinion between the two.
 *
 * `null` and `undefined` stay legal ("committed, nothing to report").
 * `Ok<T>` stays legal. If you genuinely need to commit AND return a refusal,
 * use `commitTxWithRefusal` and say why.
 */
export function commitTx<T>(
  value: T & ({ readonly ok?: true | undefined } | null | undefined),
): CommitDecision<T> {
  return { [TX_DECISION]: 'commit', value };
}

/**
 * Commit the transaction and STILL return a refusal — the deliberate escape
 * hatch from `commitTx`'s `Err` ban.
 *
 * **When this is right:** the transaction wrote something that must survive
 * regardless of the refusal, and the refusal describes the caller's outcome
 * rather than the transaction's. The canonical case is a forensic or audit
 * row: "record that we could not proceed, then tell the caller we could not
 * proceed." Rolling back there would destroy the evidence that the refusal
 * happened at all.
 *
 * **When this is wrong — and it is the common case:** the transaction wrote
 * money-side state (a payment flipped `succeeded`, a refund row inserted, a
 * status transitioned) and the refusal means that state should never have
 * been persisted. That is finding F-1. Use `rollbackTx` instead.
 *
 * The test: *would I be comfortable if this write survived and the caller saw
 * an error?* If the honest answer is no, you want `rollbackTx`.
 *
 * Deliberately verbose to name and to read in a diff — reaching for it should
 * be a decision a reviewer notices, not a way around a type error.
 */
export function commitTxWithRefusal<T>(value: T): CommitDecision<T> {
  return { [TX_DECISION]: 'commit', value };
}

/**
 * Unwind the transaction's writes and STILL resolve with `value`.
 *
 * Use this for every refusal taken after a write has been issued. The caller
 * receives `{ committed: false, value }` and branches on it normally — no
 * exception, no `instanceof`.
 */
export function rollbackTx<T>(value: T): RollbackDecision<T> {
  return { [TX_DECISION]: 'rollback', value };
}

function isRollback<T>(decision: TxDecision<T>): decision is RollbackDecision<T> {
  return decision[TX_DECISION] === 'rollback';
}

/** What actually happened to the transaction, plus the decided value. */
export interface TxOutcome<T> {
  /** `false` when the callback chose `rollbackTx` — the writes are gone. */
  readonly committed: boolean;
  readonly value: T;
}

/**
 * Minimal structural view of `PaymentsRepo.withTx`. Kept local so this module
 * does not depend on the full repo port — anything that runs a callback in a
 * transaction and rolls back on throw satisfies it.
 */
export interface TxRunner {
  withTx<R>(fn: (tx: unknown) => Promise<R>): Promise<R>;
}

/**
 * Carries a rollback decision out through the runner. Rolling back is only
 * expressible as a throw at the `runInTenant` boundary, so the signal is
 * thrown inside and re-materialised into a value outside — the throw never
 * escapes this module.
 */
class SettlementRollbackSignal extends Error {
  constructor(readonly carried: unknown) {
    super('settlement: transaction rolled back by decision');
    this.name = 'SettlementRollbackSignal';
  }
}

/**
 * Run `fn` in a transaction supplied by `runner`, honouring its decision.
 *
 * - `commitTx(v)`   → transaction commits, resolves `{ committed: true, value: v }`
 * - `rollbackTx(v)` → transaction unwinds, resolves `{ committed: false, value: v }`
 * - anything thrown → transaction unwinds and the error PROPAGATES unchanged,
 *   so a genuine fault never masquerades as a deliberate refusal.
 */
export async function runTxDecided<T>(
  runner: TxRunner,
  fn: (tx: unknown) => Promise<TxDecision<T>>,
): Promise<TxOutcome<T>> {
  let decided: TxDecision<T> | undefined;
  try {
    const value = await runner.withTx(async (tx) => {
      const decision = await fn(tx);
      decided = decision;
      if (isRollback(decision)) {
        throw new SettlementRollbackSignal(decision.value);
      }
      return decision.value;
    });

    // The runner resolved even though the callback asked to unwind — it
    // swallowed the signal, so it does not roll back. Reporting `committed`
    // here would be the original bug wearing the new API, and it is exactly
    // what `withTx: vi.fn(async (fn) => fn({}))`-style doubles invite. Fail
    // loudly instead.
    if (decided !== undefined && isRollback(decided)) {
      throw new Error(
        'settlement: withTx resolved despite a rollback decision — the transaction runner does not roll back on throw',
      );
    }
    return { committed: true, value };
  } catch (e) {
    if (e instanceof SettlementRollbackSignal) {
      return { committed: false, value: e.carried as T };
    }
    throw e;
  }
}
