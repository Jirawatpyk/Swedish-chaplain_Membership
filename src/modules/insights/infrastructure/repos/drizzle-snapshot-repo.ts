/**
 * F9 `SnapshotRepo` Drizzle adapter (US1 / T030).
 *
 * Reads + upserts the single per-tenant `dashboard_metrics_cache` row. Binds
 * the tenant at construction; threads the caller's `tx` from `runInTenant`
 * (never the global `db` — CLAUDE.md RLS gotcha). Upsert is keyed on the
 * `tenant_id` PK and clears `stale` + the `refresh_started_at` claim marker.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import { dashboardMetricsCache } from '../db/schema-insights';
import type { DashboardSnapshot } from '../../domain/dashboard-snapshot';
import { INSIGHT_KEYS } from '../../domain/smart-insight';
import type {
  CachedSnapshot,
  SnapshotRepo,
} from '../../application/ports/snapshot-repo';

/**
 * Runtime guard for the JSONB `metrics` column. The snapshot is a derived,
 * rebuildable projection, so a row that fails validation (schema drift, manual
 * edit, partial write) is treated as a cache miss → the caller cold-start
 * recomputes rather than trusting a malformed `DashboardSnapshot` the compiler
 * can't see into (the JSONB read is `unknown`).
 */
const snapshotSchema = z.object({
  counts: z.object({
    total: z.number(),
    active: z.number(),
    atRisk: z.number(),
    overdue: z.number(),
  }),
  ytdPaidRevenueSatang: z.string(),
  underDeliveredBenefitCount: z.number(),
  needsAttention: z.object({
    broadcastsAwaitingApproval: z.number(),
    overdueInvoices: z.number(),
    atRiskMembers: z.number(),
  }),
  topInsights: z.array(
    z.object({
      key: z.enum(INSIGHT_KEYS),
      count: z.number(),
      scopeRef: z.string().optional(),
    }),
  ),
  computedAt: z.string(),
});

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
        const parsed = snapshotSchema.safeParse(row.metrics);
        if (!parsed.success) {
          // Malformed cache row — log + treat as a miss so the caller recomputes.
          logger.warn(
            { tenantId, issueCount: parsed.error.issues.length },
            'insights.snapshot_repo.malformed_cache_row',
          );
          return null;
        }
        return {
          metrics: parsed.data as DashboardSnapshot,
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
