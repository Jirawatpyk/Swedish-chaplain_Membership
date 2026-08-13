/**
 * T020 (US1) — `listDashboard` contract test (role projections + cold-start).
 *
 * Pure (mocked snapshotRepo / recompute / audit) — `listDashboard` opens no
 * direct DB tx (the repo self-scopes), so all branches are unit-testable:
 *   - member → forbidden (no read/recompute/audit)
 *   - admin  → full snapshot (revenue visible)
 *   - manager → full snapshot too (FR-007 "read-only on finance" — revenue visible)
 *   - cold-start (no cache) → lazy recompute
 *   - recompute failure → snapshot_unavailable
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { ok, err } from '@/lib/result';
import {
  listDashboard,
  hasFinanceMetrics,
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
  tierDistribution: [],
  invoiceStatus: { buckets: [], draftCount: 0 },
  computedAt: '2026-06-15T05:00:00.000Z',
};

function depsWith(over: Partial<ListDashboardDeps> = {}): ListDashboardDeps {
  return {
    snapshotRepo: { read: vi.fn().mockResolvedValue({ metrics: SNAP, computedAt: new Date(SNAP.computedAt), stale: false }) },
    recompute: vi.fn().mockResolvedValue(ok(SNAP)),
    audit: { record: vi.fn().mockResolvedValue(undefined), recordInTx: vi.fn() },
    // Required since the 016 review made the permissive default a finding —
    // the base fixture is a finance holder; cases that test the projection pass
    // `canFinance: false` explicitly through `over`.
    canFinance: true,
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
    if (result.ok && hasFinanceMetrics(result.value.metrics)) {
      expect(result.value.metrics.ytdPaidRevenueSatang).toBe('240000000');
      expect(result.value.metrics.revenueTrend).toHaveLength(1);
      expect(result.value.computedAt).toBe('2026-06-15T05:00:00.000Z');
    } else {
      // 016 T056 — an admin MUST receive the finance fields; without this the
      // `if` above could silently skip its assertions after a bad projection.
      expect.unreachable('admin must receive the finance metrics');
    }
    expect(deps.audit.record).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.audit.record).mock.calls[0]![0]).toMatchObject({
      eventType: 'dashboard_viewed',
      payload: { actor_role: 'admin' },
    });
  });

  it('manager sees revenue read-only — same snapshot as admin (FR-007)', async () => {
    // The "read-only on finance" manager role MAY view revenue figures; the
    // dashboard exposes no finance edit/drill-down so read-only holds.
    const result = await listDashboard(meta('manager'), ctx, depsWith());
    expect(result.ok).toBe(true);
    if (result.ok && hasFinanceMetrics(result.value.metrics)) {
      expect(result.value.metrics.ytdPaidRevenueSatang).toBe('240000000');
      expect(result.value.metrics.revenueTrend).toHaveLength(1);
      expect(result.value.metrics.counts.active).toBe(8);
      expect(result.value.metrics.memberGrowth).toHaveLength(1);
    } else {
      expect.unreachable('manager must receive the finance metrics');
    }
    // Audit still records the manager's dashboard view (FR-036).
  });

  it('emits dashboard_viewed with the manager actor role', async () => {
    const deps = depsWith();
    await listDashboard(meta('manager'), ctx, deps);
    expect(vi.mocked(deps.audit.record).mock.calls[0]![0]).toMatchObject({
      eventType: 'dashboard_viewed',
      payload: { actor_role: 'manager' },
    });
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
    if (result.ok && hasFinanceMetrics(result.value.metrics)) {
      expect(result.value.metrics.counts.total).toBe(10);
      expect(result.value.metrics.ytdPaidRevenueSatang).toBe('240000000');
    } else {
      expect.unreachable('a failed audit write must not change the projection');
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

/**
 * T054 / T056 (016 PR 4, US3) — the engagement/finance projection split.
 *
 * `listDashboard` denies only `'member'`. The moment PR 4 makes `marketing`
 * assignable, a marketing session therefore receives the FULL snapshot — YTD
 * paid revenue, the 12-month revenue trend, the receivables distribution and the
 * overdue counts. That is a server-side payload leak: hiding those widgets in
 * the page would still ship the numbers over the wire.
 *
 * The requirement (T056) is that finance data be ABSENT from the payload, not
 * merely unrendered, so these assertions use `in` rather than checking for
 * zero/undefined values — a zeroed field is still a field.
 *
 * `canFinance` is INJECTED rather than derived from the role inside the use
 * case: Application code must not re-implement the permission model, and the
 * composition root already has `canPerform`. It also keeps this test honest —
 * it exercises the projection, not a role literal.
 */
