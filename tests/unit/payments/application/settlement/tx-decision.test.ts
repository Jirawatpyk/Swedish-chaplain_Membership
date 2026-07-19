/**
 * Money-remediation Task 2 — settlement transaction-decision primitive.
 *
 * The defect this exists to make unrepresentable: `return err(...)` inside a
 * `withTx` callback does NOT throw, so `runInTenant` COMMITS. Every refusal
 * written that way persists the writes it was refusing (finding F-1, and the
 * same shape in F-3). `runTxDecided` forces the callback to name its
 * intent — `commitTx(v)` or `rollbackTx(v)` — so the ambiguous `return` stops
 * compiling.
 *
 * These tests use a runner that genuinely discards writes on throw
 * (`tests/support/fake-tx.ts`), because a runner that cannot roll back can
 * only ever produce green tests about rollback.
 */
import { describe, expect, it } from 'vitest';
import {
  commitTx,
  commitTxWithRefusal,
  rollbackTx,
  runTxDecided,
  type TxDecision,
  type TxRunner,
} from '@/modules/payments/application/settlement/tx-decision';
import { err, ok } from '@/lib/result';
import {
  expectRolledBack,
  makeFakeTxRunner,
  recordWrite,
} from '../../../../support/fake-tx';

describe('runTxDecided', () => {
  it('commits and returns the value when the callback decides commit', async () => {
    const runner = makeFakeTxRunner();

    const outcome = await runTxDecided(runner, async (tx) => {
      recordWrite(tx, 'refunds.updateStatus', { nextStatus: 'succeeded' });
      return commitTx('swept' as const);
    });

    expect(outcome).toEqual({ committed: true, value: 'swept' });
    expect(runner.committed).toEqual([
      { op: 'refunds.updateStatus', detail: { nextStatus: 'succeeded' } },
    ]);
    expect(runner.discarded).toEqual([]);
  });

  it('DISCARDS the writes and still returns the value when the callback decides rollback', async () => {
    // The load-bearing case. A refusal must not persist what it refused, and
    // it must still be a value the caller can branch on — not an exception
    // the caller has to distinguish from a genuine DB fault.
    const runner = makeFakeTxRunner();

    const outcome = await runTxDecided(runner, async (tx) => {
      recordWrite(tx, 'refunds.updateStatus', { nextStatus: 'failed' });
      return rollbackTx({ kind: 'terminal_divergence' as const, detail: 'pdf_render_failed' });
    });

    expect(outcome.committed).toBe(false);
    expect(outcome.value).toEqual({ kind: 'terminal_divergence', detail: 'pdf_render_failed' });
    // Two-sided: the write must appear in `discarded` (proving it was really
    // attempted through the fake) AND be absent from `committed`. A bare
    // `committed === []` also passes when the stub never got the fake handle.
    expectRolledBack(runner, 'refunds.updateStatus');
  });

  it('propagates a genuine fault instead of disguising it as a rollback decision', async () => {
    // A Neon blip and a deliberate refusal must stay distinguishable —
    // conflating them is how the sweep's escalation branch would start
    // firing on transient DB errors.
    const runner = makeFakeTxRunner();
    const boom = new Error('connection terminated');

    await expect(
      runTxDecided(runner, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(runner.committed).toEqual([]);
    expect(runner.discarded).toEqual([]);
  });

  it('opens exactly one transaction per call', async () => {
    const runner = makeFakeTxRunner();
    await runTxDecided(runner, async () => commitTx(1));
    await runTxDecided(runner, async () => rollbackTx(2));
    expect(runner.txCount).toBe(2);
  });

  it('throws loudly when the runner resolves despite a rollback decision', async () => {
    // Guards the exact class of test double this task exists to retire: a
    // runner that swallows the rollback signal would otherwise let
    // `runTxDecided` report `committed: true` for a refused write, which is
    // the original bug wearing the new API.
    const swallowing = {
      async withTx<R>(fn: (tx: unknown) => Promise<R>): Promise<R> {
        try {
          return await fn({});
        } catch {
          return 'silently-committed' as unknown as R;
        }
      },
    };

    await expect(
      runTxDecided(swallowing, async () => rollbackTx('refused')),
    ).rejects.toThrow(/does not roll back/);
  });

  it('passes the runner-supplied tx handle straight through to the callback', async () => {
    // The callback must write on the SAME tx the runner opened; handing it a
    // fresh connection is the documented RLS-bypass footgun.
    //
    // Declared as a generic method rather than `vi.fn` on purpose: a `vi.fn`
    // wrapper collapses `R` to `unknown` and stops satisfying `TxRunner`,
    // which is the port-shape drift this repo has been bitten by before.
    const handle = { marker: 'tx-handle' };
    const runner: TxRunner = {
      async withTx<R>(fn: (tx: unknown) => Promise<R>): Promise<R> {
        return fn(handle);
      },
    };

    let seen: unknown;
    await runTxDecided(runner, async (tx) => {
      seen = tx;
      return commitTx(null);
    });

    expect(seen).toBe(handle);
  });
});

describe('TxDecision brand', () => {
  it('carries the decided value unchanged in both directions', () => {
    const payload = { refundId: 'rfnd_1' };
    expect(commitTx(payload).value).toBe(payload);
    expect(rollbackTx(payload).value).toBe(payload);
  });
});

/**
 * COMPILE-TIME guarantees. These are the actual enforcement — a runtime
 * assertion cannot test "this does not typecheck". `tsconfig` includes test
 * sources, so every `@ts-expect-error` below is checked by `pnpm typecheck`
 * and FAILS THE BUILD if the error it expects stops occurring.
 *
 * Without these the narrowing is one careless signature edit away from
 * silently becoming decoration, and every runtime test stays green.
 */
describe('compile-time guarantees', () => {
  it('rejects a bare Result from the callback — and the RUNTIME does not', async () => {
    const runner = makeFakeTxRunner();

    // Bound to a variable so the type error lands on THIS assignment. Inlined
    // as a callback argument, the error surfaces on the `runTxDecided(...)`
    // call line instead and a `@ts-expect-error` sitting on the `return` is
    // reported as unused — which fails the build for the wrong reason and
    // teaches the next author to delete the pin.
    //
    // Returning `err(...)` from a withTx callback is what commits the writes
    // the refusal was refusing. This directive is the guarantee.
    // @ts-expect-error - Err<E> is not a TxDecision
    const refusingCallback: (tx: unknown) => Promise<TxDecision<unknown>> = async (
      tx: unknown,
    ) => {
      recordWrite(tx, 'payments.updateStatus', { nextStatus: 'succeeded' });
      return err({ code: 'bridge_error' });
    };

    const outcome = await runTxDecided(runner, refusingCallback);

    // Deliberately asserting the UNPROTECTED runtime behaviour, because it
    // shows why the compile-time pin above carries the whole weight: an
    // unbranded return has no rollback marker, so the transaction COMMITS and
    // the value is silently `undefined`. That is F-1, reproduced exactly, and
    // nothing at runtime objects to it.
    expect(outcome.committed).toBe(true);
    expect(outcome.value).toBeUndefined();
    expect(runner.committed.map((w) => w.op)).toEqual(['payments.updateStatus']);
  });

  it('rejects commitTx(err(...)) — the wrong mechanical conversion of F-1', () => {
    // `confirm-payment.ts:801` currently reads `return err(...)`. Wrapping it
    // in `commitTx(` is the shortest edit and reproduces F-1 exactly.
    // @ts-expect-error - commitTx bans Err<E>; use rollbackTx or commitTxWithRefusal
    const wrong = commitTx(err({ code: 'bridge_error' }));
    expect(wrong.value.ok).toBe(false);
  });

  it('rejects a hand-rolled object literal posing as a TxDecision', () => {
    // The brand symbol is module-private, so a literal cannot satisfy it.
    // If this ever compiles, `commitTx`/`rollbackTx` stop being the only way
    // to produce a decision and the explicitness is gone.
    // @ts-expect-error - the TX_DECISION brand is not constructible here
    const forged: TxDecision<string> = { value: 'swept' };
    expect(forged.value).toBe('swept');
  });

  it('still ALLOWS the legitimate shapes', () => {
    // Guards over-correction: a constraint that also banned Ok, plain
    // objects, or null would push authors straight back to the escape hatch.
    expect(commitTx(ok({ id: 1 })).value.ok).toBe(true);
    expect(commitTx({ kind: 'skip' as const }).value.kind).toBe('skip');
    expect(commitTx(null).value).toBeNull();
    expect(commitTx(undefined).value).toBeUndefined();
    expect(rollbackTx(err({ code: 'bridge_error' })).value.ok).toBe(false);
    // The escape hatch exists precisely so "commit an audit row, then return
    // a refusal" stays expressible.
    expect(commitTxWithRefusal(err({ code: 'noted' })).value.ok).toBe(false);
  });
});
