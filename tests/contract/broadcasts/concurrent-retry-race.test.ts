/**
 * T035 — Contract test: concurrent retry race (US1 / FR-008d / SC-007).
 *
 * Authored RED 2026-05-19 per Constitution II NON-NEG TDD. Phase 3
 * Cluster B implements at:
 *   src/modules/broadcasts/application/use-cases/retry-failed-batches.ts
 *
 * Contract spec: specs/014-email-broadcast-advance/contracts/batch-dispatch.md § 1.3
 * (concurrent-action semantics) + spec.md § Edge Cases L106
 * (per-broadcast advisory lock `broadcasts-retry:` namespace).
 *
 * Invariants under test:
 *   - 2 simultaneous `retryFailedBatches` calls → exactly 1 acquires
 *     the lock and proceeds; the OTHER returns
 *     `ALREADY_RETRYING_IN_PROGRESS` WITHOUT incrementing
 *     `manual_retry_count` (budget preservation per FR-008d).
 *   - The losing call must NOT mutate state (no audit emit, no
 *     broadcast status change).
 *   - Advisory-lock key namespace is `broadcasts-retry:` (DISJOINT
 *     from `broadcasts-batch:` per-batch lock and F7 MVP
 *     `broadcasts:` namespace).
 *
 * This is the SC-007 100% requirement: concurrent admin retries from
 * 2 browser tabs MUST NOT exhaust the budget via double-click.
 */
import { describe, expect, it } from 'vitest';

import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';

async function importRetryUseCase(): Promise<{
  retryFailedBatches: (
    deps: unknown,
    input: unknown,
  ) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
}> {
  const path =
    '@/modules/broadcasts/application/use-cases/retry-failed-batches';
  try {
    const mod = await new Function('m', 'return import(m)')(path);
    return mod as never;
  } catch (err) {
    throw new Error(
      `[RED — T047] retry-failed-batches use case not yet implemented: ${String(err)}`,
    );
  }
}

const tenant = asTenantContext('test-tenant');
const broadcastId = asBroadcastId('44444444-4444-4444-4444-444444444444');

/**
 * Lock simulator — first call wins (returns { acquired: true }), every
 * subsequent call DURING the first's tx returns { acquired: false }.
 * The advisory-lock port in the real impl will use Postgres
 * `pg_advisory_xact_lock` with `xact` scope so the lock auto-releases
 * at transaction end; here we simulate via a held-lock flag.
 */
function makeAdvisoryLockSimulator(): {
  acquireCalls: string[];
  port: {
    acquire: (lockKey: string) => Promise<{ acquired: boolean }>;
  };
} {
  const acquireCalls: string[] = [];
  let heldLockKey: string | null = null;
  return {
    acquireCalls,
    port: {
      async acquire(lockKey: string) {
        acquireCalls.push(lockKey);
        if (heldLockKey === null) {
          heldLockKey = lockKey;
          // Schedule release at next microtask (simulates tx commit)
          queueMicrotask(() => {
            heldLockKey = null;
          });
          return { acquired: true };
        }
        return { acquired: false };
      },
    },
  };
}

function makeStubDeps(advisoryLock: {
  acquire: (lockKey: string) => Promise<{ acquired: boolean }>;
}): {
  emits: Array<{ eventType: string }>;
  manualRetryCountAfter: () => number;
  deps: unknown;
} {
  const emits: Array<{ eventType: string }> = [];
  let manualRetryCount = 1;

  return {
    emits,
    manualRetryCountAfter: () => manualRetryCount,
    deps: {
      audit: {
        async emit(_tx: unknown, e: { eventType: string }) {
          emits.push(e);
        },
      },
      broadcasts: {
        async findById(_t: unknown, _id: unknown) {
          return {
            tenantId: 'test-tenant',
            broadcastId,
            status: 'partially_sent' as const,
            manualRetryCount,
          };
        },
        async incrementManualRetryCount(_t: unknown, _id: unknown) {
          manualRetryCount += 1;
          return { ok: true, value: manualRetryCount };
        },
      },
      batchManifests: {
        async findByBroadcast(_t: unknown, _id: unknown) {
          return [{ id: 'batch-1', batchIndex: 0, status: 'failed' as const }];
        },
        async updateStatus(_t: unknown, _id: unknown, _u: unknown) {
          return { ok: true, value: {} };
        },
      },
      advisoryLock,
      clock: { now: () => new Date('2026-06-15T05:00:00Z') },
    },
  };
}

describe('concurrent retry race contract (T035, SC-007)', () => {
  it('2 simultaneous retry calls → exactly 1 proceeds; loser returns ALREADY_RETRYING_IN_PROGRESS', async () => {
    const { retryFailedBatches } = await importRetryUseCase();
    const lockSim = makeAdvisoryLockSimulator();
    const { deps, emits, manualRetryCountAfter } = makeStubDeps(lockSim.port);

    const [resultA, resultB] = await Promise.all([
      retryFailedBatches(deps, {
        tenantId: tenant,
        broadcastId,
        actorUserId: 'admin-tab-A',
      }),
      retryFailedBatches(deps, {
        tenantId: tenant,
        broadcastId,
        actorUserId: 'admin-tab-B',
      }),
    ]);

    // Exactly one success, exactly one rejection
    const successes = [resultA, resultB].filter((r) => r.ok);
    const failures = [resultA, resultB].filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    expect(
      (failures[0]?.error as { kind: string } | undefined)?.kind,
    ).toBe('ALREADY_RETRYING_IN_PROGRESS');

    // Budget consumed exactly once (initial 1 → 2), NOT twice
    expect(manualRetryCountAfter()).toBe(2);

    // Audit: exactly 1 retry_initiated emitted (the winner's)
    const initiatedEvents = emits.filter((e) => e.eventType === 'broadcast_retry_initiated');
    expect(initiatedEvents).toHaveLength(1);
  });

  it('advisory-lock key uses broadcasts-retry: namespace (NOT broadcasts-batch: or broadcasts:)', async () => {
    const { retryFailedBatches } = await importRetryUseCase();
    const lockSim = makeAdvisoryLockSimulator();
    const { deps } = makeStubDeps(lockSim.port);

    await retryFailedBatches(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId: 'admin-tab-A',
    });

    expect(lockSim.acquireCalls).toHaveLength(1);
    const key = lockSim.acquireCalls[0] ?? '';
    expect(key).toMatch(/^broadcasts-retry:/);
    expect(key).toContain('test-tenant');
    expect(key).toContain(String(broadcastId));
    // MUST NOT use F7 MVP or per-batch namespace
    expect(key).not.toMatch(/^broadcasts:/);
    expect(key).not.toMatch(/^broadcasts-batch:/);
  });

  it('lock-acquire failure on first call → returns ALREADY_RETRYING_IN_PROGRESS, no state mutation', async () => {
    const { retryFailedBatches } = await importRetryUseCase();
    // Simulator that ALWAYS denies
    const denyingLock = {
      async acquire(_lockKey: string) {
        return { acquired: false };
      },
    };
    const { deps, emits, manualRetryCountAfter } = makeStubDeps(denyingLock);

    const result = await retryFailedBatches(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId: 'admin-tab-X',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('ALREADY_RETRYING_IN_PROGRESS');

    // Budget unchanged
    expect(manualRetryCountAfter()).toBe(1);
    // No audit emitted on lock-denial path
    expect(emits.filter((e) => e.eventType === 'broadcast_retry_initiated')).toHaveLength(0);
  });
});
