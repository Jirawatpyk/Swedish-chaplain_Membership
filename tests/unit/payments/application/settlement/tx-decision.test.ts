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
  rollbackTx,
  runTxDecided,
  type TxRunner,
} from '@/modules/payments/application/settlement/tx-decision';
import { makeFakeTxRunner, recordWrite } from '../../../../support/fake-tx';

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
    expect(runner.committed).toEqual([]);
    expect(runner.discarded).toHaveLength(1);
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
