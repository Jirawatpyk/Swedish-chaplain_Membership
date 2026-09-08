/**
 * T032 — Contract test: `splitBroadcastIntoBatches` use case (US1 / FR-001 / FR-002).
 *
 * Authored RED 2026-05-19 per Constitution II NON-NEG TDD. Phase 3
 * Cluster B implements the use case at:
 *   src/modules/broadcasts/application/use-cases/split-broadcast-into-batches.ts
 *
 * Tests survive the file-not-yet-existent state via the dynamic-import
 * wrapper (project memory `project_f5_red_import_pattern`): wrapping
 * `import(modulePath)` in `new Function('m','return import(m)')(m)`
 * bypasses Vite's static alias resolution so TypeScript doesn't fail
 * at typecheck time. Once Phase 3B lands the file, the import succeeds
 * and these tests run for real → GREEN.
 *
 * Contract spec: specs/014-email-broadcast-advance/contracts/batch-dispatch.md § 1.1
 *
 * Cases covered:
 *   - 5,000 recipients → 1 batch of 5,000 (still uses batched path
 *     for uniformity; spec FR-001 lifts ceiling, not the threshold).
 *   - 25,000 recipients → 3 batches of 10k / 10k / 5k (last-batch-smaller).
 *   - 50,000 recipients → 5 batches of 10k each (Resend audience cap).
 *   - Idempotency-key collision rejection (BATCH_ALREADY_DISPATCHED).
 *
 * Audit emission: exactly one `broadcast_dispatched_in_batches` event
 * per successful call (carrying batchCount + per-batch ranges).
 */
import { describe, expect, it } from 'vitest';

import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { splitBroadcastIntoBatches } from '@/modules/broadcasts/application/use-cases/split-broadcast-into-batches';

/**
 * Phase 3 Cluster B GREEN (2026-05-19) — T044 use case landed at
 *   src/modules/broadcasts/application/use-cases/split-broadcast-into-batches.ts
 *
 * The earlier RED variant of this test imported the use case via a
 * `new Function('m','return import(m)')` wrapper to bypass Vite's static
 * alias resolution while the file didn't exist (project memory
 * `project_f5_red_import_pattern`). Now that the impl is in tree, we
 * switch to a normal `@/`-aliased static import so the test exercises
 * the real module + benefits from typechecking against the public
 * signature.
 */
async function importSplitUseCase(): Promise<{
  splitBroadcastIntoBatches: (
    deps: unknown,
    input: unknown,
  ) => ReturnType<typeof splitBroadcastIntoBatches>;
}> {
  // Adapter cast — the stub deps in this test intentionally implement
  // a SUBSET of `SplitBroadcastIntoBatchesDeps` (no broadcastsRepo,
  // partial port shapes). The contract test verifies behaviour, not
  // full DI surface. `as never` lets us bypass the static type check
  // at the call site without weakening the production signature.
  return {
    splitBroadcastIntoBatches: (deps, input) =>
      splitBroadcastIntoBatches(deps as never, input as never),
  };
}

const tenant = asTenantContext('test-tenant');
const broadcastId = asBroadcastId('11111111-1111-1111-1111-111111111111');

/**
 * Phase 9b (T127) widened the recorder with `recipientRangeStart` /
 * `recipientRangeEnd`. They were dropped on the floor here, so nothing in this
 * file could see the indices — and the indices are the whole contract between
 * split and dispatch: `dispatchBroadcastBatch` sends
 * `allRecipients.slice(recipientRangeStart, recipientRangeEnd + 1)`. An
 * off-by-one in the ranges skips or double-sends real recipients while every
 * `recipientCount` assertion stays green.
 */
type RecordedBatch = {
  batchIndex: number;
  recipientCount: number;
  recipientRangeStart: number;
  recipientRangeEnd: number;
  idempotencyKey: string;
};

function makeStubDeps(): {
  emits: unknown[];
  insertedBatches: RecordedBatch[];
  deps: unknown;
} {
  const emits: unknown[] = [];
  const insertedBatches: RecordedBatch[] = [];

  return {
    emits,
    insertedBatches,
    deps: {
      audit: {
        async emit(_tx: unknown, e: unknown) {
          emits.push(e);
        },
      },
      batchManifests: {
        async bulkInsert(
          _tenantId: unknown,
          inputs: ReadonlyArray<RecordedBatch>,
        ) {
          // Idempotency-key collision contract — same key returns error
          for (const input of inputs) {
            if (insertedBatches.some((b) => b.idempotencyKey === input.idempotencyKey)) {
              return {
                ok: false,
                error: { kind: 'duplicate_idempotency_key' as const },
              };
            }
            insertedBatches.push({
              batchIndex: input.batchIndex,
              recipientCount: input.recipientCount,
              recipientRangeStart: input.recipientRangeStart,
              recipientRangeEnd: input.recipientRangeEnd,
              idempotencyKey: input.idempotencyKey,
            });
          }
          return { ok: true, value: insertedBatches };
        },
      },
      clock: { now: () => new Date('2026-06-15T05:00:00Z') },
    },
  };
}

