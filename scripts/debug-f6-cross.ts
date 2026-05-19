import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]?.replace(/^"|"$/g, '');
}
import postgres from 'postgres';

const TENANT_ID = 'swecham';
const EVENT_ID = '24d06f3c-4ad4-4da4-9210-c7dc835fc522';

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

  // The CSV has 17 attendees. The script said 0 missing meaning all 17 emails
  // are in event_registrations SOMEWHERE for this tenant.
  // But event 24d06f3c shows only 11.
  // → Some attendees may be registered under a DIFFERENT event_id.
  const csv = readFileSync(
    'docs/Attendee list/EventCreate_Guestlist-swedish-national-day-midsummer-2026.csv',
    'utf8',
  );
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]!);
  const emailIdx = header.indexOf('Email');
  const emails = lines.slice(1).map((l) => (parseCsvLine(l)[emailIdx] ?? '').replace(/^mailto:/, '').trim().toLowerCase());

  console.log(`\n=== Cross-event registration check for ${emails.length} CSV attendees ===\n`);

  const rows = await sql`
    SELECT event_id, attendee_email_lower, external_id, imported_at
    FROM event_registrations
    WHERE tenant_id=${TENANT_ID} AND attendee_email_lower = ANY(${emails as unknown as string[]})
    ORDER BY imported_at DESC
  `;

  const byEvent = new Map<string, string[]>();
  for (const r of rows) {
    const arr = byEvent.get(r.event_id) ?? [];
    arr.push(r.attendee_email_lower);
    byEvent.set(r.event_id, arr);
  }

  console.log('Registrations of these emails, grouped by event_id:');
  for (const [eid, em] of byEvent) {
    console.log(`  event=${eid}  (${em.length} rows)`);
    for (const e of em) console.log(`    ${e}`);
  }

  // Specific check on the user's selected event
  const inSelected = (byEvent.get(EVENT_ID) ?? []).length;
  console.log(`\n→ On selected event ${EVENT_ID}: ${inSelected} of ${emails.length} emails present`);
  console.log(`→ MISSING from selected event:`);
  const presentSet = new Set(byEvent.get(EVENT_ID) ?? []);
  for (const e of emails) {
    if (!presentSet.has(e)) console.log(`    ${e}`);
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
