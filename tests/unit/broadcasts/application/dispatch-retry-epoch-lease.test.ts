/**
 * Spec 140 s2b (A3) — `dispatchRetryEpoch` and `resetDispatchRetryClock` carry
 * the import tick's lease to the repo, and a LOST lease on
 * `markDispatchRetryStarted` (the adapter answers `null`, as for a row that left
 * `approved`) is the caller's "stop, no terminal write" answer — never a stamp
 * failure: no `retry_epoch_stamp_failed` line, no
 * `broadcasts_dispatch_retry_stamp_failed_total`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import {
  dispatchRetryEpoch,
  resetDispatchRetryClock,
} from '@/modules/broadcasts/application/use-cases/_dispatch-retry-epoch';

const tenant = asTenantContext('test-tenant');
const ID = asBroadcastId('66666666-6666-4666-8666-666666666666');
const NOW = new Date('2026-11-01T03:00:00Z');
const TOKEN = 'bbbbbbbb-0000-4000-8000-00000000000b';

afterEach(() => vi.restoreAllMocks());

describe('spec 140 s2b — the FR-021 clock under the dispatch lease (A3)', () => {
  it('a lost lease on markDispatchRetryStarted answers null and is NOT a stamp failure', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const failed = vi.spyOn(broadcastsMetrics, 'dispatchRetryStampFailed').mockImplementation(() => undefined);
    const mark = vi.fn(async () => null);
    const deps = {
      tenant,
      broadcastsRepo: { withTx: async <T>(fn: (tx: unknown) => Promise<T>) => fn(null), markDispatchRetryStarted: mark },
    };
    const epoch = await dispatchRetryEpoch(
      deps as never,
      ID,
      { dispatchFirstFailedAt: null } as never,
      NOW,
      'broadcasts.audience_import.retry_epoch_stamp_failed',
      TOKEN as never,
    );
    expect(epoch).toBeNull();
    expect(mark).toHaveBeenCalledWith(null, tenant.slug, ID, NOW, TOKEN);
    expect(warn).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it('resetDispatchRetryClock forwards the lease', async () => {
    const clear = vi.fn(async () => undefined);
    const deps = {
      tenant,
      broadcastsRepo: { withTx: async <T>(fn: (tx: unknown) => Promise<T>) => fn(null), clearDispatchRetryClock: clear },
    };
    await resetDispatchRetryClock(deps as never, ID, 'broadcasts.audience_import.retry_clock_clear_failed', TOKEN as never);
    expect(clear).toHaveBeenCalledWith(null, tenant.slug, ID, TOKEN);
  });
});
