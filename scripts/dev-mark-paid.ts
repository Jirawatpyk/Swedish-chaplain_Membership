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
 *
 * Production-DB guard
 * --------------------
 * Refuses to run if `NODE_ENV=production` OR if `DATABASE_URL`
 * matches production markers (`prod`/`live`/`vercel-storage`).
 * Override (e.g. for a Neon staging branch whose URL pattern looks
 * production-like) by setting `DEV_SCRIPT_FORCE=1`. Use only after
 * verifying the target is genuinely a non-production environment.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

/** R5 I2 — see dev-purge-invoice-payments.ts for rationale. */
function assertNotProduction(databaseUrl: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'REFUSED: NODE_ENV=production. This script is destructive and forbidden in production.',
    );
  }
  const lower = databaseUrl.toLowerCase();
  if (
    lower.includes('vercel-storage') ||
    lower.includes('-prod') ||
    lower.includes('.prod.') ||
    lower.includes('-live') ||
    lower.includes('.live.')
  ) {
    throw new Error(
      'REFUSED: DATABASE_URL looks like a production endpoint. ' +
        'Override with DEV_SCRIPT_FORCE=1 if intentional.',
    );
  }
}

async function main() {
  const invoiceId = process.argv[2];
  if (!invoiceId) {
    console.error('Usage: pnpm tsx scripts/dev-mark-paid.ts <invoiceId>');
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL not set');
  if (process.env.DEV_SCRIPT_FORCE !== '1') assertNotProduction(databaseUrl);
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  // Detect the pending payment's `method` so the UPDATE matches the
  // method-specific DB constraints + the invoice `payment_method` flip
  // mirrors the actual rail (card vs promptpay). Hard-coding 'stripe_card'
  // would violate `payments_card_metadata_iff_card` for promptpay rows
  // (R-S1 polish 2026-04-26).
  const pendingRows = await db.execute(sql`
    SELECT id, method
    FROM payments
    WHERE invoice_id = ${invoiceId} AND status = 'pending'
    ORDER BY initiated_at DESC
    LIMIT 1
  `);
  if (pendingRows.length === 0) {
    console.error(`✗ no pending payment row for invoice ${invoiceId}`);
    await client.end();
    process.exit(1);
  }
  const method = (pendingRows[0] as { method: 'card' | 'promptpay' }).method;
  const isCard = method === 'card';

  // `payments_card_metadata_iff_card` constraint: card columns required
  // when method='card' + terminal status; MUST be NULL for promptpay.
  const payResult = isCard
    ? await db.execute(sql`
        UPDATE payments
        SET status = 'succeeded',
            completed_at = NOW(),
            card_brand = 'visa',
            card_last4 = '4242',
            card_exp_month = 12,
            card_exp_year = 2030
        WHERE invoice_id = ${invoiceId} AND status = 'pending'
        RETURNING id, processor_payment_intent_id
      `)
    : await db.execute(sql`
        UPDATE payments
        SET status = 'succeeded',
            completed_at = NOW()
        WHERE invoice_id = ${invoiceId} AND status = 'pending'
        RETURNING id, processor_payment_intent_id
      `);

  const invoicePaymentMethod = isCard ? 'stripe_card' : 'stripe_promptpay';
  const invResult = await db.execute(sql`
    UPDATE invoices
    SET status = 'paid',
        paid_at = NOW(),
        payment_method = ${invoicePaymentMethod}
    WHERE invoice_id = ${invoiceId}
      AND status = 'issued'
    RETURNING invoice_id
  `);

  console.log(`✓ marked invoice ${invoiceId} as paid (method=${method})`);
  console.log(`  payments updated: ${payResult.length}`);
  if (payResult.length > 0) {
    console.log(`    → ${JSON.stringify(payResult[0])}`);
  }
  console.log(`  invoices updated: ${invResult.length}`);
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
