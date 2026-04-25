/**
 * DEV-ONLY — manually mark the latest pending payment + its invoice as
 * paid. Use when the Stripe webhook is slow/stuck on Neon cold-start
 * and you just need to verify the post-payment UI flow without waiting
 * for the real `payment_intent.succeeded` to land.
 *
 * Mirrors what `confirmPayment` use-case would do server-side:
 *   1. payments.status = 'succeeded' + completed_at = NOW()
 *   2. invoices.status = 'paid' + paid_at = NOW() + payment_method = 'stripe_card'
 *
 * Does NOT emit audit events (intentional — script flags this as a
 * dev-only fast-path, not a webhook replacement).
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const invoiceId = process.argv[2];
  if (!invoiceId) {
    console.error('Usage: pnpm tsx scripts/dev-mark-paid.ts <invoiceId>');
    process.exit(1);
  }
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);

  // DB constraint `payments_card_metadata_iff_card` requires card_*
  // columns when method='card' + status terminal. Use Stripe test-card
  // 4242 metadata so the row passes the constraint.
  const payResult = await db.execute(sql`
    UPDATE payments
    SET status = 'succeeded',
        completed_at = NOW(),
        card_brand = 'visa',
        card_last4 = '4242',
        card_exp_month = 12,
        card_exp_year = 2030
    WHERE invoice_id = ${invoiceId}
      AND status = 'pending'
    RETURNING id, processor_payment_intent_id
  `);
  const invResult = await db.execute(sql`
    UPDATE invoices
    SET status = 'paid',
        paid_at = NOW(),
        payment_method = 'stripe_card'
    WHERE invoice_id = ${invoiceId}
      AND status = 'issued'
    RETURNING invoice_id
  `);

  console.log(`✓ marked invoice ${invoiceId} as paid`);
  console.log(`  payments updated: ${payResult.length}`);
  if (payResult.length > 0) {
    console.log(`    → ${JSON.stringify(payResult[0])}`);
  }
  console.log(`  invoices updated: ${invResult.length}`);
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
