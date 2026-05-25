/**
 * F9 `InsightDismissalRepo` Application port (US1 / T028).
 *
 * Persists smart-insight dismissals. Idempotent on the unique key
 * (tenant_id, insight_key, scope_ref, cycle_key) so a double-dismiss is a
 * no-op (Principle VIII). The Infrastructure adapter binds the tenant at
 * construction (`makeDrizzleInsightDismissalRepo(tenantId)`) and threads the
 * caller's `tx` from `runInTenant`.
 *
 * `tx` is typed `TenantTx` (from the shared `@/lib/db` composition layer) —
 * the established convention for repo ports (see members/broadcasts ports).
 */
import type { TenantTx } from '@/lib/db';

export interface DismissInsightRecord {
  readonly insightKey: string;
  readonly scopeRef: string;
  readonly cycleKey: string;
  readonly dismissedBy: string;
}

export interface InsightDismissalRepo {
  /**
   * Idempotent upsert (ON CONFLICT DO NOTHING on the unique key). Returns
   * `true` when a new row was inserted, `false` on an idempotent replay — the
   * caller uses this only to annotate the audit summary.
   */
  dismissInTx(tx: TenantTx, record: DismissInsightRecord): Promise<boolean>;
  /**
   * True if a dismissal exists for (insight_key, scope_ref, cycle_key) in the
   * current tenant — the snapshot job uses this to suppress dismissed insights
   * for the current cycle (FR-004).
   */
  isDismissedInTx(
    tx: TenantTx,
    insightKey: string,
    scopeRef: string,
    cycleKey: string,
  ): Promise<boolean>;
}
