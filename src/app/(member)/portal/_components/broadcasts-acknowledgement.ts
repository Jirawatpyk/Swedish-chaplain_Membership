/**
 * The company's E-Blast sending-terms acknowledgement (Q15,
 * `members.broadcasts_acknowledged_at`), read once for the two surfaces that
 * show the rules: the portal banner and the compose page (spec 122 PR C).
 *
 * Direct SQL: the F3 Member entity does not project this column (migration
 * 0071). Routed through `runInTenant` so RLS+FORCE on `members` applies, with
 * the explicit `tenant_id` predicate as the first wall (D-029, Principle I).
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';

export async function readBroadcastsAcknowledgedAt(
  tenant: TenantContext,
  memberId: string,
): Promise<Date | null> {
  const rows = (await runInTenant(tenant, async (tx) =>
    tx.execute(sql`
      SELECT broadcasts_acknowledged_at
        FROM members
       WHERE tenant_id = ${tenant.slug}
         AND member_id = ${memberId}
       LIMIT 1
    `),
  )) as unknown as Array<{ broadcasts_acknowledged_at: Date | null }>;
  return rows[0]?.broadcasts_acknowledged_at ?? null;
}
