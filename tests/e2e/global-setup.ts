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
import { seedF8Renewals } from './helpers/renewals-seed';
import { seedF6Events } from './helpers/eventcreate-seed';

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
    //
    // admin-refund-full.spec leaves a paid→refunded→credited chain on this
    // fixture invoice. Unwinding it has to respect a web of F5 constraints, in
    // this exact order:
    //
    //  1. credit_notes.source_refund_id → refunds.id (credit_notes_source_refund_fk)
    //     and refunds.credit_note_id → credit_notes (refunds_credit_note_tenant_fk)
    //     form a CIRCULAR FK. Break it on the credit_notes side by nulling
    //     source_refund_id — a plain nullable FK NOT covered by the
    //     credit_notes immutability trigger (migration 0027 guards only
    //     snapshot/money/pdf cols, BEFORE UPDATE). The other side
    //     (refunds.credit_note_id) is tied to refund status by the CHECK
    //     refunds_succeeded_iff_complete and cannot be nulled on a succeeded
    //     refund.
    //  2. DELETE the refunds (now unreferenced by credit_notes).
    //  3. DELETE the credit_notes for this invoice (the immutability trigger is
    //     BEFORE UPDATE only, so DELETE is allowed; their refund refs are gone).
    //  4. DELETE the payments.
    //  5. Reset the invoice — status='issued' REQUIRES credited_total_satang=0
    //     (CHECK invoices_credited_status_matches), so zero it alongside the
    //     payment fields, else the UPDATE violates that CHECK.
    await sql`UPDATE credit_notes SET source_refund_id = NULL WHERE source_refund_id IN (SELECT id FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE invoice_id = ${id}))`;
    await sql`DELETE FROM refunds WHERE payment_id IN (SELECT id FROM payments WHERE invoice_id = ${id})`;
    await sql`DELETE FROM credit_notes WHERE original_invoice_id = ${id}`;
    await sql`DELETE FROM payments WHERE invoice_id = ${id}`;
    await sql`UPDATE invoices SET status='issued', credited_total_satang=0, paid_at=NULL, payment_method=NULL, payment_date=NULL, payment_reference=NULL, updated_at=NOW() WHERE invoice_id=${id}`;
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

  try {
    const renewalsSeed = await seedF8Renewals();
    if (renewalsSeed) {
      process.env.E2E_SEED_RENEWAL_CYCLE_ID = renewalsSeed.cycleId;
      process.env.E2E_SEED_RENEWAL_MEMBER_ID = renewalsSeed.memberId;
    }
  } catch (error) {
    console.warn('[e2e global setup] F8 renewals seed failed:', String(error));
  }

  try {
    const eventsSeed = await seedF6Events();
    if (eventsSeed) {
      process.env.E2E_SEED_F6_PB_EVENT_ID = eventsSeed.partnerBenefitEventId;
      process.env.E2E_SEED_F6_CULTURAL_EVENT_ID = eventsSeed.culturalEventId;
      process.env.E2E_SEED_F6_ARCHIVED_EVENT_ID = eventsSeed.archivedEventId;
    }
  } catch (error) {
    console.warn('[e2e global setup] F6 events seed failed:', String(error));
  }
}

export default globalSetup;
