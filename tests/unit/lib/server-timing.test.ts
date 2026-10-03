import { describe, expect, it } from 'vitest';
import { createServerTiming } from '@/lib/server-timing';

/** A clock that advances by the given steps on each read. */
function clock(...reads: number[]) {
  let i = 0;
  return () => reads[Math.min(i++, reads.length - 1)]!;
}

describe('createServerTiming', () => {
  it('records each step and renders a Server-Timing header with a total', async () => {
    // reads: start=0, a:t0=10, a:end=60, b:t0=60, b:end=160, header total=200
    const t = createServerTiming(clock(0, 10, 60, 60, 160, 200));
    await expect(t.time('auth', async () => 'ok')).resolves.toBe('ok');
    await t.time('tx.lock', async () => undefined);
    expect(t.entries()).toEqual([
      { name: 'auth', durMs: 50 },
      { name: 'tx.lock', durMs: 100 },
    ]);
    expect(t.header()).toBe('auth;dur=50, tx.lock;dur=100, total;dur=200');
  });

  it('records the duration even when the step throws, and rethrows unchanged', async () => {
    const t = createServerTiming(clock(0, 5, 25));
    const boom = new Error('boom');
    await expect(
      t.time('record_payment', async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(t.entries()).toEqual([{ name: 'record_payment', durMs: 20 }]);
  });

  it('sanitises names to HTTP tokens and rounds to 0.1 ms', async () => {
    const t = createServerTiming(clock(0, 0, 1.2345, 2));
    await t.time('tx receipt/pdf', async () => undefined);
    expect(t.entries()).toEqual([{ name: 'tx_receipt_pdf', durMs: 1.2 }]);
    expect(t.totalMs()).toBe(2);
  });

  it('entries() returns a copy', async () => {
    const t = createServerTiming(clock(0, 0, 1));
    await t.time('a', async () => undefined);
    (t.entries() as unknown as unknown[]).push('x');
    expect(t.entries()).toHaveLength(1);
  });

  it('defaults to performance.now()', async () => {
    const t = createServerTiming();
    await t.time('a', async () => undefined);
    expect(t.entries()[0]!.durMs).toBeGreaterThanOrEqual(0);
    expect(t.header()).toMatch(/^a;dur=[\d.]+, total;dur=[\d.]+$/);
  });
});
