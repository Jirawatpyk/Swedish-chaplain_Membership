/**
 * T022 (US1) — `computeDashboardSnapshot` integration test (live Neon).
 *
 * Seeds members in known states (status + risk band) and asserts the cached
 * snapshot's membership counts, at-risk count, and the at_risk_followup insight
 * — plus that a dismissal suppresses the insight for the current cycle (FR-004).
 *
 * Increment 1 scope: counts + at-risk insight via MemberSource. Revenue /
 * overdue / broadcasts / under-delivered are 0 here (documented follow-ups).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  computeDashboardSnapshot,
  dismissInsight,
  makeComputeDashboardSnapshotDeps,
  makeDismissInsightDeps,
} from '@/modules/insights';
import { dashboardMetricsCache, smartInsightDismissals } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

type Band = 'healthy' | 'warning' | 'at-risk' | 'critical';

describe('F9 computeDashboardSnapshot — integration (T022)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-snap-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const seed: Array<{ status: 'active' | 'inactive' | 'archived'; band: Band | null }> = [
      { status: 'active', band: 'healthy' },
      { status: 'active', band: 'healthy' },
      { status: 'active', band: null },
      { status: 'active', band: 'warning' },
      { status: 'active', band: 'at-risk' },
      { status: 'active', band: 'critical' },
      { status: 'inactive', band: null },
      { status: 'archived', band: 'healthy' },
    ];

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Snapshot Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      for (const m of seed) {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(),
          companyName: 'Snapshot Co',
          country: 'TH',
          planId,
          planYear: 2026,
          status: m.status,
          // CHECK members_archived_at_iff_archived: archived_at IFF status=archived.
          archivedAt: m.status === 'archived' ? new Date() : null,
          riskScore: m.band === null ? null : m.band === 'critical' ? 90 : 60,
          riskScoreBand: m.band,
        });
      }
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(dashboardMetricsCache).where(eq(dashboardMetricsCache.tenantId, slug)).catch(() => {});
    await db.delete(smartInsightDismissals).where(eq(smartInsightDismissals.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('computes correct counts + at-risk insight and caches the snapshot', async () => {
    const result = await computeDashboardSnapshot(
      tenant.ctx,
      makeComputeDashboardSnapshotDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(dashboardMetricsCache)
      .where(eq(dashboardMetricsCache.tenantId, tenant.ctx.slug));
    expect(rows).toHaveLength(1);
    const snap = rows[0]!.metrics as {
      counts: { total: number; active: number; atRisk: number; overdue: number };
      needsAttention: { atRiskMembers: number; overdueInvoices: number; broadcastsAwaitingApproval: number };
      ytdPaidRevenueSatang: string;
      underDeliveredBenefitCount: number;
      topInsights: Array<{ key: string; count: number }>;
    };

    expect(snap.counts.total).toBe(8);
    expect(snap.counts.active).toBe(6);
    expect(snap.counts.atRisk).toBe(3); // warning + at-risk + critical
    expect(snap.counts.overdue).toBe(0);
    expect(snap.needsAttention.atRiskMembers).toBe(3);
    expect(snap.ytdPaidRevenueSatang).toBe('0');
    expect(snap.underDeliveredBenefitCount).toBe(0);
    expect(snap.topInsights).toEqual([{ key: 'at_risk_followup', count: 3 }]);
    expect(rows[0]!.stale).toBe(false);
  });

  it('suppresses the at_risk_followup insight after it is dismissed for the cycle', async () => {
    const dismiss = await dismissInsight(
      { insightKey: 'at_risk_followup' },
      { actorUserId: admin.userId, actorRole: 'admin', requestId: `snap-dismiss-${randomUUID()}` },
      tenant.ctx,
      makeDismissInsightDeps(tenant.ctx.slug),
    );
    expect(dismiss.ok).toBe(true);

    const result = await computeDashboardSnapshot(
      tenant.ctx,
      makeComputeDashboardSnapshotDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Counts unchanged; the dismissed insight is suppressed for the cycle.
      expect(result.value.counts.atRisk).toBe(3);
      expect(result.value.topInsights).toEqual([]);
    }
  });
});
