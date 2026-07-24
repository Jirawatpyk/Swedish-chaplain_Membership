/**
 * Rollback-capable transaction double (money-remediation Task 2).
 *
 * ## Why this exists
 *
 * The payments unit suite stubs transactions as:
 *
 * ```ts
 * withTx: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn({}))
 * ```
 *
 * That double **commits unconditionally**. It has no notion of a write, so it
 * cannot discard one, so every assertion made against it about transactional
 * behaviour passes whether or not the code under test rolls anything back.
 * `tests/unit/payments/application/confirm-payment.test.ts:862-871` is the
 * worked example: green today, with finding F-1 live in the code it covers.
 *
 * This double records writes per transaction and **discards them on throw**,
 * so "the refusal did not persist its write" becomes an assertion that can
 * actually fail.
 *
 * ## Using it
 *
 * Pass the runner wherever a `{ withTx }` is expected, and have collaborator
 * stubs log their writes through `recordWrite`:
 *
 * ```ts
 * const runner = makeFakeTxRunner();
 * const refundsRepo = {
 *   updateStatus: vi.fn(async (tx: unknown, input: UpdateStatusInput) => {
 *     recordWrite(tx, 'refunds.updateStatus', { nextStatus: input.nextStatus });
 *     return someRow;
 *   }),
 * };
 * // …drive the use case…
 * expect(runner.committed).toEqual([]);           // nothing persisted
 * expect(runner.discarded).toHaveLength(1);       // …but the write was attempted
 * ```
 *
 * Type stub parameters off the real port (`Parameters<RefundsRepo['updateStatus']>`)
 * rather than leaving them implicit — a bare `vi.fn()` infers `any` and hides
 * argument-order breakage when a port signature changes.
 */

export interface RecordedWrite {
  readonly op: string;
  readonly detail?: unknown;
}

/** The handle handed to the callback; collaborator stubs record through it. */
export interface FakeTxHandle {
  readonly __fakeTx: true;
  record(op: string, detail?: unknown): void;
}

export interface FakeTxRunner {
  /** Matches `PaymentsRepo.withTx` — commits on resolve, unwinds on throw. */
  withTx<R>(fn: (tx: unknown) => Promise<R>): Promise<R>;
  /** Writes from transactions that resolved. */
  readonly committed: readonly RecordedWrite[];
  /** Writes from transactions that threw — attempted, then thrown away. */
  readonly discarded: readonly RecordedWrite[];
  /** How many transactions were opened. */
  readonly txCount: number;
}

function isFakeTxHandle(tx: unknown): tx is FakeTxHandle {
  return (
    typeof tx === 'object' &&
    tx !== null &&
    (tx as { __fakeTx?: unknown }).__fakeTx === true
  );
}

/**
 * Record a write against the current transaction. A no-op when `tx` is not a
 * fake handle, so the same collaborator stub can be shared between fake-tx
 * tests and plain-mock tests without blowing up.
 */
export function recordWrite(tx: unknown, op: string, detail?: unknown): void {
  if (isFakeTxHandle(tx)) {
    tx.record(op, detail);
  }
}

/**
 * Assert that `op` was attempted and then thrown away.
 *
 * Use this instead of a bare `expect(runner.committed).toEqual([])`.
 * `recordWrite` no-ops when handed a tx that is not a fake handle, so if the
 * stub under test never received the fake — a DI wiring mistake, which is easy
 * to make and invisible — then NOTHING is recorded, `committed` is `[]`, and
 * the bare assertion passes while proving nothing. That is the exact
 * false-green shape this repo keeps shipping.
 *
 * Checking both halves closes it: `discarded` must contain the write (proving
 * the stub really was wired to the fake and really did attempt the write) AND
 * `committed` must not (proving the rollback actually discarded it).
 */
export function expectRolledBack(runner: FakeTxRunner, op: string): void {
  const discarded = runner.discarded.filter((w) => w.op === op);
  const committed = runner.committed.filter((w) => w.op === op);
  if (discarded.length === 0) {
    throw new Error(
      `expectRolledBack: no discarded write recorded for "${op}". ` +
        `Either the write was never attempted, or the collaborator stub did not ` +
        `receive the fake tx handle (check the DI wiring — recordWrite silently ` +
        `no-ops on a non-fake tx). Recorded ops: ` +
        `discarded=[${runner.discarded.map((w) => w.op).join(', ')}] ` +
        `committed=[${runner.committed.map((w) => w.op).join(', ')}]`,
    );
  }
  if (committed.length > 0) {
    throw new Error(
      `expectRolledBack: "${op}" was COMMITTED (${committed.length}×) — the ` +
        `transaction did not roll back.`,
    );
  }
}

export function makeFakeTxRunner(): FakeTxRunner {
  const committed: RecordedWrite[] = [];
  const discarded: RecordedWrite[] = [];
  let txCount = 0;

  return {
    async withTx<R>(fn: (tx: unknown) => Promise<R>): Promise<R> {
      txCount += 1;
      // Per-transaction buffer, flushed to exactly one destination on exit.
      // A single shared list would report a rolled-back write as committed
      // the moment a later transaction succeeded.
      const buffer: RecordedWrite[] = [];
      const handle: FakeTxHandle = {
        __fakeTx: true,
        record(op, detail) {
          buffer.push(detail === undefined ? { op } : { op, detail });
        },
      };
      try {
        const result = await fn(handle);
        committed.push(...buffer);
        return result;
      } catch (e) {
        discarded.push(...buffer);
        throw e;
      }
    },
    get committed() {
      return committed;
    },
    get discarded() {
      return discarded;
    },
    get txCount() {
      return txCount;
    },
  };
}
