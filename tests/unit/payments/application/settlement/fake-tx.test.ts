/**
 * Money-remediation Task 2 — self-test for the rollback-capable test double.
 *
 * `tests/support/fake-tx.ts` is the artifact the rest of the remediation
 * depends on. The double it replaces is
 * `withTx: vi.fn(async (fn) => fn({}))` — which commits unconditionally, so
 * every assertion written against it about transactional behaviour is
 * theatre. (That is precisely why `confirm-payment.test.ts:862-871` is green
 * while F-1 is live.)
 *
 * A test double that silently gets its own contract wrong is worse than no
 * double at all, so the double itself is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { makeFakeTxRunner, recordWrite } from '../../../../support/fake-tx';

describe('makeFakeTxRunner', () => {
  it('keeps writes from a transaction that resolves', async () => {
    const runner = makeFakeTxRunner();
    await runner.withTx(async (tx) => {
      recordWrite(tx, 'payments.updateStatus');
      recordWrite(tx, 'audit.emit');
    });
    expect(runner.committed.map((w) => w.op)).toEqual([
      'payments.updateStatus',
      'audit.emit',
    ]);
    expect(runner.discarded).toEqual([]);
  });

  it('DISCARDS writes from a transaction that throws, and rethrows', async () => {
    const runner = makeFakeTxRunner();
    await expect(
      runner.withTx(async (tx) => {
        recordWrite(tx, 'payments.updateStatus');
        throw new Error('bridge declined');
      }),
    ).rejects.toThrow('bridge declined');

    expect(runner.committed).toEqual([]);
    expect(runner.discarded.map((w) => w.op)).toEqual(['payments.updateStatus']);
  });

  it('does not leak writes from a rolled-back transaction into a later one', async () => {
    // Per-transaction buffering, not one global list. Without this a rollback
    // followed by a commit would report the discarded write as committed.
    const runner = makeFakeTxRunner();
    await expect(
      runner.withTx(async (tx) => {
        recordWrite(tx, 'first.doomed');
        throw new Error('nope');
      }),
    ).rejects.toThrow();
    await runner.withTx(async (tx) => {
      recordWrite(tx, 'second.kept');
    });

    expect(runner.committed.map((w) => w.op)).toEqual(['second.kept']);
    expect(runner.discarded.map((w) => w.op)).toEqual(['first.doomed']);
    expect(runner.txCount).toBe(2);
  });

  it('returns the callback result unchanged', async () => {
    const runner = makeFakeTxRunner();
    await expect(runner.withTx(async () => 'value')).resolves.toBe('value');
  });

  it('recordWrite is a no-op on a tx handle that is not a fake', async () => {
    // Collaborator stubs are shared between fake-tx tests and plain-mock
    // tests; recording must not explode when the handle is a bare `{}`.
    expect(() => recordWrite({}, 'ignored')).not.toThrow();
    expect(() => recordWrite(null, 'ignored')).not.toThrow();
  });
});
