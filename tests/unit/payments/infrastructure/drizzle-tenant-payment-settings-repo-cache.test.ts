/**
 * Cache-wrapper memoisation invariant for `drizzle-tenant-payment-settings-repo`.
 *
 * Found 2026-04-27 during T148 perf benchmark scaffolding: the audit comment
 * "Audit 2026-04-25 finding #10" claimed the wrapper instances were
 * reused per tenant, but the previous implementation rebuilt the
 * `unstable_cache(...)` wrapper on EVERY call to `cachedGetByTenantId(tenantId)`
 * — only the factory function was at module scope, not the per-key wrapper.
 *
 * Fix: per-key memoisation via a module-scoped Map. This test locks down
 * the invariant so a future refactor cannot regress.
 *
 * Mocking policy: `next/cache` is stubbed because `unstable_cache` requires
 * a Next.js request context which is not available in Vitest. The stub
 * returns the inner async fn unchanged so the per-key memoisation logic
 * is observable: same key → same wrapper reference, distinct keys → distinct
 * wrappers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => {
  // Each call returns a NEW thunk so a regressing impl that allocates
  // per-call would yield distinct references. The memoised impl wraps
  // each thunk in a Map and yields the same reference for the same key.
  return {
    unstable_cache: vi.fn(<T>(fn: () => Promise<T>) => {
      // Return a fresh wrapper closure per call to mirror Next.js's
      // shape (its return is a new function each invocation).
      return () => fn();
    }),
    revalidateTag: vi.fn(),
  };
});

vi.mock('@/lib/db', () => {
  const fluent = {
    select: vi.fn(() => fluent),
    from: vi.fn(() => fluent),
    where: vi.fn(() => fluent),
    limit: vi.fn(() => Promise.resolve([])),
  };
  return {
    db: fluent,
    runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(fluent),
    ),
  };
});

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));

import {
  makeDrizzleTenantPaymentSettingsRepo,
  __resetTenantPaymentSettingsRepoCache,
} from '@/modules/payments/infrastructure/repos/drizzle-tenant-payment-settings-repo';
import * as nextCache from 'next/cache';

describe('drizzle-tenant-payment-settings-repo — wrapper memoisation', () => {
  afterEach(() => {
    __resetTenantPaymentSettingsRepoCache();
    vi.mocked(nextCache.unstable_cache).mockClear();
  });

  it('repeat getByTenantId calls for same tenant invoke unstable_cache exactly once', async () => {
    const repo = makeDrizzleTenantPaymentSettingsRepo();
    await repo.getByTenantId('tnt-A');
    await repo.getByTenantId('tnt-A');
    await repo.getByTenantId('tnt-A');

    // Memoised: ONE wrapper construction across 3 calls.
    expect(vi.mocked(nextCache.unstable_cache).mock.calls.length).toBe(1);
  });

  it('distinct tenants get distinct wrappers (no cross-tenant leakage)', async () => {
    const repo = makeDrizzleTenantPaymentSettingsRepo();
    await repo.getByTenantId('tnt-A');
    await repo.getByTenantId('tnt-B');
    await repo.getByTenantId('tnt-C');

    // 3 distinct keys → 3 wrapper constructions.
    expect(vi.mocked(nextCache.unstable_cache).mock.calls.length).toBe(3);
  });

  it('mixing getByTenantId and findByProcessorAccountId memoises independently', async () => {
    const repo = makeDrizzleTenantPaymentSettingsRepo();
    await repo.getByTenantId('tnt-A');
    await repo.getByTenantId('tnt-A'); // dedupe
    await repo.findByProcessorAccountId('acct_test_123');
    await repo.findByProcessorAccountId('acct_test_123'); // dedupe
    await repo.findByProcessorAccountId('acct_test_456'); // new

    // 1 (tnt-A) + 1 (acct_test_123) + 1 (acct_test_456) = 3 wrapper constructions.
    expect(vi.mocked(nextCache.unstable_cache).mock.calls.length).toBe(3);
  });

  it('__resetTenantPaymentSettingsRepoCache forces wrapper rebuild on next call', async () => {
    const repo = makeDrizzleTenantPaymentSettingsRepo();
    await repo.getByTenantId('tnt-A');
    expect(vi.mocked(nextCache.unstable_cache).mock.calls.length).toBe(1);

    __resetTenantPaymentSettingsRepoCache();
    await repo.getByTenantId('tnt-A');
    // Reset cleared the Map → the next call MUST rebuild the wrapper.
    expect(vi.mocked(nextCache.unstable_cache).mock.calls.length).toBe(2);
  });
});
