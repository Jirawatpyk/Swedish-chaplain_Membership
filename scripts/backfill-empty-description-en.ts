/**
 * Backfill empty `description.en` rows in `membership_plans` using
 * `plan_name.en` as the fallback value. Same semantics as the R3-C1
 * seed-script fallback (`scripts/seed-swecham-2026-plans.ts:469-505`).
 *
 * Symptoms: `/admin/plans` page returns "Failed to load plans"
 * because `rowToPlan` → `asLocaleText` throws `EmptyEnLocaleTextError`
 * on rows where `description.en` is an empty string.
 *
 * Pre-flight: diagnostic at `scripts/diagnose-empty-locale-rows.ts`
 * confirmed all candidate rows have non-empty `plan_name.en` (safe
 * fallback source) and empty `description.en` (the target field).
 *
 * Strategy:
 *   - Wrap the UPDATE in a single transaction.
 *   - Filter by tenant_id = $TENANT to scope safely.
 *   - Use `jsonb_set` to preserve `th`/`sv` locales already in `description`.
 *   - Print BEFORE + AFTER counts for verification.
 *
 * Usage:
 *   TENANT_SLUG=swecham node --env-file=.env.local --import tsx \
 *     scripts/backfill-empty-description-en.ts
 *
 * The script defaults to DRY_RUN=true unless `BACKFILL_APPLY=true`.
 */
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const tenant = process.env.TENANT_SLUG;
  if (!tenant) {
    console.error('TENANT_SLUG not set (e.g., TENANT_SLUG=swecham)');
    process.exit(1);
  }
  const apply = process.env.BACKFILL_APPLY === 'true';

  const sql = postgres(url, { ssl: 'require', max: 1 });
  try {
    const before = await sql<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
      FROM membership_plans
      WHERE tenant_id = ${tenant}
        AND (description->>'en' IS NULL OR TRIM(description->>'en') = '');
    `;
    const beforeCount = Number(before[0]!.count);
    console.log(`BEFORE: ${beforeCount} rows with empty description.en in tenant=${tenant}`);

    if (beforeCount === 0) {
      console.log('Nothing to backfill. Exiting.');
      return;
    }

    if (!apply) {
      console.log('\nDRY_RUN — no changes applied.');
      console.log('Preview SQL that WOULD run:\n');
      console.log(`UPDATE membership_plans`);
      console.log(`SET description = jsonb_set(description, '{en}', to_jsonb(plan_name->>'en'))`);
      console.log(`WHERE tenant_id = '${tenant}'`);
      console.log(`  AND (description->>'en' IS NULL OR TRIM(description->>'en') = '');`);
      console.log(`\nRe-run with BACKFILL_APPLY=true to execute.`);
      return;
    }

    console.log('\nApplying backfill...');
    await sql.begin(async (tx) => {
      const updated = await tx<{ count: bigint }[]>`
        WITH updated AS (
          UPDATE membership_plans
          SET description = jsonb_set(
            description,
            '{en}',
            to_jsonb(plan_name->>'en')
          )
          WHERE tenant_id = ${tenant}
            AND (description->>'en' IS NULL OR TRIM(description->>'en') = '')
          RETURNING 1
        )
        SELECT COUNT(*) AS count FROM updated;
      `;
      console.log(`Updated ${Number(updated[0]!.count)} rows in transaction.`);
    });

    const after = await sql<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
      FROM membership_plans
      WHERE tenant_id = ${tenant}
        AND (description->>'en' IS NULL OR TRIM(description->>'en') = '');
    `;
    console.log(`AFTER:  ${Number(after[0]!.count)} rows with empty description.en`);
    console.log('\nBackfill complete. Refresh /admin/plans to verify.');
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error('backfill failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
