/**
 * One-off cleanup for orphan eventcreate_idempotency_receipts on
 * tenant=swecham. Removes receipts whose corresponding registration
 * was deleted (manual cleanup, F6 PII erasure test, integration-test
 * teardown that didn't propagate to receipts).
 *
 * After this run, user's pending Swedish National Day CSV re-upload
 * will succeed cleanly via the new self-heal path (or, if receipts
 * are gone, via the normal fresh-insert path).
 *
 * Usage:  pnpm tsx scripts/cleanup-orphan-receipts.ts [--apply]
 *         (default = dry-run; `--apply` actually deletes)
 */
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]?.replace(/^"|"$/g, '');
}
import postgres from 'postgres';

const TENANT_ID = 'swecham';
const APPLY = process.argv.includes('--apply');

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
  console.log(`\n=== Orphan receipt cleanup for tenant=${TENANT_ID} ===`);
  console.log(`Mode: ${APPLY ? 'APPLY (destructive)' : 'DRY-RUN'}\n`);

  // Strategy: receipts for events that have ZERO registrations are
  // orphan candidates. We compute this by:
  //   1. Finding all distinct (event_id) values currently in
  //      event_registrations for this tenant.
  //   2. Pulling all receipts (request_id = rowHash; we can't directly
  //      reverse to event_id without re-computing).
  //   3. Cross-reference is not possible without the original CSV rows.
  //
  // Safe heuristic: any receipt with no matching registration in the
  // SAME tenant (regardless of event_id) is by definition orphan because
  // (tenant_id, request_id) uniquely identifies a successful registration
  // attempt that should have a corresponding row. Receipts arise only on
  // successful processAttendeeInTx commit — and that commit also writes
  // the registration in the same savepoint.
  //
  // BUT: this would lose receipts from currently-active uploads with
  // their registrations intact. Two-table join via request_id is not
  // possible (registrations don't store rowHash). So we use a coarser
  // heuristic: if the tenant has ZERO event_registrations, ALL receipts
  // are orphan. This matches the user's state (event_registrations
  // count = 0 for the affected event).

  const regsForTenant = (await sql`
    SELECT count(*)::int AS n
    FROM event_registrations
    WHERE tenant_id = ${TENANT_ID}
  `)[0].n;

  console.log(`event_registrations rows on tenant=${TENANT_ID}:`, regsForTenant);

  // List receipts with their age for context
  const receipts = await sql`
    SELECT count(*)::int AS n,
           min(processed_at) AS oldest,
           max(processed_at) AS newest
    FROM eventcreate_idempotency_receipts
    WHERE tenant_id = ${TENANT_ID} AND source = 'eventcreate_csv'
  `;
  console.log('receipts on tenant=' + TENANT_ID + ' source=eventcreate_csv:', receipts[0]);

  if (regsForTenant > 0) {
    console.log(`\n⚠ Tenant has ${regsForTenant} live event_registrations.`);
    console.log('Coarse "delete all receipts" heuristic would erase legitimate dedup state.');
    console.log('Self-heal will handle this automatically on next re-upload (bug-fix 2026-05-18).');
    console.log('Skipping bulk delete. Exit.');
    await sql.end();
    return;
  }

  console.log('\n→ event_registrations is EMPTY for this tenant. All receipts are orphan.');

  if (!APPLY) {
    console.log('\nDRY-RUN — would delete ' + receipts[0].n + ' orphan receipts.');
    console.log('Re-run with --apply to actually delete.');
    await sql.end();
    return;
  }

  console.log('\nAPPLYING — deleting orphan receipts...');
  const deleted = await sql`
    DELETE FROM eventcreate_idempotency_receipts
    WHERE tenant_id = ${TENANT_ID} AND source = 'eventcreate_csv'
    RETURNING request_id
  `;
  console.log('✓ Deleted ' + deleted.length + ' rows.');
  await sql.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
