/**
 * One-off — backfill `invoices.receipt_document_number_raw` from the
 * `audit_log.invoice_paid` payload for paid invoices where the sync
 * record-payment path forgot to persist it (pre-2026-05-15 bug).
 *
 * The audit payload always carried `receipt_document_number` so this
 * is non-lossy. The receipt PDF on Blob already has the number
 * rendered into the bytes — backfilling the column simply restores
 * the linkage the UI reads.
 *
 * Safe to re-run — only writes rows where `receipt_document_number_raw`
 * is currently NULL.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-receipt-document-number.ts <tenantId>
 */
import { db } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';

async function main(): Promise<void> {
  const tenant = process.argv[2];
  if (!tenant) {
    console.error('Usage: pnpm tsx scripts/backfill-receipt-document-number.ts <tenantId>');
    process.exit(1);
  }

  // Find paid invoices missing receipt_document_number_raw.
  const candidates = await db
    .select({ invoiceId: invoices.invoiceId })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenant),
        eq(invoices.status, 'paid'),
        isNull(invoices.receiptDocumentNumberRaw),
      ),
    );

  console.log(`[backfill] tenant=${tenant} candidates=${candidates.length}`);

  let backfilled = 0;
  let skipped = 0;
  for (const c of candidates) {
    // Read latest invoice_paid audit row for this invoice id. Use a
    // raw JSONB filter so we don't have to fetch every invoice_paid
    // row in the tenant.
    const rows = await db
      .select({ payload: auditLog.payload, timestamp: auditLog.timestamp })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant),
          eq(auditLog.eventType, 'invoice_paid'),
          sql`${auditLog.payload}->>'invoice_id' = ${c.invoiceId}`,
        ),
      );

    if (rows.length === 0) {
      console.log(`  ${c.invoiceId} → no invoice_paid audit found; skipping`);
      skipped++;
      continue;
    }
    const payload = rows[0]!.payload as Record<string, unknown>;
    const num = typeof payload.receipt_document_number === 'string'
      ? payload.receipt_document_number
      : null;
    if (!num) {
      console.log(`  ${c.invoiceId} → audit payload lacks receipt_document_number; skipping (likely combined-mode → leave NULL)`);
      skipped++;
      continue;
    }

    await db
      .update(invoices)
      .set({ receiptDocumentNumberRaw: num })
      .where(
        and(
          eq(invoices.tenantId, tenant),
          eq(invoices.invoiceId, c.invoiceId),
          // Defence: idempotency — only write if still null.
          isNull(invoices.receiptDocumentNumberRaw),
        ),
      );
    console.log(`  ${c.invoiceId} → backfilled receipt_document_number_raw = ${num}`);
    backfilled++;
  }

  console.log(`\n[backfill] done — ${backfilled} backfilled, ${skipped} skipped`);
  process.exit(0);
}

void main();
