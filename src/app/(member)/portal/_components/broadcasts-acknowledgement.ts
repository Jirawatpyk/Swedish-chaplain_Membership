/**
 * The company's E-Blast sending-terms acknowledgement (Q15,
 * `members.broadcasts_acknowledged_at`), read once for the two surfaces that
 * show the rules: the portal banner and the compose page (spec 122 PR C).
 *
 * Direct SQL: the F3 Member entity does not project this column (migration
 * 0071). Routed through `runInTenant` so RLS+FORCE on `members` applies, with
 * the explicit `tenant_id` predicate as the first wall (D-029, Principle I).
 */
import { cache } from 'react';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';

/**
 * React `cache()`: the layout's banner and the compose page both ask on one
 * request, and share one read. Keyed by the tenant slug, not the context
 * object, which each caller resolves afresh.
 */
const readCached = cache(async (tenantSlug: string, memberId: string): Promise<Date | null> => {
  const tenant = asTenantContext(tenantSlug);
  const rows = (await runInTenant(tenant, async (tx) =>
    tx.execute(sql`
      SELECT broadcasts_acknowledged_at
        FROM members
       WHERE tenant_id = ${tenant.slug}
         AND member_id = ${memberId}
       LIMIT 1
    `),
  )) as unknown as Array<{ broadcasts_acknowledged_at: Date | string | null }>;
  // A raw read gets timestamptz as a string: Drizzle's postgres-js driver
  // turns that parser off (R95: the compose page crashed on `.toISOString()`).
  const value = rows[0]?.broadcasts_acknowledged_at ?? null;
  return value === null ? null : new Date(value);
});

export async function readBroadcastsAcknowledgedAt(
  tenant: TenantContext,
  memberId: string,
): Promise<Date | null> {
  return readCached(tenant.slug, memberId);
}
