/**
 * Drizzle `BroadcastApprovalCounter` — counts `submitted` (awaiting-approval)
 * broadcasts for the tenant. Tenant-scoped via `runInTenant` + an explicit
 * `tenant_id` predicate (two-layer isolation, Principle I).
 */
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { broadcasts } from '../schema';
import type { BroadcastApprovalCounter } from '../../application/ports/broadcast-approval-counter';

export function makeDrizzleBroadcastApprovalCounter(
  tenantId: string,
): BroadcastApprovalCounter {
  return {
    async countAwaitingApproval(ctx: TenantContext): Promise<number> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ n: sql<number>`COUNT(*)::int` })
          .from(broadcasts)
          .where(
            and(
              eq(broadcasts.tenantId, tenantId),
              sql`${broadcasts.status}::text = 'submitted'`,
            ),
          );
        return rows[0]?.n ?? 0;
      });
    },
  };
}
