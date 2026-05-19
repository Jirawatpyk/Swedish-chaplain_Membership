/**
 * Phase 2 diagnostic: trace audit events on event 655b073e-... between
 * 04:30 → 05:00 to find what deleted the 11 registrations.
 */
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
}
import postgres from 'postgres';

const TENANT_ID = 'swecham';
const _EVENT_ID = '655b073e-52bf-4559-ab97-f2695d82bc79';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing');
  const sql = postgres(url, { max: 1, prepare: false });

  console.log('\n=== Audit events for the affected event ===\n');

  const events = await sql`
    SELECT event_type, timestamp, actor_user_id, payload->>'eventId' AS payload_event
    FROM audit_log
    WHERE tenant_id = ${TENANT_ID}
      AND timestamp BETWEEN '2026-05-18 04:30:00'::timestamptz AND '2026-05-18 05:00:00'::timestamptz
    ORDER BY timestamp ASC
  `;
  console.log(`Audit events in window: ${events.length}`);
  for (const e of events) {
    console.log(' ', e.timestamp.toISOString(), e.event_type, 'event=', e.payload_event);
  }

  // count by event_type type
  const byType = await sql`
    SELECT event_type, count(*)::int AS n
    FROM audit_log
    WHERE tenant_id = ${TENANT_ID}
      AND timestamp BETWEEN '2026-05-18 04:30:00'::timestamptz AND '2026-05-18 05:00:00'::timestamptz
    GROUP BY event_type
    ORDER BY n DESC
  `;
  console.log('\nBy event_type:');
  for (const r of byType) {
    console.log(' ', r.event_type, r.n);
  }

  // Are there deleted/pseudonymised marks on event_registrations?
  const pseudoCount = (await sql`
    SELECT count(*)::int AS n FROM event_registrations
    WHERE tenant_id = ${TENANT_ID} AND pii_pseudonymised_at IS NOT NULL
  `)[0];
  console.log('\nPseudonymised rows tenant-wide:', pseudoCount);

  // All event_types in event_registrations for this tenant
  const allEventRegs = await sql`
    SELECT event_type, count(*)::int AS n
    FROM event_registrations
    WHERE tenant_id = ${TENANT_ID}
    GROUP BY event_type
    ORDER BY n DESC
  `;
  console.log('\nAll event_registrations grouped by event_type:');
  for (const r of allEventRegs) console.log(' ', r);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
