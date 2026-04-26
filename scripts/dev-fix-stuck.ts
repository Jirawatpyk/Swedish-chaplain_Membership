/** DEV-ONLY — fix invoice stuck at 'issued' when payment is succeeded. */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: pnpm tsx scripts/dev-fix-stuck.ts <invoiceId>');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const lower = url.toLowerCase();
  if (
    process.env.NODE_ENV === 'production' ||
    lower.includes('vercel-storage') ||
    lower.includes('-prod') ||
    lower.includes('.prod.')
  ) {
    throw new Error('REFUSED: production-looking DATABASE_URL.');
  }
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  // 1. Cancel any leftover pending payments
  const cancelled = await db.execute(sql`
    UPDATE payments
    SET status = 'canceled', completed_at = NOW()
    WHERE invoice_id = ${id} AND status = 'pending'
    RETURNING id
  `);
  // 2. Mark invoice paid (since a succeeded payment exists)
  const updated = await db.execute(sql`
    UPDATE invoices
    SET status = 'paid', paid_at = NOW(), payment_method = 'stripe_card'
    WHERE invoice_id = ${id}
      AND status = 'issued'
      AND EXISTS (SELECT 1 FROM payments WHERE invoice_id = ${id} AND status = 'succeeded')
    RETURNING invoice_id
  `);
  console.log(`✓ canceled ${cancelled.length} pending payment row(s)`);
  console.log(`✓ updated ${updated.length} invoice row(s) to paid`);
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
