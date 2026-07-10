import { describe, expect, it, vi } from 'vitest';
import { loadRenewalMonthSummary } from '@/modules/renewals/application/use-cases/load-renewal-month-summary';
import type { RenewalMonthAggregation } from '@/modules/renewals/domain/renewal-month-bucket';

const NOW = '2026-07-10T05:00:00Z';

function depsWith(agg: RenewalMonthAggregation) {
  return {
    cyclesRepo: {
      countCyclesByExpiryMonth: vi.fn().mockResolvedValue(agg),
    },
  } as never;
}

describe('loadRenewalMonthSummary', () => {
  it('maps the aggregation into the 14-bucket summary', async () => {
    const deps = depsWith({
      overdueCount: 2,
      months: [{ month: '2026-07', count: 17 }],
      laterCount: 1,
    });
    const result = await loadRenewalMonthSummary(deps, {
      tenantId: 't1',
      nowIso: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buckets).toHaveLength(14);
    expect(result.value.totalCount).toBe(20);
    expect(result.value.maxCount).toBe(17);
    expect(result.value.buckets[0]).toEqual({ key: 'overdue', count: 2 });
    expect(result.value.buckets[13]).toEqual({ key: 'later', count: 1 });
  });

  it('propagates an infra throw (does NOT swallow into an empty summary)', async () => {
    const deps = {
      cyclesRepo: {
        countCyclesByExpiryMonth: vi
          .fn()
          .mockRejectedValue(new Error('db down')),
      },
    } as never;
    await expect(
      loadRenewalMonthSummary(deps, { tenantId: 't1', nowIso: NOW }),
    ).rejects.toThrow('db down');
  });
});