describe('listDashboard finance projection (T054/T056)', () => {
  const FINANCE_TOP_LEVEL = ['ytdPaidRevenueSatang', 'revenueTrend', 'invoiceStatus'] as const;

  it('omits every finance field when the viewer lacks insights.finance', async () => {
    const result = await listDashboard(meta('marketing'), ctx, depsWith({ canFinance: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.value.metrics as Record<string, unknown>;

    for (const field of FINANCE_TOP_LEVEL) {
      expect(field in m, `${field} must be absent, not zeroed`).toBe(false);
    }
    // Nested finance members are stripped too — the containers survive because
    // they also carry engagement data.
    expect('overdueInvoices' in (m.needsAttention as object)).toBe(false);
    expect('overdue' in (m.counts as object)).toBe(false);
  });

  it('keeps every engagement field for the same viewer (no empty dashboard)', async () => {
    const result = await listDashboard(meta('marketing'), ctx, depsWith({ canFinance: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.value.metrics;

    expect(m.counts.total).toBe(10);
    expect(m.counts.active).toBe(8);
    expect(m.counts.atRisk).toBe(2);
    expect(m.memberGrowth).toHaveLength(1);
    expect(m.needsAttention.atRiskMembers).toBe(2);
    expect(m.needsAttention.broadcastsAwaitingApproval).toBe(0);
    expect(m.computedAt).toBe(SNAP.computedAt);
  });

  it('manager keeps the finance fields — it holds insights.finance (D4 did not touch it)', async () => {
    // Guards the split against being keyed on "is administrative" instead of on
    // the permission: `tests/e2e/f9-dashboard.spec.ts` pins manager seeing the
    // revenue KPI and the revenue-trend chart.
    const result = await listDashboard(meta('manager'), ctx, depsWith({ canFinance: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const m = result.value.metrics;
    // The guard IS the assertion — a regression that projected the manager's
    // finance fields away would fail here rather than silently compare
    // `undefined` against the expected figure.
    expect(hasFinanceMetrics(m)).toBe(true);
    if (!hasFinanceMetrics(m)) return;
    expect(m.ytdPaidRevenueSatang).toBe('240000000');
    expect(m.revenueTrend).toHaveLength(1);
    expect(m.invoiceStatus).toBeDefined();
    expect(m.counts.overdue).toBe(0);
    expect(m.needsAttention.overdueInvoices).toBe(0);
  });

  it('a field added to the snapshot later does NOT reach an engagement viewer', async () => {
    // The projection is built by naming the engagement fields, not by deleting
    // the finance ones. This pins that choice: a future snapshot field — which
    // is far more likely to be finance than engagement, since engagement is
    // already complete — must be excluded by DEFAULT and require a deliberate
    // edit to reach marketing. A spread-minus-blocklist implementation passes
    // every other test in this file and fails this one.
    const withNewField = { ...SNAP, someFutureRevenueField: '999' } as DashboardSnapshot;
    const result = await listDashboard(
      meta('marketing'),
      ctx,
      depsWith({
        snapshotRepo: {
          read: vi.fn().mockResolvedValue({
            metrics: withNewField,
            computedAt: new Date(SNAP.computedAt),
            stale: false,
          }),
        },
        canFinance: false,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('someFutureRevenueField' in (result.value.metrics as Record<string, unknown>)).toBe(
      false,
    );
  });

  it('projects the cold-start recompute result too, not only the cached one', async () => {
    // The narrowing must sit AFTER both branches converge. If it were applied
    // only to the cached read, a cold start would leak the full snapshot — and
    // cold starts are exactly when a new marketing hire first opens the page.
    const result = await listDashboard(
      meta('marketing'),
      ctx,
      depsWith({
        snapshotRepo: { read: vi.fn().mockResolvedValue(null) },
        recompute: vi.fn().mockResolvedValue(ok(SNAP)),
        canFinance: false,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('ytdPaidRevenueSatang' in (result.value.metrics as Record<string, unknown>)).toBe(false);
  });
});
