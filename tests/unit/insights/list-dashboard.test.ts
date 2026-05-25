/**
 * T020 (US1) — `listDashboard` contract test (role projections + cold-start).
 *
 * Pure (mocked snapshotRepo / recompute / audit) — `listDashboard` opens no
 * direct DB tx (the repo self-scopes), so all branches are unit-testable:
 *   - member → forbidden (no read/recompute/audit)
 *   - admin  → full snapshot (revenue visible)
 *   - manager → finance-redacted (revenue null)
 *   - cold-start (no cache) → lazy recompute
 *   - recompute failure → snapshot_unavailable
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { ok, err } from '@/lib/result';
import {
  listDashboard,
  type ListDashboardDeps,
  type ListDashboardMeta,
} from '@/modules/insights/application/use-cases/list-dashboard';
import type { DashboardSnapshot } from '@/modules/insights/domain/dashboard-snapshot';

const ctx = asTenantContext('test-tenant');

const SNAP: DashboardSnapshot = {
  counts: { total: 10, active: 8, atRisk: 2, overdue: 0 },
  ytdPaidRevenueSatang: '240000000',
  underDeliveredBenefitCount: 0,
  needsAttention: { broadcastsAwaitingApproval: 0, overdueInvoices: 0, atRiskMembers: 2 },
  revenueTrend: [{ month: '2026-06', satang: '240000000' }],
  memberGrowth: [{ month: '2026-06', cumulative: 10 }],
  topInsights: [{ key: 'at_risk_followup', count: 2 }],
  computedAt: '2026-06-15T05:00:00.000Z',
};

function depsWith(over: Partial<ListDashboardDeps> = {}): ListDashboardDeps {
  return {
    snapshotRepo: { read: vi.fn().mockResolvedValue({ metrics: SNAP, computedAt: new Date(SNAP.computedAt), stale: false }) },
    recompute: vi.fn().mockResolvedValue(ok(SNAP)),
    audit: { record: vi.fn().mockResolvedValue(undefined), recordInTx: vi.fn() },
    ...over,
  };
}

const meta = (role: ListDashboardMeta['actorRole']): ListDashboardMeta => ({
  actorUserId: 'u-1',
  actorRole: role,
  requestId: 'req-1',
});

describe('listDashboard', () => {
  it('denies a member without reading the snapshot', async () => {
    const deps = depsWith();
    const result = await listDashboard(meta('member'), ctx, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
    expect(deps.snapshotRepo.read).not.toHaveBeenCalled();
    expect(deps.recompute).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('admin sees the full snapshot incl. YTD revenue + emits dashboard_viewed', async () => {
    const deps = depsWith();
    const result = await listDashboard(meta('admin'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.financeRedacted).toBe(false);
      expect(result.value.metrics.ytdPaidRevenueSatang).toBe('240000000');
      expect(result.value.computedAt).toBe('2026-06-15T05:00:00.000Z');
    }
    expect(deps.audit.record).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.audit.record).mock.calls[0]![0]).toMatchObject({
      eventType: 'dashboard_viewed',
      payload: { actor_role: 'admin' },
    });
  });

  it('manager sees a finance-redacted snapshot (revenue null)', async () => {
    const result = await listDashboard(meta('manager'), ctx, depsWith());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.financeRedacted).toBe(true);
      expect(result.value.metrics.ytdPaidRevenueSatang).toBeNull();
      // non-finance counts remain visible
      expect(result.value.metrics.counts.active).toBe(8);
    }
  });

  it('cold-start (no cache) lazily recomputes the snapshot', async () => {
    const deps = depsWith({ snapshotRepo: { read: vi.fn().mockResolvedValue(null) } });
    const result = await listDashboard(meta('admin'), ctx, deps);
    expect(result.ok).toBe(true);
    expect(deps.recompute).toHaveBeenCalledOnce();
    if (result.ok) expect(result.value.metrics.counts.total).toBe(10);
  });

  it('surfaces snapshot_unavailable when cold-start recompute fails', async () => {
    const deps = depsWith({
      snapshotRepo: { read: vi.fn().mockResolvedValue(null) },
      recompute: vi.fn().mockResolvedValue(err('compute_failed')),
    });
    const result = await listDashboard(meta('admin'), ctx, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('snapshot_unavailable');
  });

  it('does NOT block the read when the audit write throws (FR-036, best-effort)', async () => {
    // A misbehaving audit port impl that throws must never fail the dashboard
    // read — the use-case wraps the best-effort emit in try/catch.
    const deps = depsWith({
      audit: {
        record: vi.fn().mockRejectedValue(new Error('audit_log unavailable')),
        recordInTx: vi.fn(),
      },
    });
    const result = await listDashboard(meta('admin'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.metrics.counts.total).toBe(10);
      expect(result.value.metrics.ytdPaidRevenueSatang).toBe('240000000');
    }
    expect(deps.audit.record).toHaveBeenCalledOnce();
  });

  it('survives a non-Error audit rejection (errKind → "unknown")', async () => {
    // Covers the `e instanceof Error ? … : 'unknown'` false branch — a port
    // that rejects with a non-Error value must still not block the read.
    const deps = depsWith({
      audit: {
        record: vi.fn().mockRejectedValue('string failure'),
        recordInTx: vi.fn(),
      },
    });
    const result = await listDashboard(meta('admin'), ctx, deps);
    expect(result.ok).toBe(true);
  });
});
