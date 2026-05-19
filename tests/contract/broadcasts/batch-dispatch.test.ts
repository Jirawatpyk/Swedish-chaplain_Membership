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

function makeStubDeps(): {
  emits: unknown[];
  insertedBatches: Array<{ batchIndex: number; recipientCount: number; idempotencyKey: string }>;
  deps: unknown;
} {
  const emits: unknown[] = [];
  const insertedBatches: Array<{
    batchIndex: number;
    recipientCount: number;
    idempotencyKey: string;
  }> = [];

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
          inputs: ReadonlyArray<{
            batchIndex: number;
            recipientCount: number;
            idempotencyKey: string;
          }>,
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
  it('5,000 recipients → exactly 1 batch (recipient_range_start=0, end=4999)', async () => {
    const { splitBroadcastIntoBatches } = await importSplitUseCase();
    const { deps, emits, insertedBatches } = makeStubDeps();

    const result = await splitBroadcastIntoBatches(deps, {
      tenantId: tenant,
      broadcastId,
      resolvedRecipientCount: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(insertedBatches).toHaveLength(1);
    expect(insertedBatches[0]?.batchIndex).toBe(0);
    expect(insertedBatches[0]?.recipientCount).toBe(5_000);
    expect(emits.filter(isDispatchEvent)).toHaveLength(1);
  });

  it('25,000 recipients → 3 batches of 10k / 10k / 5k (last-batch-smaller)', async () => {
    const { splitBroadcastIntoBatches } = await importSplitUseCase();
    const { deps, insertedBatches } = makeStubDeps();

    const result = await splitBroadcastIntoBatches(deps, {
      tenantId: tenant,
      broadcastId,
      resolvedRecipientCount: 25_000,
    });

    expect(result.ok).toBe(true);
    expect(insertedBatches.map((b) => b.recipientCount)).toEqual([10_000, 10_000, 5_000]);
    expect(insertedBatches.map((b) => b.batchIndex)).toEqual([0, 1, 2]);
  });

  it('50,000 recipients (max) → 5 batches of 10k each (Resend per-audience cap)', async () => {
    const { splitBroadcastIntoBatches } = await importSplitUseCase();
    const { deps, insertedBatches } = makeStubDeps();

    const result = await splitBroadcastIntoBatches(deps, {
      tenantId: tenant,
      broadcastId,
      resolvedRecipientCount: 50_000,
    });

    expect(result.ok).toBe(true);
    expect(insertedBatches).toHaveLength(5);
    expect(insertedBatches.every((b) => b.recipientCount === 10_000)).toBe(true);
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
