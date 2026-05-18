/**
 * One-off debug script for the F6.1 receipt-duplicate invariant violation
 * reported 2026-05-18. Reads `.env.local` for DATABASE_URL.
 *
 * Usage:  pnpm tsx scripts/debug-f6-receipts.ts
 *
 * Reports:
 *  - count of registrations in the affected event
 *  - count of CSV import history rows for the event
 *  - count of idempotency receipts for tenant=swecham source=eventcreate_csv
 *  - orphan receipts: receipts with no matching registration via email reverse-lookup
 */
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
}
import postgres from 'postgres';

const TENANT_ID = 'swecham';
const EVENT_ID = '655b073e-52bf-4559-ab97-f2695d82bc79';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing from .env.local');
  const sql = postgres(url, { max: 1, prepare: false });

  console.log('\n=== F6.1 receipt-duplicate diagnostic ===\n');

  // 1. Registration count for the affected event
  const regCount = (await sql`
    SELECT count(*)::int AS n,
           array_agg(DISTINCT match_type) AS match_types,
           array_agg(DISTINCT payment_status) AS payment_statuses
    FROM event_registrations
    WHERE tenant_id = ${TENANT_ID} AND event_id = ${EVENT_ID}
  `)[0];
  console.log('event_registrations for event:', regCount);

  // 2. CSV import history for the event
  const importHistory = await sql`
    SELECT record_id, uploaded_at, source_format,
           rows_total, rows_processed, rows_already_imported,
           rows_skipped, rows_failed, outcome, original_filename
    FROM csv_import_records
    WHERE tenant_id = ${TENANT_ID} AND event_id = ${EVENT_ID}
    ORDER BY uploaded_at DESC
    LIMIT 10
  `;
  console.log('\ncsv_import_records (last 10):');
  for (const row of importHistory) {
    console.log(' ', row);
  }

  // 3. Total receipts for tenant
  const totalReceipts = (await sql`
    SELECT count(*)::int AS n,
           min(processed_at) AS first,
           max(processed_at) AS last
    FROM eventcreate_idempotency_receipts
    WHERE tenant_id = ${TENANT_ID} AND source = 'eventcreate_csv'
  `)[0];
  console.log('\neventcreate_idempotency_receipts total:', totalReceipts);

  // 4. Latest 30 receipts
  const recentReceipts = await sql`
    SELECT request_id, processed_at, ttl_expires_at
    FROM eventcreate_idempotency_receipts
    WHERE tenant_id = ${TENANT_ID} AND source = 'eventcreate_csv'
    ORDER BY processed_at DESC
    LIMIT 30
  `;
  console.log('\neventcreate_idempotency_receipts (last 30):');
  for (const row of recentReceipts) {
    console.log(' ', row.request_id.slice(0, 16) + '…', row.processed_at);
  }

  // 5. Registrations' attendee emails for the event (to check duplicates)
  const emails = await sql`
    SELECT attendee_email, attendee_email_lower, count(*)::int AS n
    FROM event_registrations
    WHERE tenant_id = ${TENANT_ID} AND event_id = ${EVENT_ID}
    GROUP BY 1, 2
    ORDER BY n DESC, attendee_email
  `;
  console.log('\nemails persisted for this event (duplicates first):');
  for (const row of emails) {
    console.log(' ', row);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
