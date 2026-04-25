/**
 * DEV-ONLY — purge ALL payment rows + reset invoice for re-testing.
 *
 * Use when `dev-reset-invoice-to-issued.ts` is not enough — Stripe
 * idempotency-keys live for 24h and the same `attempt_seq` reused
 * with different params produces `StripeIdempotencyError` 400 →
 * route returns 502 `processor_unavailable`.
 *
 * Deleting the payment rows entirely makes `nextAttemptSeq` return 1
 * on the next initiate, generating a fresh idempotency-key Stripe has
 * never seen.
 *
 * Cleanup order respects FKs:
 *   1. refunds → references payments
 *   2. payments → references invoices
 *   3. invoices → reset to issued
 *
 * Run via:
 *   pnpm tsx --env-file=.env.local scripts/dev-purge-invoice-payments.ts <invoiceId>
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

/**
 * R5 I2 (2026-04-25): production-DB safety guard. Refuse to run if
 * NODE_ENV is 'production' OR DATABASE_URL contains a production
 * marker (`prod`, `live`, `vercel-storage`). The risk: a developer
 * who ran `vercel env pull` into `.env.local` would silently corrupt
 * live data when invoking this destructive script.
 */
function assertNotProduction(databaseUrl: string): void {
  const nodeEnv = process.env.NODE_ENV ?? '';
  if (nodeEnv === 'production') {
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
      'REFUSED: DATABASE_URL looks like a production endpoint (matched on prod/live/vercel-storage). ' +
        'If this is wrong, override by setting `DEV_SCRIPT_FORCE=1`.',
    );
  }
}

async function main() {
  const invoiceId = process.argv[2];
  if (!invoiceId) {
    console.error('Usage: pnpm tsx scripts/dev-purge-invoice-payments.ts <invoiceId>');
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL not set');
  }
  if (process.env.DEV_SCRIPT_FORCE !== '1') {
    assertNotProduction(databaseUrl);
  }
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  // Use RETURNING so we get back the affected rows — `db.execute(sql\`DELETE\`)`
  // discards the postgres-js `count` field, so the only reliable way to
  // count affected rows is to ask for them back.
  const refundResult = await db.execute(sql`
    DELETE FROM refunds WHERE payment_id IN (
      SELECT id FROM payments WHERE invoice_id = ${invoiceId}
    )
    RETURNING id
  `);
  const paymentResult = await db.execute(sql`
    DELETE FROM payments WHERE invoice_id = ${invoiceId}
    RETURNING id
  `);
  const invoiceResult = await db.execute(sql`
    UPDATE invoices
    SET status = 'issued', paid_at = NULL, payment_method = NULL
    WHERE invoice_id = ${invoiceId}
    RETURNING invoice_id
  `);

  console.log(`✓ purged invoice ${invoiceId}`);
  console.log(`  refunds deleted : ${refundResult.length}`);
  console.log(`  payments deleted: ${paymentResult.length}`);
  console.log(`  invoice updated : ${invoiceResult.length}`);
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
