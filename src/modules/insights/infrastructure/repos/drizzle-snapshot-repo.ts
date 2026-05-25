/**
 * F9 `SnapshotRepo` Drizzle adapter (US1 / T030).
 *
 * Reads + upserts the single per-tenant `dashboard_metrics_cache` row. Binds
 * the tenant at construction; threads the caller's `tx` from `runInTenant`
 * (never the global `db` — CLAUDE.md RLS gotcha). Upsert is keyed on the
 * `tenant_id` PK and clears `stale` + the `refresh_started_at` claim marker.
 */
import { eq } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { dashboardMetricsCache } from '../db/schema-insights';
import type { DashboardSnapshot } from '../../domain/dashboard-snapshot';
import type {
  CachedSnapshot,
  SnapshotRepo,
} from '../../application/ports/snapshot-repo';

export function makeDrizzleSnapshotRepo(tenantId: string): SnapshotRepo {
  return {
    async read(ctx: TenantContext): Promise<CachedSnapshot | null> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({
            metrics: dashboardMetricsCache.metrics,
            computedAt: dashboardMetricsCache.computedAt,
            stale: dashboardMetricsCache.stale,
          })
          .from(dashboardMetricsCache)
          .where(eq(dashboardMetricsCache.tenantId, tenantId))
          .limit(1);
        const row = rows[0];
        if (!row) return null;
        return {
          metrics: row.metrics as DashboardSnapshot,
          computedAt: row.computedAt,
          stale: row.stale,
        };
      });
    },

    async upsertInTx(
      tx: TenantTx,
      metrics: DashboardSnapshot,
      computedAt: Date,
    ): Promise<void> {
      await tx
        .insert(dashboardMetricsCache)
        .values({ tenantId, metrics, computedAt, stale: false, refreshStartedAt: null })
        .onConflictDoUpdate({
          target: dashboardMetricsCache.tenantId,
          set: { metrics, computedAt, stale: false, refreshStartedAt: null },
        });
    },
  };
}