describe('splitBroadcastIntoBatches contract (T032)', () => {
  /**
   * Phase 9b (T127) — **batches are sized at what ONE TICK can push, not at
   * what Resend accepts in one audience.**
   *
   * The three cases below used to read 5,000 → 1 batch, 25,000 → 10k/10k/5k
   * and 50,000 → 5 × 10k, because `splitBroadcastIntoBatches` passed
   * `RESEND_PER_AUDIENCE_CAP` (10,000) as the per-batch cap. That number is the
   * PROVIDER's limit — how many contacts one Resend audience may hold — and it
   * was never the binding constraint. The binding constraint is the wall clock:
   * `addContactsToAudience` is a serial `await` loop at a measured 2.08 req/s
   * (`POST /contacts`, mean 481 ms), so a 10,000-contact batch needs ~80 min
   * inside a `maxDuration = 300` function. Every batch above ~623 was killed
   * mid-push and re-pushed from index 0 on the next tick, into a NEW audience,
   * burning the whole batch's contact quota per retry.
   *
   * So the cap becomes `DELIVERABLE_RECIPIENTS_PER_TICK`. 10,000 stays as the
   * hard upper bound the batch size may never exceed (pinned in
   * `audience-ceiling.test.ts`), not as the size itself.
   *
   * The boundary cases are the point: 500 must be ONE batch (not two, an
   * off-by-one that would double every send) and 501 must be two.
   */
  it.each<[number, readonly number[]]>([
    [500, [500]],
    [501, [500, 1]],
    [1_200, [500, 500, 200]],
    [5_000, Array.from({ length: 10 }, () => 500)],
    [25_000, Array.from({ length: 50 }, () => 500)],
  ])(
    '%d recipients → batches sized at the per-tick bound, last batch smaller',
    async (count, expected) => {
      const { splitBroadcastIntoBatches } = await importSplitUseCase();
      const { deps, emits, insertedBatches } = makeStubDeps();

      const result = await splitBroadcastIntoBatches(deps, {
        tenantId: tenant,
        broadcastId,
        resolvedRecipientCount: count,
      });

      expect(result.ok).toBe(true);
      expect(insertedBatches.map((b) => b.recipientCount)).toEqual([...expected]);
      // Ranges stay contiguous and gap-free across the new size — the
      // invariant `batch-boundary.test.ts` pins for `computeBatchRanges` has
      // to survive the cap change, because `dispatchBroadcastBatch` slices
      // `allRecipients` by exactly these indices.
      expect(insertedBatches.map((b) => b.batchIndex)).toEqual(
        expected.map((_, i) => i),
      );
      expect(insertedBatches[0]?.recipientRangeStart).toBe(0);
      expect(insertedBatches.at(-1)?.recipientRangeEnd).toBe(count - 1);
      expect(emits.filter(isDispatchEvent)).toHaveLength(1);
    },
  );

  it('50,000 recipients (the DB CHECK maximum) → 100 batches, each one tick', async () => {
    const { splitBroadcastIntoBatches } = await importSplitUseCase();
    const { deps, insertedBatches } = makeStubDeps();

    const result = await splitBroadcastIntoBatches(deps, {
      tenantId: tenant,
      broadcastId,
      resolvedRecipientCount: 50_000,
    });

    expect(result.ok).toBe(true);
    // 100 batches at `dispatch_concurrency_cap = 4` and one wave per tick is
    // 25 ticks ≈ 2 h — deliverable, which the single 5 × 10,000 split was not.
    expect(insertedBatches).toHaveLength(100);
    expect(insertedBatches.every((b) => b.recipientCount === 500)).toBe(true);
  });

  it('idempotency-key collision → returns BATCH_ALREADY_DISPATCHED error', async () => {
    const { splitBroadcastIntoBatches } = await importSplitUseCase();
    const { deps } = makeStubDeps();

    // First call succeeds.
    const first = await splitBroadcastIntoBatches(deps, {
      tenantId: tenant,
      broadcastId,
      resolvedRecipientCount: 10_000,
    });
    expect(first.ok).toBe(true);

    // Second call with same broadcastId → idempotency key collision.
    const second = await splitBroadcastIntoBatches(deps, {
      tenantId: tenant,
      broadcastId,
      resolvedRecipientCount: 10_000,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected error');
    expect((second.error as { kind: string }).kind).toMatch(
      /BATCH_ALREADY_DISPATCHED|duplicate_idempotency_key/,
    );
  });

  it('emits exactly one broadcast_dispatched_in_batches audit event per call', async () => {
    const { splitBroadcastIntoBatches } = await importSplitUseCase();
    const { deps, emits } = makeStubDeps();

    await splitBroadcastIntoBatches(deps, {
      tenantId: tenant,
      broadcastId,
      resolvedRecipientCount: 30_000,
    });

    expect(emits.filter(isDispatchEvent)).toHaveLength(1);
  });
});

function isDispatchEvent(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'eventType' in e &&
    (e as { eventType: unknown }).eventType === 'broadcast_dispatched_in_batches'
  );
}
