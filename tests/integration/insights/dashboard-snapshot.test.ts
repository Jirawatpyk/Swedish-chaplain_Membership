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
  listDashboard,
  makeComputeDashboardSnapshotDeps,
  makeDismissInsightDeps,
  makeListDashboardDeps,
} from '@/modules/insights';
import { dashboardMetricsCache, smartInsightDismissals } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { lastNMonthKeys } from '@/modules/insights/domain/trend-window';
import { env } from '@/lib/env';

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
      revenueTrend: Array<{ month: string; satang: string }>;
      memberGrowth: Array<{ month: string; cumulative: number }>;
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
    // FR-001a trend arrays — 12 month buckets; all 8 members joined "now"
    // (within the window) so the cumulative series ends at 8; no paid invoices
    // → revenue trend sums to 0.
    expect(snap.revenueTrend).toHaveLength(12);
    expect(snap.memberGrowth).toHaveLength(12);
    expect(snap.memberGrowth.at(-1)?.cumulative).toBe(8);
    expect(snap.revenueTrend.reduce((s, p) => s + BigInt(p.satang), 0n)).toBe(0n);
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

/**
 * I-5 (review remediation) — proves AS-1 (YTD paid revenue) + AS-2 (overdue
 * count) with NON-ZERO seeded invoices, not just the zero-stub assertions
 * above. Separate tenant so the revenue/overdue figures are deterministic.
 */
