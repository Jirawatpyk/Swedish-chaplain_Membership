/**
 * F9 `InsightDismissalRepo` Drizzle adapter (US1 / T028 + T030).
 *
 * Binds the tenant at construction (`makeDrizzleInsightDismissalRepo(tenantId)`)
 * and threads the caller's `tx` from `runInTenant` — NEVER the global `db`
 * (CLAUDE.md RLS gotcha). The INSERT sets `tenant_id` to the bound tenant so
 * the RLS WITH CHECK (tenant_id = current_setting('app.current_tenant'))
 * passes for the matching `runInTenant(ctx)` the caller opened.
 *
 * Idempotent via ON CONFLICT DO NOTHING on the unique key
 * (tenant_id, insight_key, scope_ref, cycle_key); `.returning()` is empty on a
 * conflict, which the use-case reads to annotate the audit summary.
 */
import { and, eq } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { smartInsightDismissals } from '../db/schema-insights';
import type {
  DismissInsightRecord,
  InsightDismissalRepo,
} from '../../application/ports/insight-dismissal-repo';

export function makeDrizzleInsightDismissalRepo(tenantId: string): InsightDismissalRepo {
  return {
    async dismissInTx(tx: TenantTx, record: DismissInsightRecord): Promise<boolean> {
      const inserted = await tx
        .insert(smartInsightDismissals)
        .values({
          tenantId,
          insightKey: record.insightKey,
          scopeRef: record.scopeRef,
          cycleKey: record.cycleKey,
          dismissedBy: record.dismissedBy,
        })
        .onConflictDoNothing({
          target: [
            smartInsightDismissals.tenantId,
            smartInsightDismissals.insightKey,
            smartInsightDismissals.scopeRef,
            smartInsightDismissals.cycleKey,
          ],
        })
        .returning({ id: smartInsightDismissals.id });
      return inserted.length > 0;
    },

    async isDismissedInTx(
      tx: TenantTx,
      insightKey: string,
      scopeRef: string,
      cycleKey: string,
    ): Promise<boolean> {
      const rows = await tx
        .select({ id: smartInsightDismissals.id })
        .from(smartInsightDismissals)
        .where(
          and(
            eq(smartInsightDismissals.tenantId, tenantId),
            eq(smartInsightDismissals.insightKey, insightKey),
            eq(smartInsightDismissals.scopeRef, scopeRef),
            eq(smartInsightDismissals.cycleKey, cycleKey),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },
  };
}
