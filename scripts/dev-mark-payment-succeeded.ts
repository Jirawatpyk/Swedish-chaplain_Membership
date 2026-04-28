/**
 * DEV-ONLY one-off: normalise a stale pending-payment row whose Stripe
 * PaymentIntent has already reached a terminal state because the
 * Stripe CLI webhook forwarder was not running when the charge
 * settled.
 *
 * Usage:
 *   pnpm tsx scripts/dev-mark-payment-succeeded.ts <paymentIntentId>
 *
 * Example:
 *   pnpm tsx scripts/dev-mark-payment-succeeded.ts pi_3TPjX6Q4m6l8Pdqx1CaUPoNL
 *
 * Do NOT run in production — the webhook handler is the canonical
 * path and bypassing it skips audit events + processor_events log.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const paymentIntentId = process.argv[2];
  if (!paymentIntentId || !paymentIntentId.startsWith('pi_')) {
     
    console.error(
      'Usage: pnpm tsx scripts/dev-mark-payment-succeeded.ts <pi_...>',
    );
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
     
    console.error('DATABASE_URL missing from env');
    process.exit(1);
  }

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  // Find the payment row + owning invoice.
  const rows = await db.execute<{
    id: string;
    tenant_id: string;
    invoice_id: string;
    status: string;
  }>(sql`
    SELECT id, tenant_id, invoice_id, status
    FROM payments
    WHERE processor_payment_intent_id = ${paymentIntentId}
    LIMIT 1
  `);
  const payment = rows[0];
  if (!payment) {
     
    console.error(`No payment row for ${paymentIntentId}`);
    process.exit(1);
  }
   
  console.log(`Found payment ${payment.id} (status=${payment.status}) for invoice ${payment.invoice_id}`);

  // Mark payment succeeded — card-method rows also need card metadata
  // to satisfy CHECK constraint `payments_card_metadata_iff_card`.
  await db.execute(sql`
    UPDATE payments
    SET status = 'succeeded',
        completed_at = NOW(),
        card_brand = COALESCE(card_brand, 'visa'),
        card_last4 = COALESCE(card_last4, '4242'),
        card_exp_month = COALESCE(card_exp_month, 12),
        card_exp_year = COALESCE(card_exp_year, 2034),
        processor_charge_id = COALESCE(processor_charge_id, 'ch_dev_seeded')
    WHERE id = ${payment.id}
  `);
   
  console.log('✓ payments.status = succeeded');

  // Mark invoice paid. CHECK `invoices_paid_has_payment` requires
  // both `paid_at` AND `payment_method` to be non-null for paid rows.
  await db.execute(sql`
    UPDATE invoices
    SET status = 'paid',
        paid_at = NOW(),
        payment_method = 'card'
    WHERE invoice_id = ${payment.invoice_id}
  `);
   
  console.log('✓ invoices.status = paid');

   
  console.log(
    `\nDONE. Refresh /portal/invoices/${payment.invoice_id} to see the paid state.`,
  );
  await client.end();
  process.exit(0);
}

main().catch((err) => {
   
  console.error(err);
  process.exit(1);
});
