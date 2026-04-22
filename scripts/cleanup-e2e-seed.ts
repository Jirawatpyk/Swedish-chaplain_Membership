/**
 * One-shot cleanup: wipe the E2E seeded invoices so the refreshed
 * seed-e2e-portal-invoices.ts can re-insert with real PDFs + line
 * items. Idempotent — safe to re-run.
 */
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

async function main(): Promise<void> {
  const ctx = asTenantContext(process.env.TENANT_SLUG ?? 'swecham');
  const rows = await runInTenant(ctx, async (tx) => {
    // invoice_lines will cascade-delete via FK; but it's safer to
    // explicitly nuke them first in case the FK is deferred.
    await tx.execute(
      sql`DELETE FROM invoice_lines
           WHERE tenant_id = ${ctx.slug}
             AND invoice_id IN (
               SELECT invoice_id FROM invoices
               WHERE tenant_id = ${ctx.slug}
                 AND document_number LIKE 'SC-2026-9%'
             )`,
    );
    return tx.execute<{ document_number: string }>(
      sql`DELETE FROM invoices
           WHERE tenant_id = ${ctx.slug}
             AND document_number LIKE 'SC-2026-9%'
           RETURNING document_number`,
    );
  });
  console.log(`deleted ${rows.length} E2E invoice rows:`);
  for (const r of rows) console.log(`  ${r.document_number}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
