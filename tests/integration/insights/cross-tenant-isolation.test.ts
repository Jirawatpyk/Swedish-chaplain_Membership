/**
 * T019 (F9 / Principle I Review-Gate BLOCKER) — cross-tenant isolation harness
 * for the F9 `insights` tables.
 *
 * Validates DB-layer RLS+FORCE (migrations 0185/0186/0188) prevents tenant B
 * from reading, updating, deleting, or spoof-inserting tenant A's rows when
 * running under `runInTenant(tenantB.ctx)`. Mirrors the F7.1a
 * template-cross-tenant-probe pattern (the Principle I §3 standard).
 *
 * SCOPE (Foundational): the 3 FK-free F9 tables —
 *   - dashboard_metrics_cache
 *   - smart_insight_dismissals
 *   - export_jobs
 * `directory_listings` (composite FK → members → membership_plans chain) is
 * exercised in US5 (Slice B); `member_timeline_v` (security_invoker view) in
 * US3; the audit-query reader in US2. The aggregate "all surfaces GREEN"
 * closure is T102. This file proves the DB-layer guarantee on F9's own tables
 * holds even if Application-layer `runInTenant` were bypassed.
 *
 * Runs against live Neon Singapore per CLAUDE.md `pnpm test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  dashboardMetricsCache,
  smartInsightDismissals,
  exportJobs,
} from '@/modules/insights/infrastructure/db/schema-insights';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('F9 insights cross-tenant isolation — REVIEW-GATE BLOCKER (T019)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let dismissalAId: string;
  let exportJobAId: string;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed one row per tenant in each table via schema-owner `db` (BYPASSES
    // RLS — required for cross-tenant test setup).
    for (const t of [tenantA, tenantB]) {
      await db.insert(dashboardMetricsCache).values({
        tenantId: t.ctx.slug,
        metrics: { seeded: true, tenant: t.ctx.slug },
        computedAt: new Date(),
        stale: false,
      });
    }

    const [dis] = await db
      .insert(smartInsightDismissals)
      .values({
        tenantId: tenantA.ctx.slug,
        insightKey: 'unused_eblast_quota',
        scopeRef: '',
        dismissedBy: randomUUID(),
        cycleKey: '2026',
      })
      .returning({ id: smartInsightDismissals.id });
    dismissalAId = dis!.id;
    await db.insert(smartInsightDismissals).values({
      tenantId: tenantB.ctx.slug,
      insightKey: 'at_risk_followup',
      scopeRef: '',
      dismissedBy: randomUUID(),
      cycleKey: '2026-W01',
    });

    const [job] = await db
      .insert(exportJobs)
      .values({
        tenantId: tenantA.ctx.slug,
        kind: 'gdpr_member_archive',
        requestedBy: randomUUID(),
        status: 'requested',
        idempotencyKey: `idem-A-${randomUUID()}`,
      })
      .returning({ id: exportJobs.id });
    exportJobAId = job!.id;
    await db.insert(exportJobs).values({
      tenantId: tenantB.ctx.slug,
      kind: 'directory_json',
      requestedBy: randomUUID(),
      status: 'requested',
      idempotencyKey: `idem-B-${randomUUID()}`,
    });
  }, 120_000);

  afterAll(async () => {
    const slugs = [tenantA.ctx.slug, tenantB.ctx.slug];
    await db.delete(exportJobs).where(inArray(exportJobs.tenantId, slugs));
    await db
      .delete(smartInsightDismissals)
      .where(inArray(smartInsightDismissals.tenantId, slugs));
    await db
      .delete(dashboardMetricsCache)
      .where(inArray(dashboardMetricsCache.tenantId, slugs));
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  // --- dashboard_metrics_cache ----------------------------------------------

  describe('dashboard_metrics_cache', () => {
    it('READ: tenant B cannot SELECT tenant A row', async () => {
      const rows = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select()
          .from(dashboardMetricsCache)
          .where(eq(dashboardMetricsCache.tenantId, tenantA.ctx.slug)),
      );
      expect(rows).toEqual([]);
    });

    it('UPDATE: tenant B UPDATE on tenant A row affects ZERO rows', async () => {
      const updated = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .update(dashboardMetricsCache)
          .set({ stale: true })
          .where(eq(dashboardMetricsCache.tenantId, tenantA.ctx.slug))
          .returning({ tenantId: dashboardMetricsCache.tenantId }),
      );
      expect(updated).toEqual([]);
      const surviving = await db
        .select({ stale: dashboardMetricsCache.stale })
        .from(dashboardMetricsCache)
        .where(eq(dashboardMetricsCache.tenantId, tenantA.ctx.slug));
      expect(surviving[0]?.stale).toBe(false);
    });

    it('INSERT: tenant B INSERT with tenantId=tenantA is rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantB.ctx, async (tx) =>
          tx.insert(dashboardMetricsCache).values({
            tenantId: tenantA.ctx.slug, // spoof
            metrics: { injected: true },
            computedAt: new Date(),
            stale: false,
          }),
        ),
      ).rejects.toThrow();
    });

    it('own row IS visible under each tenant context', async () => {
      const aRows = await runInTenant(tenantA.ctx, async (tx) =>
        tx
          .select({ tenantId: dashboardMetricsCache.tenantId })
          .from(dashboardMetricsCache),
      );
      expect(aRows).toEqual([{ tenantId: tenantA.ctx.slug }]);
      const bRows = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select({ tenantId: dashboardMetricsCache.tenantId })
          .from(dashboardMetricsCache),
      );
      expect(bRows).toEqual([{ tenantId: tenantB.ctx.slug }]);
    });
  });

  // --- smart_insight_dismissals ---------------------------------------------

  describe('smart_insight_dismissals', () => {
    it('READ: tenant B cannot SELECT tenant A dismissal', async () => {
      const rows = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select()
          .from(smartInsightDismissals)
          .where(eq(smartInsightDismissals.id, dismissalAId)),
      );
      expect(rows).toEqual([]);
    });

    it('DELETE: tenant B DELETE on tenant A dismissal affects ZERO rows', async () => {
      const deleted = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .delete(smartInsightDismissals)
          .where(eq(smartInsightDismissals.id, dismissalAId))
          .returning({ id: smartInsightDismissals.id }),
      );
      expect(deleted).toEqual([]);
      const surviving = await db
        .select({ id: smartInsightDismissals.id })
        .from(smartInsightDismissals)
        .where(eq(smartInsightDismissals.id, dismissalAId));
      expect(surviving).toHaveLength(1);
    });

    it('INSERT: tenant B INSERT with tenantId=tenantA is rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantB.ctx, async (tx) =>
          tx.insert(smartInsightDismissals).values({
            tenantId: tenantA.ctx.slug, // spoof
            insightKey: 'unused_eblast_quota',
            scopeRef: '',
            dismissedBy: randomUUID(),
            cycleKey: '2026',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // --- export_jobs ----------------------------------------------------------

  describe('export_jobs', () => {
    it('READ: tenant B cannot SELECT tenant A export job', async () => {
      const rows = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select()
          .from(exportJobs)
          .where(eq(exportJobs.id, exportJobAId)),
      );
      expect(rows).toEqual([]);
    });

    it('UPDATE: tenant B cannot advance tenant A job status', async () => {
      const updated = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .update(exportJobs)
          .set({ status: 'ready' })
          .where(eq(exportJobs.id, exportJobAId))
          .returning({ id: exportJobs.id }),
      );
      expect(updated).toEqual([]);
      const surviving = await db
        .select({ status: exportJobs.status })
        .from(exportJobs)
        .where(eq(exportJobs.id, exportJobAId));
      expect(surviving[0]?.status).toBe('requested');
    });

    it('INSERT: tenant B INSERT with tenantId=tenantA is rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantB.ctx, async (tx) =>
          tx.insert(exportJobs).values({
            tenantId: tenantA.ctx.slug, // spoof
            kind: 'gdpr_member_archive',
            requestedBy: randomUUID(),
            status: 'requested',
            idempotencyKey: `idem-spoof-${randomUUID()}`,
          }),
        ),
      ).rejects.toThrow();
    });
  });
});
