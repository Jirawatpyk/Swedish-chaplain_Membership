/**
 * VAT-registration review report (operator tool).
 *
 * Lists members whose imported `is_vat_registered` seed is `false` but whose
 * true status is uncertain and should be confirmed, because a §86/4 tax
 * invoice to a VAT-registrant buyer must carry the buyer's TIN (+ head-office /
 * branch). The importer derives the seed from legal form + tax-ID presence
 * (a reasonable PRIOR, not a legal fact — VAT registration follows turnover
 * > 1.8M THB/yr, not legal form), so these need a human check + the member's
 * real tax_id captured via the member form:
 *
 *   - state_enterprise / limited_company / public_company seeded false purely
 *     because the sheet had no tax_id  → almost certainly a registrant
 *   - (null) legal_entity_type          → round-2 unresolved rows
 *   - foundation / association          → may or may not be registered
 *   - individual WITH a tax_id          → possible registered sole proprietor
 *
 * Individuals with no tax_id are omitted (correctly non-registrant).
 *
 * READ-ONLY. Connects directly with DATABASE_URL (bypasses the app's full env
 * validation) so it can run against a prod-scoped env file:
 *
 *   node --env-file=.env.production --import tsx scripts/report-vat-review-candidates.ts
 *
 * Output includes company names (the operator's own data) — do NOT commit the
 * output. It does not print tax IDs or contact PII.
 */
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing (pass --env-file=.env.production)');
  const sql = postgres(url, { ssl: 'require', max: 1 });
  try {
    const rows = await sql`
      SELECT
        member_number,
        company_name,
        COALESCE(legal_entity_type, '(null)') AS legal_entity_type,
        (tax_id IS NOT NULL) AS has_tax_id,
        CASE
          WHEN turnover_thb IS NULL THEN 'unknown'
          WHEN turnover_thb >= 1800000 THEN 'ge_1.8M'
          ELSE 'lt_1.8M'
        END AS turnover
      FROM members
      WHERE NOT is_vat_registered
        AND (legal_entity_type IS NULL OR legal_entity_type <> 'individual' OR tax_id IS NOT NULL)
      ORDER BY
        CASE COALESCE(legal_entity_type, '(null)')
          WHEN 'state_enterprise' THEN 1
          WHEN 'limited_company' THEN 2
          WHEN 'public_company' THEN 3
          WHEN 'foundation' THEN 4
          WHEN 'association' THEN 5
          WHEN '(null)' THEN 6
          ELSE 7
        END,
        company_name
    `;
    console.log(`VAT-review candidates (is_vat_registered=false, uncertain): ${rows.length}`);
    console.table(rows);
    console.log(
      '\nAction: confirm each member’s VAT-registrant status with the member; for a' +
        '\nregistrant, capture their 13-digit tax_id and tick "registered for VAT" on the' +
        '\nmember edit form so future §86/4 invoices carry the buyer TIN.',
    );
  } finally {
    await sql.end();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
