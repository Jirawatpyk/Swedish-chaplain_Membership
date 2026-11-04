/**
 * #729 — composition wrapper for the orphan PDF sweep (run by the daily
 * `sweep-orphan-blobs` cron after the cert prune), the sibling of
 * `invoicing-cert-prune-deps.ts`. It lives in `src/lib/**` because the
 * cross-tenant tenant list needs `@/lib/db`, which the Application layer may
 * not import (Principle III); the cron route imports only this wrapper.
 */
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import {
  makeDrizzleInvoiceRepo,
  makeDrizzleOrphanPdfReferenceRepo,
  sweepOrphanPdfs,
  vercelBlobAdapter,
  type SweepOrphanPdfsInput,
  type SweepOrphanPdfsOutput,
} from '@/modules/invoicing';
import { systemClock } from '@/modules/invoicing/application/ports/clock-port';

export type { SweepOrphanPdfsOutput } from '@/modules/invoicing';

export async function runSweepOrphanPdfs(input: SweepOrphanPdfsInput): Promise<SweepOrphanPdfsOutput> {
  return sweepOrphanPdfs(input, {
    blob: vercelBlobAdapter,
    clock: systemClock,
    // Every tenant with invoice settings can own invoicing PDFs. The owner-role
    // read bypasses RLS on purpose: a CRON_SECRET-gated maintenance path, as
    // the cert prune and the redact crons.
    listTenantIds: async () => {
      const rows = (await db.execute(sql`
        SELECT tenant_id FROM tenant_invoice_settings ORDER BY tenant_id
      `)) as unknown as Array<{ tenant_id: string }>;
      return rows.map((r) => r.tenant_id);
    },
    // The lock-free batch read and the invoice repo (which opens its own
    // runInTenant transaction per call) both run under RLS for the key's
    // tenant, plus the explicit tenant predicate.
    referencedKeys: (tenantId, ids) =>
      runInTenant(asTenantContext(tenantId), (tx) =>
        makeDrizzleOrphanPdfReferenceRepo(tx).referencedKeys(tenantId, ids),
      ),
    reposFor: (tenantId) => ({ invoiceRepo: makeDrizzleInvoiceRepo(tenantId) }),
    logger,
  });
}
