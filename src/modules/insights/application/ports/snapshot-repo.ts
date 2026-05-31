/**
 * F9 `SnapshotRepo` Application port (US1 / T030 / data-model § 1).
 *
 * Reads + upserts the single per-tenant `dashboard_metrics_cache` row. Bound to
 * a tenant at construction; threads `tx` from `runInTenant`.
 *
 * The `metrics` JSONB is the derived `DashboardSnapshot` projection — never
 * authoritative, safe to rebuild. `upsertInTx` clears `stale` + the
 * `refresh_started_at` claim marker on success.
 */
import type { TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import type { DashboardSnapshot } from '../../domain/dashboard-snapshot';

export interface CachedSnapshot {
  readonly metrics: DashboardSnapshot;
  readonly computedAt: Date;
  readonly stale: boolean;
}

export interface SnapshotRepo {
  /**
   * Reads the cached snapshot row for the tenant, or null on cold-start.
   * Self-scoping (opens its own `runInTenant`) so the `listDashboard` read path
   * stays free of a direct DB-tx call and is unit-testable with a mock.
   */
  read(ctx: TenantContext): Promise<CachedSnapshot | null>;
  /** Upserts the snapshot (clears `stale` + `refresh_started_at`). */
  upsertInTx(tx: TenantTx, metrics: DashboardSnapshot, computedAt: Date): Promise<void>;
}
