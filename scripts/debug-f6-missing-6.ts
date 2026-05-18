/**
 * Compare the 17 attendee emails in the Swedish National Day CSV
 * against the 11 actually persisted in event_registrations for
 * event 24d06f3c — surface the 6 missing emails so we can verify
 * which rows the self-heal should be touching.
 */
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]?.replace(/^"|"$/g, '');
}
import postgres from 'postgres';
import { createHash } from 'node:crypto';

const TENANT_ID = 'swecham';
const EVENT_ID = '24d06f3c-4ad4-4da4-9210-c7dc835fc522';

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

  // 1. Read the CSV file the user is uploading
  const csv = readFileSync(
    'docs/Attendee list/EventCreate_Guestlist-swedish-national-day-midsummer-2026.csv',
    'utf8',
  );

  // 2. Simple tokeniser — assumes Email is at index 4 in EventCreate format
  // (column order: Basic Info, Status, First Name, Last Name, Email, ...)
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0]!;
  const headerCells = parseCsvLine(header);
  const emailIdx = headerCells.indexOf('Email');
  const statusIdx = headerCells.indexOf('Status');
  const idIdx = headerCells.indexOf('Attendee ID');
  console.log('Header has columns:', headerCells.length);
  console.log('Email col index:', emailIdx, 'Status idx:', statusIdx, 'AttendeeID idx:', idIdx);

  const csvAttendees: { email: string; status: string; attendeeId: string }[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    csvAttendees.push({
      email: (cells[emailIdx] ?? '').replace(/^mailto:/, '').trim().toLowerCase(),
      status: (cells[statusIdx] ?? '').trim(),
      attendeeId: (cells[idIdx] ?? '').trim(),
    });
  }
  console.log(`\nCSV attendees (${csvAttendees.length}):`);
  for (const a of csvAttendees) console.log(' ', a);

  // 3. Get persisted registrations
  const persisted = await sql`
    SELECT attendee_email, attendee_email_lower, external_id, payment_status
    FROM event_registrations
    WHERE tenant_id=${TENANT_ID} AND event_id=${EVENT_ID}
  `;
  const persistedEmails = new Set(persisted.map((r) => (r as { attendee_email_lower: string }).attendee_email_lower));
  console.log(`\nPersisted registrations (${persisted.length}):`);
  for (const r of persisted) console.log(' ', r);

  // 4. Diff
  const missing = csvAttendees.filter((a) => !persistedEmails.has(a.email));
  console.log(`\n=== Missing in DB (${missing.length}) ===`);
  for (const m of missing) console.log(' ', m);

  // 5. Compute rowHash for each missing email + check if receipt exists
  // rowHash = sha256(event_external_id + " " + email + " " + ts)
  const evt = (await sql`SELECT external_id, start_date FROM events WHERE event_id=${EVENT_ID} AND tenant_id=${TENANT_ID}`)[0];
  console.log('\nEvent external_id:', evt.external_id);
  console.log('Event start_date:', evt.start_date.toISOString());

  const ts = evt.start_date.toISOString();
  for (const m of missing) {
    const canonical = `${evt.external_id} ${m.email} ${ts}`;
    const hash = createHash('sha256').update(canonical, 'utf8').digest('hex');
    const receipt = await sql`
      SELECT processed_at, ttl_expires_at FROM eventcreate_idempotency_receipts
      WHERE tenant_id=${TENANT_ID} AND source='eventcreate_csv' AND request_id=${hash}
    `;
    console.log(`\nemail=${m.email}`);
    console.log(`  rowHash=${hash}`);
    console.log(`  receipt match:`, receipt[0] ?? 'NO MATCH');
  }

  await sql.end();
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') inQuotes = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
