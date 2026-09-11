/**
 * Sweep the users that integration tests leaked on the shared Neon `dev`
 * branch (the `test-<ts>-<rand>@swecham.test` rows `createActiveTestUser`
 * mints). Until 2026-09-11 `deleteTestUser` could not delete a user that a
 * RESTRICT FK still pointed at and every teardown swallowed the failure, so
 * 3,774 ACTIVE admins accumulated — and every per-reviewer fan-out
 * (F114's staff email) took minutes.
 *
 * Dry-run by default: prints the count per role/status and the oldest row.
 * `--apply` sets `status = 'disabled'` on the ACTIVE ones older than
 * `--older-than-hours` (default 24) — never deletes (the FKs), never touches
 * a row that is not helper-shaped, refuses a URL that looks like prod.
 *
 *   pnpm db:sweep-test-users            # report only
 *   pnpm db:sweep-test-users -- --apply # disable the stale active ones
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');
if (/prod/i.test(url) || /prod/i.test(process.env.NEON_BRANCH ?? '')) throw new Error('refusing: the connection string looks like prod');

const apply = process.argv.includes('--apply');
const olderThanArg = process.argv.find((a) => a.startsWith('--older-than-hours='));
const olderThanHours = olderThanArg ? Number(olderThanArg.split('=')[1]) : 24;
if (!Number.isFinite(olderThanHours) || olderThanHours < 1) throw new Error('--older-than-hours must be >= 1');

// The helper's exact shape: `test-<13-digit ms timestamp>-<8 base36 chars>@swecham.test`.
const HELPER_EMAIL = '^test-[0-9]{13}-[a-z0-9]{8}@swecham\\.test$';

async function main(): Promise<void> {
  const sql = postgres(url!, { max: 1, ssl: 'require' });
  try {
    const summary = await sql`
      select role, status, count(*)::int as n, min(created_at) as oldest
      from users where email ~ ${HELPER_EMAIL}
      group by 1, 2 order by 1, 2`;
    console.table(summary);
    const stale = await sql`
      select count(*)::int as n from users
      where email ~ ${HELPER_EMAIL} and status = 'active'
        and created_at < now() - make_interval(hours => ${olderThanHours})`;
    console.log(`active helper users older than ${olderThanHours} h: ${stale[0]?.n ?? 0}`);
    if (!apply) {
      console.log('dry run — pass --apply to disable them');
      return;
    }
    const disabled = await sql`
      update users set status = 'disabled'
      where email ~ ${HELPER_EMAIL} and status = 'active'
        and created_at < now() - make_interval(hours => ${olderThanHours})
      returning id`;
    console.log(`disabled: ${disabled.length}`);
  } finally {
    await sql.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
