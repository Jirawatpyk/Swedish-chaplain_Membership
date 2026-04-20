/**
 * Unit tests for the deterministic-render harness (SC-003 / CP-5.2).
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
import { withSeededRandom } from '@/modules/invoicing/infrastructure/pdf/deterministic-render';

describe('withSeededRandom', () => {
  const OriginalRandom = Math.random;
  const OriginalDate = Date;

  afterEach(() => {
    // Belt-and-suspenders — if any test leaks, restore here.
    Math.random = OriginalRandom;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = OriginalDate;
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
});
