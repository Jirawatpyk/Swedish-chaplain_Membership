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
import { seedF7Broadcasts } from './helpers/broadcasts-seed';

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
    // processor_events has no invoice_id column — stale rows for old
    // PaymentIntent ids are inert (each test creates a new PI). Skip.
    await sql`DELETE FROM refunds WHERE payment_id IN (SELECT payment_id FROM payments WHERE invoice_id = ${id})`;
    await sql`DELETE FROM payments WHERE invoice_id = ${id}`;
    await sql`UPDATE invoices SET status='issued', paid_at=NULL, payment_method=NULL, payment_date=NULL, payment_reference=NULL, updated_at=NOW() WHERE invoice_id=${id}`;
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

  try {
    const seed = await seedF7Broadcasts();
    if (seed) {
      // Worker processes inherit process.env from the parent process at
      // spawn time. Set the env vars BEFORE workers fork so every spec
      // sees them automatically.
      process.env.E2E_SEED_BROADCAST_ID = seed.broadcastId;
      process.env.E2E_SEED_HALTED_MEMBER_NAME = seed.haltedMemberDisplayName;
      // Also persist to a fixture file so workers that fork after env
      // mutation can re-read.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        '.e2e-seed.json',
        JSON.stringify(seed),
        'utf8',
      );
    }
  } catch (error) {
    console.warn('[e2e global setup] F7 broadcast seed failed:', String(error));
  }
}

export default globalSetup;
