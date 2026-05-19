/**
 * H-9 test (2026-05-15) — `buildBatchPorts` savepoint factory unit
 * coverage.
 *
 * The `makeImportCsvDeps()` factory in `infrastructure/di.ts` recursively
 * builds tx-scoped port bundles where the outer-tx bundle exposes
 * `runRowInSavepoint` that opens a Drizzle nested-tx (Postgres
 * SAVEPOINT). This unit test pins the contract:
 *
 *   1. `runRowInSavepoint` invokes `outerTx.transaction(...)` —
 *      crucially NOT `spTx.transaction(...)` on the savepoint handle.
 *      A future "simplification" that swaps `outerTx` → the inner `tx`
 *      argument would silently break per-row isolation: every savepoint
 *      would NEST inside the previous one instead of being SIBLINGS
 *      on the outer tx, and a single row failure would unwind all
 *      subsequent rows in the batch.
 *
 *   2. The savepoint-bound ports are NEW instances bound to the
 *      savepoint tx — NOT pointers to the outer-tx adapters.
 *
 *   3. Two sequential `runRowInSavepoint` calls produce SIBLING
 *      savepoints (both open on `outerTx`, not nested in each other).
 *
 * Pure unit test — no DB connection; mocks the Drizzle `tx.transaction`
 * with `vi.fn()` to observe the call shape.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TenantTx } from '@/lib/db';
import { makeImportCsvDeps } from '@/modules/events';

// Mock chamber-app + tenant-context setup so `runInTenant` short-
// circuits to the inner callback.
vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  return {
    ...actual,
    runInTenant: vi.fn(async (_ctx, fn) => {
      const outerTxTransaction = vi.fn(async (innerFn) => {
        // Simulate Drizzle's nested-tx returning a fresh tx handle
        // with its OWN transaction method (proves the savepoint port
        // bundle gets a new TenantTx, not the outer one verbatim).
        const spTx = { execute: vi.fn(), transaction: vi.fn() };
        return innerFn(spTx as unknown as TenantTx);
      });
      const outerTx = {
        execute: vi.fn(),
        transaction: outerTxTransaction,
      } as unknown as TenantTx;
      // Attach to outer-scope so the test can introspect.
      (
        globalThis as unknown as { __H9_OUTER_TX__: typeof outerTx }
      ).__H9_OUTER_TX__ = outerTx;
      (
        globalThis as unknown as {
          __H9_OUTER_TX_TRANSACTION__: typeof outerTxTransaction;
        }
      ).__H9_OUTER_TX_TRANSACTION__ = outerTxTransaction;
      return fn(outerTx);
    }),
  };
});

// All the adapter factories must be stubbed so they don't issue real
// queries; they just need to be callable.
vi.mock('@/modules/events/infrastructure/drizzle-events-repository', () => ({
  makeDrizzleEventsRepository: (tx: unknown) => ({ __tx: tx }),
}));
vi.mock(
  '@/modules/events/infrastructure/drizzle-registrations-repository',
  () => ({ makeDrizzleRegistrationsRepository: (tx: unknown) => ({ __tx: tx }) }),
);
vi.mock('@/modules/events/infrastructure/drizzle-idempotency-store', () => ({
  makeDrizzleIdempotencyStore: (tx: unknown) => ({ __tx: tx }),
}));
vi.mock('@/modules/events/infrastructure/drizzle-attendee-matcher', () => ({
  makeDrizzleAttendeeMatcher: (tx: unknown) => ({ __tx: tx }),
}));
vi.mock(
  '@/modules/events/infrastructure/drizzle-quota-accounting-adapter',
  () => ({
    makeDrizzleQuotaAccountingAdapter: (tx: unknown) => ({ __tx: tx }),
  }),
);
vi.mock(
  '@/modules/events/infrastructure/drizzle-advisory-lock-acquirer',
  () => ({ makeDrizzleAdvisoryLockAcquirer: (tx: unknown) => ({ __tx: tx }) }),
);
vi.mock('@/modules/events/infrastructure/pino-audit-port', () => ({
  makePinoAuditPort: (tx: unknown) => ({ __tx: tx }),
}));
vi.mock(
  '@/modules/events/infrastructure/streaming-csv-importer',
  () => ({ streamingCsvImporter: { parseStream: vi.fn() } }),
);
vi.mock('@/modules/tenants', async () => {
  const actual = await vi.importActual<typeof import('@/modules/tenants')>(
    '@/modules/tenants',
  );
  return {
    ...actual,
    asTenantContext: (slug: string) => ({ slug }),
  };
});

describe('H-9 — buildBatchPorts savepoint factory', () => {
  it('runRowInSavepoint invokes outerTx.transaction (not the inner tx)', async () => {
    const deps = makeImportCsvDeps();

    let observedOuterTx: unknown;
    await deps.runInTenantTx('test-chamber', async (batchPorts) => {
      observedOuterTx = (batchPorts.eventsRepo as unknown as { __tx: unknown }).__tx;
      await batchPorts.runRowInSavepoint(async () => Promise.resolve(undefined));
    });

    // The outer-batch ports were bound to the outer tx.
    const stashedOuterTx = (
      globalThis as unknown as { __H9_OUTER_TX__: unknown }
    ).__H9_OUTER_TX__;
    expect(observedOuterTx).toBe(stashedOuterTx);

    // `runRowInSavepoint` MUST have invoked `outerTx.transaction(...)`,
    // not anything on the inner spTx. The mock attached
    // `__H9_OUTER_TX_TRANSACTION__` and we check it received exactly
    // one call.
    const outerTxTransaction = (
      globalThis as unknown as {
        __H9_OUTER_TX_TRANSACTION__: ReturnType<typeof vi.fn>;
      }
    ).__H9_OUTER_TX_TRANSACTION__;
    expect(outerTxTransaction).toHaveBeenCalledTimes(1);
  });

  it('savepoint-bound ports are fresh adapter instances bound to the savepoint tx (not the outer tx)', async () => {
    const deps = makeImportCsvDeps();

    let outerEventsRepoTx: unknown;
    let spEventsRepoTx: unknown;
    await deps.runInTenantTx('test-chamber', async (batchPorts) => {
      outerEventsRepoTx = (batchPorts.eventsRepo as unknown as { __tx: unknown }).__tx;
      await batchPorts.runRowInSavepoint(async (spPorts) => {
        spEventsRepoTx = (spPorts.eventsRepo as unknown as { __tx: unknown }).__tx;
      });
    });

    // savepoint port's eventsRepo is bound to a DIFFERENT tx handle
    // than the outer-batch's eventsRepo — proves the recursion
    // rebinds adapters to the savepoint scope.
    expect(spEventsRepoTx).toBeDefined();
    expect(outerEventsRepoTx).toBeDefined();
    expect(spEventsRepoTx).not.toBe(outerEventsRepoTx);
  });

  it('two sequential runRowInSavepoint calls produce SIBLING savepoints on the outer tx', async () => {
    const deps = makeImportCsvDeps();

    await deps.runInTenantTx('test-chamber', async (batchPorts) => {
      await batchPorts.runRowInSavepoint(async () => Promise.resolve(undefined));
      await batchPorts.runRowInSavepoint(async () => Promise.resolve(undefined));
    });

    // Two SIBLING savepoints means `outerTx.transaction` was called
    // TWICE on the outer tx — not once on outer + once on a sibling.
    const outerTxTransaction = (
      globalThis as unknown as {
        __H9_OUTER_TX_TRANSACTION__: ReturnType<typeof vi.fn>;
      }
    ).__H9_OUTER_TX_TRANSACTION__;
    expect(outerTxTransaction).toHaveBeenCalledTimes(2);
  });
});
