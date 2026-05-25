/**
 * `listSmartInsights` unit test — live dismissal re-filter (T028 / FR-004).
 *
 * `runInTenant` is mocked to invoke the callback with a dummy tx so the pure
 * filtering logic is unit-testable without a DB.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  runInTenant: <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) => fn({}),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { asTenantContext } from '@/modules/tenants';
import {
  listSmartInsights,
  type ListSmartInsightsDeps,
} from '@/modules/insights/application/use-cases/list-smart-insights';
import type { DashboardSnapshot } from '@/modules/insights/domain/dashboard-snapshot';

const ctx = asTenantContext('test-tenant');

function snapshotWith(
  topInsights: DashboardSnapshot['topInsights'],
): DashboardSnapshot {
  return {
    counts: { total: 0, active: 0, atRisk: 0, overdue: 0 },
    ytdPaidRevenueSatang: '0',
    underDeliveredBenefitCount: 0,
    needsAttention: { broadcastsAwaitingApproval: 0, overdueInvoices: 0, atRiskMembers: 0 },
    revenueTrend: [],
    memberGrowth: [],
    topInsights,
    computedAt: '2026-06-15T05:00:00.000Z',
  };
}

function depsWith(
  snapshot: DashboardSnapshot | null,
  isDismissed: (key: string) => boolean | Promise<never>,
): ListSmartInsightsDeps {
  return {
    snapshotRepo: {
      read: vi.fn().mockResolvedValue(
        snapshot
          ? { metrics: snapshot, computedAt: new Date(snapshot.computedAt), stale: false }
          : null,
      ),
    },
    dismissalRepo: {
      isDismissedInTx: vi.fn((_tx, key: string) => Promise.resolve(isDismissed(key))),
    },
    clock: { now: () => new Date('2026-06-15T05:00:00.000Z') },
    tenantTimezone: 'Asia/Bangkok',
  };
}

describe('listSmartInsights', () => {
  it('returns [] on cold-start (no cached snapshot)', async () => {
    const r = await listSmartInsights(ctx, depsWith(null, () => false));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('returns [] when the snapshot has no insights', async () => {
    const r = await listSmartInsights(ctx, depsWith(snapshotWith([]), () => false));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('drops insights dismissed since the last compute', async () => {
    const snap = snapshotWith([
      { key: 'at_risk_followup', count: 3 },
      { key: 'unused_eblast_quota', count: 2 },
    ]);
    const r = await listSmartInsights(
      ctx,
      depsWith(snap, (key) => key === 'at_risk_followup'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((i) => i.key)).toEqual(['unused_eblast_quota']);
  });

  it('keeps all insights when none are dismissed', async () => {
    const snap = snapshotWith([
      { key: 'at_risk_followup', count: 3 },
      { key: 'unused_eblast_quota', count: 2 },
    ]);
    const r = await listSmartInsights(ctx, depsWith(snap, () => false));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(2);
  });

  it('falls back to cached insights when the live dismissal check throws', async () => {
    const snap = snapshotWith([{ key: 'at_risk_followup', count: 3 }]);
    const r = await listSmartInsights(
      ctx,
      depsWith(snap, () => {
        throw new Error('db down');
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(1);
  });
});
