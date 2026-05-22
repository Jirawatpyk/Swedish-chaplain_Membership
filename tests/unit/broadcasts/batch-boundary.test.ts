/**
 * T039 — Unit test: `splitIntoBatches` Domain VO pure function.
 *
 * Authored RED 2026-05-19 per Constitution II NON-NEG TDD. Phase 3
 * Cluster B implements at:
 *   src/modules/broadcasts/domain/value-objects/batch-boundary.ts
 *
 * Pure function — no side effects, no DB, no framework imports.
 * Domain layer per Constitution III.
 *
 * Contract: `splitIntoBatches(recipients, perBatchCap = 10000)`
 *   → ReadonlyArray<{ batchIndex, recipientRangeStart, recipientRangeEnd, recipients }>
 *
 * Invariants (FR-001 / FR-002):
 *   1. Sum of `recipients.length` across all batches = input.length
 *      (no recipient lost or duplicated)
 *   2. Every batch has `recipientRangeStart ≤ recipientRangeEnd`
 *   3. Batches are contiguous: batch[N+1].rangeStart = batch[N].rangeEnd + 1
 *   4. Last batch may be smaller than cap; all earlier batches are exactly cap
 *   5. No duplicate recipients ACROSS batches
 *   6. batchIndex is 0-based, sequential, no gaps
 *   7. Empty input → 0 batches
 *   8. Input.length ≤ cap → exactly 1 batch
 *   9. cap ≤ 0 → policy error (caught at Domain VO boundary, not split fn)
 *
 * Property-based via fast-check: invariants (1) + (5) + (6) hold for
 * any non-empty recipient list × any cap ≥ 1.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { splitIntoBatches } from '@/modules/broadcasts/domain/value-objects/batch-boundary';

// GREEN since 2026-05-19 Phase 3 Cluster B T041 — Domain VO implemented.
// The original Phase 3A RED commit used a dynamic-import wrapper to
// bypass typecheck before the module existed; Vite alias resolution
// doesn't reach inside `new Function('m','return import(m)')` so the
// helper would have stayed RED even after impl. Converted to static
// import on T041 ship.
async function importSplit(): Promise<{
  splitIntoBatches: typeof splitIntoBatches;
}> {
  return { splitIntoBatches };
}

function emails(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `m${i}@example.com`);
}

describe('splitIntoBatches Domain VO (T039)', () => {
  it('empty input → 0 batches', async () => {
    const { splitIntoBatches } = await importSplit();
    expect(splitIntoBatches([], 10_000)).toEqual([]);
  });

  it('5,000 recipients (cap=10k) → 1 batch of 5,000; range [0..4999]', async () => {
    const { splitIntoBatches } = await importSplit();
    const batches = splitIntoBatches(emails(5_000), 10_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.batchIndex).toBe(0);
    expect(batches[0]?.recipientRangeStart).toBe(0);
    expect(batches[0]?.recipientRangeEnd).toBe(4_999);
    expect(batches[0]?.recipients).toHaveLength(5_000);
  });

  it('10,000 recipients (exact cap) → 1 batch; range [0..9999]', async () => {
    const { splitIntoBatches } = await importSplit();
    const batches = splitIntoBatches(emails(10_000), 10_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.recipientRangeEnd).toBe(9_999);
  });

  it('10,001 recipients → 2 batches (10k + 1, last-batch-smaller)', async () => {
    const { splitIntoBatches } = await importSplit();
    const batches = splitIntoBatches(emails(10_001), 10_000);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.recipients).toHaveLength(10_000);
    expect(batches[1]?.recipients).toHaveLength(1);
    expect(batches[1]?.recipientRangeStart).toBe(10_000);
    expect(batches[1]?.recipientRangeEnd).toBe(10_000);
  });

  it('25,000 recipients → 3 batches (10k / 10k / 5k)', async () => {
    const { splitIntoBatches } = await importSplit();
    const batches = splitIntoBatches(emails(25_000), 10_000);
    expect(batches.map((b) => b.recipients.length)).toEqual([10_000, 10_000, 5_000]);
    expect(batches.map((b) => b.batchIndex)).toEqual([0, 1, 2]);
  });

  it('50,000 recipients (max per FR-001) → 5 batches × 10k', async () => {
    const { splitIntoBatches } = await importSplit();
    const batches = splitIntoBatches(emails(50_000), 10_000);
    expect(batches).toHaveLength(5);
    expect(batches.every((b) => b.recipients.length === 10_000)).toBe(true);
    expect(batches.map((b) => b.batchIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('contiguous ranges: batch[N+1].rangeStart = batch[N].rangeEnd + 1', async () => {
    const { splitIntoBatches } = await importSplit();
    const batches = splitIntoBatches(emails(25_000), 10_000);
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i]?.recipientRangeStart).toBe(
        (batches[i - 1]?.recipientRangeEnd ?? -2) + 1,
      );
    }
  });

  it('property: sum of batch sizes = input length (no recipient lost)', async () => {
    const { splitIntoBatches } = await importSplit();
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 0, maxLength: 1000 }),
        fc.integer({ min: 1, max: 500 }),
        (recipients, cap) => {
          const batches = splitIntoBatches(recipients, cap);
          const totalRecipientsInBatches = batches.reduce(
            (sum, b) => sum + b.recipients.length,
            0,
          );
          return totalRecipientsInBatches === recipients.length;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: batches contain no duplicate recipients across batches', async () => {
    const { splitIntoBatches } = await importSplit();
    fc.assert(
      fc.property(
        // Use UUIDs to guarantee uniqueness in test input
        fc
          .uniqueArray(fc.uuid(), { minLength: 0, maxLength: 500 })
          .map((arr) => arr.map((u) => `${u}@example.com`)),
        fc.integer({ min: 1, max: 200 }),
        (recipients, cap) => {
          const batches = splitIntoBatches(recipients, cap);
          const allRecipients = batches.flatMap((b) => b.recipients);
          return new Set(allRecipients).size === allRecipients.length;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: batchIndex is 0-based, sequential, no gaps', async () => {
    const { splitIntoBatches } = await importSplit();
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 500 }),
        fc.integer({ min: 1, max: 100 }),
        (recipients, cap) => {
          const batches = splitIntoBatches(recipients, cap);
          return batches.every((b, i) => b.batchIndex === i);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: all batches except last are exactly cap-sized', async () => {
    const { splitIntoBatches } = await importSplit();
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 1000 }),
        fc.integer({ min: 1, max: 200 }),
        (recipients, cap) => {
          const batches = splitIntoBatches(recipients, cap);
          if (batches.length <= 1) return true;
          // All but last must be exactly cap-sized
          return batches.slice(0, -1).every((b) => b.recipients.length === cap);
        },
      ),
      { numRuns: 100 },
    );
  });
});
