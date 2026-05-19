import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]?.replace(/^"|"$/g, '');
}
import postgres from 'postgres';

const TENANT_ID = 'swecham';
const EVENT_ID = process.argv[2] ?? '24d06f3c-4ad4-4da4-9210-c7dc835fc522';

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  console.log(`\n=== Event ${EVENT_ID} state ===\n`);

  const event = await sql`SELECT event_id, external_id, name, start_date, source FROM events WHERE tenant_id=${TENANT_ID} AND event_id=${EVENT_ID}`;
  console.log('event row:', event[0] ?? 'NOT FOUND');

  const regCount = (await sql`SELECT count(*)::int AS n FROM event_registrations WHERE tenant_id=${TENANT_ID} AND event_id=${EVENT_ID}`)[0];
  console.log('event_registrations:', regCount);

  const regSample = await sql`SELECT registration_id, attendee_email, match_type, payment_status, imported_at FROM event_registrations WHERE tenant_id=${TENANT_ID} AND event_id=${EVENT_ID} ORDER BY imported_at DESC LIMIT 5`;
  console.log('sample registrations:');
  for (const r of regSample) console.log(' ', r);

  const records = await sql`SELECT record_id, uploaded_at, rows_total, rows_processed, rows_already_imported, rows_skipped, rows_failed, outcome FROM csv_import_records WHERE tenant_id=${TENANT_ID} AND event_id=${EVENT_ID} ORDER BY uploaded_at DESC LIMIT 10`;
  console.log('\ncsv_import_records:');
  for (const r of records) console.log(' ', r);

  // Get receipts that LOOK like they might correspond to this event
  // (we'll examine the timestamps of recent ones)
  const receipts = await sql`SELECT request_id, processed_at FROM eventcreate_idempotency_receipts WHERE tenant_id=${TENANT_ID} AND source='eventcreate_csv' AND processed_at > now() - INTERVAL '7 days' ORDER BY processed_at DESC LIMIT 50`;
  console.log('\nReceipts in last 7 days, grouped by processed_at timestamp (likely tx batches):');
  const byTs = new Map<string, number>();
  for (const r of receipts) {
    const k = r.processed_at.toISOString();
    byTs.set(k, (byTs.get(k) ?? 0) + 1);
  }
  for (const [ts, n] of Array.from(byTs.entries()).sort()) {
    console.log(' ', ts, '→', n, 'receipts');
  }

  await sql.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
