/**
 * Diagnostic — find any `membership_plans` rows with empty `en` locale
 * in `plan_name` or `description`. These rows fail `rowToPlan`
 * hydration via `asLocaleText` and cause "Failed to load plans."
 */
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const sql = postgres(url, { ssl: 'require', max: 1 });
  try {
    const rows = await sql`
      SELECT
        tenant_id,
        plan_id,
        plan_year,
        plan_name->>'en' AS name_en,
        description->>'en' AS desc_en,
        plan_name,
        description
      FROM membership_plans
      WHERE
        plan_name->>'en' IS NULL
        OR TRIM(plan_name->>'en') = ''
        OR description->>'en' IS NULL
        OR TRIM(description->>'en') = ''
      ORDER BY tenant_id, plan_year, plan_id;
    `;
    console.log(`Found ${rows.length} rows with empty/null en locale:\n`);
    for (const r of rows) {
      console.log(
        `  tenant=${r.tenant_id} year=${r.plan_year} plan=${r.plan_id}`,
      );
      console.log(`    plan_name.en  = ${JSON.stringify(r.name_en)}`);
      console.log(`    description.en = ${JSON.stringify(r.desc_en)}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error('diagnose failed:', e.message);
  process.exit(1);
});
