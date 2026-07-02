/**
 * 088 US8 UX-B2 (T061f) — Drizzle impl of {@link ZeroRateCertPruneRepo}.
 *
 * Built per-tenant with the `tx` handed by `runInTenant` (the composition root
 * wraps `makeDrizzleZeroRateCertPruneRepo(tx)` inside
 * `runInTenant(asTenantContext(tenantId), …)`), so the pin probe runs under the
 * `chamber_app` role with `app.current_tenant` set — RLS scopes the read to the
 * tenant even though the explicit `tenant_id` filter is also present
 * (defence-in-depth, mirrors the F6 sweep repo). READ-only: no immutability
 * trigger interaction.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import type { ZeroRateCertPruneRepo } from '../../application/ports/zero-rate-cert-prune-repo';

export function makeDrizzleZeroRateCertPruneRepo(
  tx: TenantTx,
): ZeroRateCertPruneRepo {
  return {
    async existsInvoiceWithCertBlobKey(
      tenantId: string,
      blobKey: string,
    ): Promise<boolean> {
      const rows = (await tx.execute(sql`
        SELECT 1
        FROM invoices
        WHERE tenant_id = ${tenantId}
          AND zero_rate_cert_blob_key = ${blobKey}
        LIMIT 1
      `)) as unknown as ReadonlyArray<unknown>;
      return rows.length > 0;
    },
  };
}
