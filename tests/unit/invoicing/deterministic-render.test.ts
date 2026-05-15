/**
 * @vitest-environment node
 *
 * Unit tests for the deterministic-render harness (SC-003 / CP-5.2).
 *
 * Runs under the `node` environment (not the project-default `jsdom`).
 * Reason: the harness swaps `globalThis.Date` with a Proxy that pins
 * `new Date()` to the pinned issueDate. Under jsdom, async cleanup
 * (document `readystatechange` event dispatch) fires during vitest's
 * teardown and calls `new Date()` — but by then `Date` has been
 * restored and the jsdom sandbox's own `Date` reference is stale,
 * surfacing as `ReferenceError: Date is not defined` "Unhandled
 * Rejection". This test is pure JS and has no DOM dependency, so
 * `node` env is both faster and side-effect-free.
 *
 * Tests the pure-JS invariants of `withSeededRandom`:
 *   1. Math.random is restored to the original impl after render
 *      (including the throw path).
 *   2. new Date() inside the callback returns the pinned issueDate
 *      at midnight UTC — while Date.now, Date.UTC, Date.parse, and
 *      `new Date(arg)` continue to work untouched.
 *   3. `instanceof Date` holds for instances created during the
 *      pinned window (reliability reviewer Medium concern — the
 *      Proxy preserves prototype chain via Reflect.construct).
 *   4. Missing issueDate throws explicitly — no silent epoch fallback.
 *   5. Same input → same Math.random sequence across renders.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  withSeededRandom,
  _resetRenderChainForTesting,
} from '@/modules/invoicing/infrastructure/pdf/deterministic-render';

describe('withSeededRandom', () => {
  const OriginalRandom = Math.random;
  const OriginalDate = Date;

  afterEach(() => {
    // Belt-and-suspenders — if any test leaks, restore here.
    Math.random = OriginalRandom;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = OriginalDate;
    // Drain any pending rejection on the module-level chain so a
    // prior test's throw doesn't surface as an "unhandled error"
    // during Vitest teardown.
    _resetRenderChainForTesting();
  });

  it('restores Math.random + Date after successful render', async () => {
    const beforeRandom = Math.random;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const beforeDate = (globalThis as any).Date;
    await withSeededRandom({ issueDate: '2026-04-20' }, async () => {
      expect(Math.random).not.toBe(beforeRandom);
    });
    expect(Math.random).toBe(beforeRandom);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).Date).toBe(beforeDate);
  });

  it('restores Math.random + Date even when render throws', async () => {
    const beforeRandom = Math.random;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const beforeDate = (globalThis as any).Date;
    await expect(
      withSeededRandom({ issueDate: '2026-04-20' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(Math.random).toBe(beforeRandom);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).Date).toBe(beforeDate);
  });

  it('new Date() returns the pinned issueDate during the render window', async () => {
    let captured: Date | null = null;
    await withSeededRandom({ issueDate: '2026-04-20' }, async () => {
      captured = new Date();
    });
    expect(captured).not.toBeNull();
    expect(captured!.toISOString()).toBe('2026-04-20T00:00:00.000Z');
  });

  it('preserves Date static methods + arg-taking ctors during render', async () => {
    let staticNowOk = false;
    let parseOk = false;
    let argCtorOk = false;
    await withSeededRandom({ issueDate: '2026-04-20' }, async () => {
      // Date.now is allowed to return the real wall clock — pinning
      // only covers the no-args ctor path that pdfkit uses.
      staticNowOk = typeof Date.now() === 'number' && Date.now() > 0;
      parseOk = Date.parse('2026-01-01T00:00:00Z') > 0;
      const d = new Date('2026-06-15T12:00:00Z');
      argCtorOk = d.toISOString() === '2026-06-15T12:00:00.000Z';
    });
    expect(staticNowOk).toBe(true);
    expect(parseOk).toBe(true);
    expect(argCtorOk).toBe(true);
  });

  it('instanceof Date holds for pinned instances (Proxy preserves prototype)', async () => {
    let isDate = false;
    await withSeededRandom({ issueDate: '2026-04-20' }, async () => {
      isDate = new Date() instanceof Date;
    });
    expect(isDate).toBe(true);
  });

  it('throws when issueDate is missing — no silent epoch fallback', async () => {
    await expect(
      withSeededRandom({}, async () => 'ignored'),
    ).rejects.toThrow(/issueDate/);
  });

  it('produces identical Math.random sequences across runs for same input', async () => {
    const input = { issueDate: '2026-04-20', docId: 'abc' };
    const captureSeq = async (): Promise<number[]> => {
      const seq: number[] = [];
      await withSeededRandom(input, async () => {
        for (let i = 0; i < 8; i++) seq.push(Math.random());
      });
      return seq;
    };
    const a = await captureSeq();
    const b = await captureSeq();
    expect(b).toEqual(a);
  });

  it('same Uint8Array bytes (e.g. tenant logo) → same Math.random sequence', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x43]);
    const captureSeq = async (): Promise<number[]> => {
      const seq: number[] = [];
      await withSeededRandom(
        {
          issueDate: '2026-04-20',
          tenantLogo: { bytes, format: 'png' as const },
        },
        async () => {
          for (let i = 0; i < 8; i++) seq.push(Math.random());
        },
      );
      return seq;
    };
    const a = await captureSeq();
    const b = await captureSeq();
    expect(b).toEqual(a);
  });

  it('different Uint8Array bytes → different Math.random seed (digest contributes to hash)', async () => {
    const captureFirst = async (bytes: Uint8Array): Promise<number> => {
      let first = 0;
      await withSeededRandom(
        {
          issueDate: '2026-04-20',
          tenantLogo: { bytes, format: 'png' as const },
        },
        async () => {
          first = Math.random();
        },
      );
      return first;
    };
    const seqA = await captureFirst(new Uint8Array([1, 2, 3, 4, 5]));
    const seqB = await captureFirst(new Uint8Array([5, 4, 3, 2, 1]));
    expect(seqA).not.toBe(seqB);
  });

  it('handles a 1 MB Uint8Array without timing out (replacer short-circuits)', async () => {
    // If the replacer regressed to JSON-walking every byte (a 1 MB
    // Uint8Array → ~7 MB of indexed JSON keys), this would take
    // seconds; the digest-replacer keeps it bounded to a single
    // sha256 pass (~10 ms on commodity hardware).
    const bigBytes = new Uint8Array(1_048_576).fill(0xab);
    const start = performance.now();
    await withSeededRandom(
      {
        issueDate: '2026-04-20',
        tenantLogo: { bytes: bigBytes, format: 'png' as const },
      },
      async () => {
        Math.random();
      },
    );
    const elapsed = performance.now() - start;
    // Generous bound — even 1 GB/s sha256 is ~1ms here; allow 500ms
    // so slow CI runners pass.
    expect(elapsed).toBeLessThan(500);
  });
});
