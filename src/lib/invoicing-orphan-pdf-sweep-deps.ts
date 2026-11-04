/**
 * #729 — composition wrapper for the daily orphan PDF sweep, the sibling of
 * `invoicing-cert-prune-deps.ts`. It lives in `src/lib/**` because the
 * cross-tenant tenant list needs `@/lib/db`, which the Application layer may
 * not import (Principle III); the cron route imports only this wrapper.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  makeDrizzleCreditNoteRepo,
  makeDrizzleInvoiceRepo,
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
        SELECT tenant_id FROM tenant_invoice_settings
      `)) as unknown as Array<{ tenant_id: string }>;
      return rows.map((r) => r.tenant_id);
    },
    // Both repos open their own runInTenant transaction per call, so every
    // lookup runs under RLS for the key's tenant (plus the explicit predicate).
    reposFor: (tenantId) => ({
      invoiceRepo: makeDrizzleInvoiceRepo(tenantId),
      creditNoteRepo: makeDrizzleCreditNoteRepo(tenantId),
    }),
    logger,
  });
}
