/**
 * Playwright global setup.
 *
 * Runs ONCE before any test starts. Two responsibilities:
 *  1. Clears Upstash rate-limit buckets so a prior run's residue doesn't
 *     trip the 5/15-min sign-in limit on the dedicated test users.
 *  2. Resets the F5 issued-invoice fixture row (E2E_ISSUED_INVOICE_ID)
 *     back to status='issued' so the Pay-now button renders again after
 *     a happy-path run flipped it to `paid`. Cascades through child
 *     payments / refunds / processor_events first.
 *
 * Registered via `globalSetup` in `playwright.config.ts`.
 */
import postgres from 'postgres';
import { clearE2ERateLimits } from './helpers/rate-limit';

async function resetF5IssuedInvoice(): Promise<void> {
  const id = process.env.E2E_ISSUED_INVOICE_ID;
  const dbUrl = process.env.DATABASE_URL;
  if (!id || !dbUrl) {
    console.warn(
      '[e2e global setup] skipping F5 invoice reset — E2E_ISSUED_INVOICE_ID or DATABASE_URL missing',
    );
    return;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    await sql`DELETE FROM refunds WHERE payment_id IN (SELECT payment_id FROM payments WHERE invoice_id = ${id})`;
    await sql`DELETE FROM processor_events WHERE invoice_id = ${id}`;
    await sql`DELETE FROM payments WHERE invoice_id = ${id}`;
    await sql`UPDATE invoices SET status='issued', paid_at=NULL, payment_method=NULL, payment_date=NULL, payment_reference=NULL, paid_amount_satang=NULL, updated_at=NOW() WHERE invoice_id=${id}`;
    console.log(`[e2e global setup] reset F5 issued-invoice fixture ${id}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function globalSetup(): Promise<void> {
  try {
    await clearE2ERateLimits();
    console.log('[e2e global setup] cleared Upstash rate-limit buckets');
  } catch (error) {
    // Don't fail the entire run if Upstash is unreachable — individual
    // specs can still handle rate-limit responses on their own.
    console.warn('[e2e global setup] rate-limit clear failed:', String(error));
  }

  try {
    await resetF5IssuedInvoice();
  } catch (error) {
    console.warn('[e2e global setup] F5 invoice reset failed:', String(error));
  }
}

export default globalSetup;