describe('F9 computeDashboardSnapshot — revenue + overdue (I-5)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-rev-${randomUUID().slice(0, 8)}`;
  const memberId = randomUUID();

  const SNAP_TENANT = {
    legal_name_th: 'ทดสอบ',
    legal_name_en: 'Test',
    tax_id: '0000000000000',
    address_th: 'Bangkok',
    address_en: 'Bangkok',
    logo_blob_key: null,
  };
  const SNAP_MEMBER = {
    legal_name: 'Rev Co',
    tax_id: '1234567890123',
    address: 'Bangkok',
    primary_contact_name: 'n',
    primary_contact_email: 'test@example.com',
  };

  function invoiceRow(over: {
    seq: number;
    status: 'issued' | 'paid';
    dueDate: string;
    totalSatang: bigint;
  }) {
    const base = {
      tenantId: tenant.ctx.slug,
      invoiceId: randomUUID(),
      memberId,
      planYear: 2026,
      planId,
      draftByUserId: admin.userId,
      status: over.status,
      fiscalYear: 2026,
      sequenceNumber: over.seq,
      documentNumber: `F9R-2026-${String(over.seq).padStart(6, '0')}`,
      issueDate: '2026-01-15',
      dueDate: over.dueDate,
      subtotalSatang: over.totalSatang,
      vatRateSnapshot: '0.0000',
      vatSatang: 0n,
      totalSatang: over.totalSatang,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly' as const,
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: `invoicing/f9rev/2026/${over.seq}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
    };
    if (over.status === 'paid') {
      // CHECK invoices_paid_has_payment + invoices_paid_has_receipt_status.
      return {
        ...base,
        paidAt: new Date('2026-03-01T00:00:00.000Z'),
        paymentMethod: 'manual',
        receiptPdfStatus: 'rendered' as const,
      };
    }
    return base;
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Revenue Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'Rev Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
        riskScore: null,
        riskScoreBand: null,
      });
      await tx.insert(invoices).values([
        // 2 paid 2026 invoices → YTD revenue = 100_000 + 50_000 = 150_000 satang.
        invoiceRow({ seq: 1, status: 'paid', dueDate: '2026-02-14', totalSatang: 100_000n }),
        invoiceRow({ seq: 2, status: 'paid', dueDate: '2026-02-14', totalSatang: 50_000n }),
        // 1 issued + past due → overdue. 1 issued + future due → not overdue.
        invoiceRow({ seq: 3, status: 'issued', dueDate: '2026-02-14', totalSatang: 70_000n }),
        invoiceRow({ seq: 4, status: 'issued', dueDate: '2099-12-31', totalSatang: 70_000n }),
      ]);
      // 1 submitted broadcast → broadcastsAwaitingApproval = 1 (AS-2).
      await tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId: randomUUID(),
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: admin.userId,
        actorRole: 'member_self_service',
        subject: 'F9 awaiting-approval seed',
        bodyHtml: '<p>body</p>',
        bodySource: 'body',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 100,
        status: 'submitted',
        submittedAt: new Date(),
      });
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(dashboardMetricsCache).where(eq(dashboardMetricsCache.tenantId, slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, slug)).catch(() => {});
    await db.delete(broadcasts).where(eq(broadcasts.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('reports non-zero YTD revenue (AS-1), overdue + broadcasts-awaiting counts (AS-2)', async () => {
    const result = await computeDashboardSnapshot(
      tenant.ctx,
      makeComputeDashboardSnapshotDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ytdPaidRevenueSatang).toBe('150000');
      expect(result.value.counts.overdue).toBe(1);
      expect(result.value.needsAttention.overdueInvoices).toBe(1);
      expect(result.value.needsAttention.broadcastsAwaitingApproval).toBe(1);
      // FR-001a trends: 12 buckets; the 2 paid invoices (150_000 satang) land in
      // a single month → trend sums to 150_000; 1 member → growth ends at 1.
      expect(result.value.revenueTrend).toHaveLength(12);
      expect(
        result.value.revenueTrend.reduce((s, p) => s + BigInt(p.satang), 0n),
      ).toBe(150_000n);
      expect(result.value.memberGrowth).toHaveLength(12);
      expect(result.value.memberGrowth.at(-1)?.cumulative).toBe(1);
    }
  });

  it('FR-007 (staff-review R011): a MANAGER reading the dashboard sees YTD revenue (live Neon)', async () => {
    // The prior test computed + cached the snapshot. A manager read must return
    // the revenue figure (manager is "read-only on finance", not finance-blind).
    const result = await listDashboard(
      { actorUserId: admin.userId, actorRole: 'manager', requestId: 'mgr-dash-1' },
      tenant.ctx,
      makeListDashboardDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.metrics.ytdPaidRevenueSatang).toBe('150000');
    }
  });
});

/**
 * G2/G3 (review remediation) — multi-month trend distribution: makes the
 * single-bucket I-5 assertions load-bearing by spreading data across distinct
 * months + before the 12-month window (member baseline + revenue out-of-window
 * discard). Dates are computed relative to the tenant-tz window so the test is
 * robust to when it runs.
 */
describe('F9 computeDashboardSnapshot — 12-month trend distribution (G2/G3)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-trend-${randomUUID().slice(0, 8)}`;
  const ownerMemberId = randomUUID(); // FK target for the seeded invoices
  const TZ = env.tenant.timezone;
  const keys = lastNMonthKeys(new Date(), TZ, 12);
  // Mid-month, mid-day UTC → same tenant-tz month regardless of offset.
  const midMonth = (key: string): Date => new Date(`${key}-15T03:00:00.000Z`);
  const BEFORE_WINDOW = new Date('2019-01-15T03:00:00.000Z');

  const SNAP_TENANT = { legal_name_th: 'ท', legal_name_en: 'T', tax_id: '0', address_th: 'B', address_en: 'B', logo_blob_key: null };
  const SNAP_MEMBER = { legal_name: 'C', tax_id: '1', address: 'B', primary_contact_name: 'n', primary_contact_email: 't@e.com' };

  function paidInvoice(seq: number, paidAt: Date, totalSatang: bigint) {
    return {
      tenantId: tenant.ctx.slug,
      invoiceId: randomUUID(),
      memberId: ownerMemberId,
      planYear: 2026,
      planId,
      draftByUserId: admin.userId,
      status: 'paid' as const,
      fiscalYear: paidAt.getUTCFullYear(),
      sequenceNumber: seq,
      documentNumber: `F9T-${paidAt.getUTCFullYear()}-${String(seq).padStart(6, '0')}`,
      issueDate: paidAt.toISOString().slice(0, 10),
      dueDate: paidAt.toISOString().slice(0, 10),
      subtotalSatang: totalSatang,
      vatRateSnapshot: '0.0000',
      vatSatang: 0n,
      totalSatang,
      creditedTotalSatang: 0n,
      proRatePolicySnapshot: 'monthly' as const,
      netDaysSnapshot: 30,
      tenantIdentitySnapshot: SNAP_TENANT,
      memberIdentitySnapshot: SNAP_MEMBER,
      pdfBlobKey: `invoicing/f9trend/${seq}.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfTemplateVersion: 1,
      paidAt,
      paymentMethod: 'manual',
      receiptPdfStatus: 'rendered' as const,
    };
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Trend Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      // Members: 1 before the window (baseline) + 1 each in keys[3], keys[7], keys[11].
      const memberRows = [
        { memberId: ownerMemberId, createdAt: BEFORE_WINDOW },
        { memberId: randomUUID(), createdAt: midMonth(keys[3]!) },
        { memberId: randomUUID(), createdAt: midMonth(keys[7]!) },
        { memberId: randomUUID(), createdAt: midMonth(keys[11]!) },
      ].map((m) => ({
        tenantId: tenant.ctx.slug,
        memberId: m.memberId,
        companyName: 'Trend Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active' as const,
        riskScore: null,
        riskScoreBand: null,
        createdAt: m.createdAt,
      }));
      await tx.insert(members).values(memberRows);
      // Paid invoices: 2 in distinct in-window months + 1 before the window
      // (must be EXCLUDED from the trend).
      await tx.insert(invoices).values([
        paidInvoice(1, midMonth(keys[2]!), 100_000n),
        paidInvoice(2, midMonth(keys[8]!), 60_000n),
        paidInvoice(3, BEFORE_WINDOW, 999_999n),
      ]);
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(dashboardMetricsCache).where(eq(dashboardMetricsCache.tenantId, slug)).catch(() => {});
    await db.delete(invoices).where(eq(invoices.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('distributes revenue across months + discards out-of-window paid invoices', async () => {
    const result = await computeDashboardSnapshot(tenant.ctx, makeComputeDashboardSnapshotDeps(tenant.ctx.slug));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byMonth = new Map(result.value.revenueTrend.map((p) => [p.month, BigInt(p.satang)]));
    expect(byMonth.get(keys[2]!)).toBe(100_000n);
    expect(byMonth.get(keys[8]!)).toBe(60_000n);
    // The 2019 paid invoice (999_999) is outside the window → excluded entirely.
    expect(result.value.revenueTrend.reduce((s, p) => s + BigInt(p.satang), 0n)).toBe(160_000n);
  });

  it('accumulates member growth across months on top of the pre-window baseline', async () => {
    const result = await computeDashboardSnapshot(tenant.ctx, makeComputeDashboardSnapshotDeps(tenant.ctx.slug));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cum = new Map(result.value.memberGrowth.map((p) => [p.month, p.cumulative]));
    // baseline (1 pre-window) → rises by 1 at keys[3], keys[7], keys[11].
    expect(cum.get(keys[0]!)).toBe(1); // just the baseline
    expect(cum.get(keys[3]!)).toBe(2);
    expect(cum.get(keys[7]!)).toBe(3);
    expect(cum.get(keys[11]!)).toBe(4);
    expect(result.value.counts.total).toBe(4);
  });
});
