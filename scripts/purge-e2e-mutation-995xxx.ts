/**
 * One-off: delete all 995xxx admin-mutation-fixture invoices so the
 * next run of `seed-f4-e2e-admin-fixtures.ts` re-provisions with a
 * corrected snapshot shape (post-bugfix 2026-04-22).
 *
 * Safe to re-run.
 */
import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { invoiceLines } from '@/modules/invoicing/infrastructure/db/schema-invoice-lines';

async function main(): Promise<void> {
  const rows = await db
    .select({ id: invoices.invoiceId, doc: invoices.documentNumber })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, 'swecham'),
        gte(invoices.sequenceNumber, 995_000),
        lt(invoices.sequenceNumber, 996_000),
      ),
    );
  console.log(`purging ${rows.length} 995xxx invoice(s):`, rows.map((r) => r.doc).join(', '));
  for (const r of rows) {
    await db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, r.id));
    await db.delete(invoices).where(eq(invoices.invoiceId, r.id));
    console.log('  deleted', r.doc);
  }
  process.exit(0);
}

void main();
