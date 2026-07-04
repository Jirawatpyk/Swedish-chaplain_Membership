/**
 * 088 US8 UX-B2 (T061f) — composition wrapper for the orphaned zero-rate
 * cert-scan TTL sweep. The `src/lib/**` analogue of the F6
 * `events-csv-import-deps.ts` `runSweepExpiredErrorCsvBlobs` wrapper.
 *
 * Why here (not `src/modules/invoicing/application/invoicing-deps.ts`): the
 * sweep's cross-tenant wiring needs `@/lib/db` (`db` for the tenant-list read +
 * `runInTenant` for the per-tenant RLS scope), which the Application layer
 * forbids (Constitution Principle III — no ORM/framework in application/**).
 * `src/lib/**` is the sanctioned composition adapter layer (ESLint barrel-guard
 * exempt) sitting on the Module side of the Presentation boundary — so the cron
 * route imports ONLY this wrapper and carries ZERO `@/modules/invoicing/*` deep
 * imports (the invoicing presentation-import architecture test forbids a route
 * from deep-importing `application/**`, even type-only).
 *
 * **Principle III note**: route handlers + tests import from this file;
 * Application use-cases never reach into `src/lib/**`.
 */
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import {
  pruneOrphanedZeroRateCerts,
  makeDrizzleZeroRateCertPruneRepo,
  vercelBlobAdapter,
  type PruneOrphanedZeroRateCertsInput,
  type PruneOrphanedZeroRateCertsOutput,
} from '@/modules/invoicing';
import { systemClock } from '@/modules/invoicing/application/ports/clock-port';

export type { PruneOrphanedZeroRateCertsOutput } from '@/modules/invoicing';

/**
 * Invoke the `pruneOrphanedZeroRateCerts` use-case with the production dep
 * graph: F4 Vercel Blob adapter (list + delete), system clock, the
 * cross-tenant tenant-list read (RLS-bypassing owner connection), and the
 * per-tenant RLS scope wiring the tenant-scoped pin-probe repo.
 */
export async function runPruneOrphanedZeroRateCerts(
  input: PruneOrphanedZeroRateCertsInput,
): Promise<PruneOrphanedZeroRateCertsOutput> {
  return pruneOrphanedZeroRateCerts(input, {
    blob: vercelBlobAdapter,
    clock: systemClock,
    // Every tenant with invoice settings can own cert blobs. The owner-role
    // read bypasses tenant RLS intentionally — a maintenance path gated by
    // CRON_SECRET, not a user request (mirrors the redact-expired-* crons).
    listCertTenantIds: async () => {
      const rows = (await db.execute(sql`
        SELECT tenant_id FROM tenant_invoice_settings
      `)) as unknown as Array<{ tenant_id: string }>;
      return rows.map((r) => r.tenant_id);
    },
    // Per-tenant scope so the pin probe runs under RLS for the key's tenant.
    withTenantScope: async (tenantId, fn) =>
      runInTenant(asTenantContext(tenantId), async (tx) =>
        fn(makeDrizzleZeroRateCertPruneRepo(tx)),
      ),
    logger,
  });
}
