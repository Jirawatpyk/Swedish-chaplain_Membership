import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]?.replace(/^"|"$/g, '');
}
import postgres from 'postgres';

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  const totalRegs = (await sql`SELECT count(*)::int AS n FROM event_registrations WHERE tenant_id='swecham'`)[0];
  const byEvent = await sql`SELECT event_id, count(*)::int AS n FROM event_registrations WHERE tenant_id='swecham' GROUP BY event_id`;
  const events = (await sql`SELECT count(*)::int AS n FROM events WHERE tenant_id='swecham'`)[0];
  const auditN = (await sql`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id='swecham' AND event_type::text LIKE 'attendee_%'`)[0];
  console.log('total event_registrations:', totalRegs);
  console.log('by event:', byEvent);
  console.log('events table:', events);
  console.log('attendee_* audit events:', auditN);
  await sql.end();
}
main();
