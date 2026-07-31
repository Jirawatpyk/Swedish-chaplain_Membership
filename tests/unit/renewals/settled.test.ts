/**
 * `settle` — the eager-island promise wrapper behind the /admin/renewals
 * waterfall fix (`_lib/settled.ts`). Pins the two properties the pattern
 * depends on:
 *   1. outcomes become plain values (`{ok:true,v}` / `{ok:false,e}`) with
 *      the ORIGINAL value/rejection preserved for the island's unwrap;
 *   2. the rejection handler is attached AT CREATION — a promise that
 *      rejects long before its island awaits it never surfaces as an
 *      unhandled rejection (the exact hazard of firing island queries
 *      before `await loadPipeline`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settle } from '@/app/(staff)/admin/renewals/_lib/settled';

// The shared harness installs fake timers, which would freeze the real
// setTimeout macrotask turns the unhandled-rejection test below depends on
// (memory: component test harness fake timers).
beforeEach(() => vi.useRealTimers());

describe('settle', () => {
  it('resolves to { ok: true, v } with the original value', async () => {
    await expect(settle(Promise.resolve(42))).resolves.toEqual({
      ok: true,
      v: 42,
    });
  });

  it('converts a rejection into { ok: false, e } carrying the ORIGINAL error', async () => {
    const boom = new Error('neon exploded');
    await expect(settle(Promise.reject(boom))).resolves.toEqual({
      ok: false,
      e: boom,
    });
  });

  it('a rejection settled at creation never becomes an unhandled rejection, even when awaited a macrotask later (the eager-island window)', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      // Fire-and-forget for a full macrotask turn BEFORE anything awaits it —
      // models the island still rendering while `loadPipeline` runs.
      const p = settle(Promise.reject(new Error('early failure')));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
      const settled = await p;
      expect(settled.ok).toBe(false);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});
