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
 *
 * Validators are tightened (non-negative ints for counts, digits-only satang
 * string) so a partial/corrupt write is actually caught, not waved through.
 * NOTE: the shape is HAND-MIRRORED to `DashboardSnapshot` — a new field added
 * to the VO won't fail-compile here; keep them in sync when the VO changes.
 */
const count = z.number().int().nonnegative();
const snapshotSchema = z.object({
  counts: z.object({
    total: count,
    active: count,
    atRisk: count,
    overdue: count,
  }),
  ytdPaidRevenueSatang: z.string().regex(/^\d+$/),
  underDeliveredBenefitCount: count,
  needsAttention: z.object({
    broadcastsAwaitingApproval: count,
    overdueInvoices: count,
    atRiskMembers: count,
  }),
  revenueTrend: z.array(
    z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), satang: z.string().regex(/^\d+$/) }),
  ),
  memberGrowth: z.array(
    z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), cumulative: count }),
  ),
  topInsights: z.array(
    z.object({
      key: z.enum(INSIGHT_KEYS),
      count,
      scopeRef: z.string().optional(),
    }),
  ),
  // 067 T6 — REQUIRED (not `.optional()`/`.default(...)`): a legacy pre-067
  // row lacks these two keys, so it MUST fail `safeParse` → `read()` returns
  // null → the caller's existing cold-start path recomputes a fresh, valid
  // snapshot. See tests/integration/insights/snapshot-repo-legacy-row.test.ts.
  tierDistribution: z.array(
    z.object({
      tierKey: z.string(),
      // 067 follow-up — label is now a `LocaleText` (all stored plan-name
      // locales, `en` required). A pre-follow-up row has `label: <string>`,
      // which fails this object shape → `safeParse` miss → recompute.
      label: z.object({
        en: z.string(),
        th: z.string().optional(),
        sv: z.string().optional(),
      }),
      count,
    }),
  ),
  invoiceStatus: z.object({
    buckets: z.array(
      z.object({
        bucket: z.enum(['paid', 'unpaid', 'overdue']),
        satang: z.string().regex(/^\d+$/),
        count,
      }),
    ),
    draftCount: count,
  }),
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
