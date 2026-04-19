/**
 * T014 — Idempotent seeder for the SweCham tenant's
 * `tenant_invoice_settings` row (F4).
 *
 * Usage: `node --env-file=.env.local --import tsx scripts/seed-f4-invoice-settings.ts`
 *
 * Safe to re-run — upserts by `tenant_id`. Used by:
 *   - Local dev (first-time setup)
 *   - E2E tests (via Playwright globalSetup) once F4 US1 lands
 *   - Staging / production bootstrap before the US4 settings UI ships
 *
 * Spec defaults (docs/membership-benefits-analysis.md §):
 *   - VAT 7% (Thai RD standard rate)
 *   - Registration fee: 5,000 THB = 500,000 satang
 *   - Legal name: Thailand-Swedish Chamber of Commerce / หอการค้าไทย-สวีเดน
 *   - Tax ID: placeholder — update before production seed
 *   - Prefix: SC (Swedish Chamber)
 *   - Combined receipt numbering (single ใบกำกับภาษี/ใบเสร็จรับเงิน)
 *   - Fiscal year starts January (calendar-year)
 *   - Net 30 days, monthly pro-rate
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

process.loadEnvFile?.('.env.local');

const url =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_URL;
if (!url) {
  console.error('seed-f4-invoice-settings: DATABASE_URL is required.');
  process.exit(1);
}

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';

async function main(): Promise<void> {
  const client = postgres(url!, { max: 1, ssl: 'require' });
  const db = drizzle(client);

  try {
    // Set app.current_tenant for RLS — use set_config() because
    // `SET LOCAL` does not accept bind parameters in Postgres.
    await db.execute(sql`SELECT set_config('app.current_tenant', ${TENANT_SLUG}, TRUE)`);

    // Upsert by tenant_id (PK).
    await db.execute(sql`
      INSERT INTO tenant_invoice_settings (
        tenant_id,
        vat_rate,
        registration_fee_satang,
        legal_name_th, legal_name_en,
        tax_id,
        registered_address_th, registered_address_en,
        invoice_number_prefix,
        invoice_number_reset_cadence,
        receipt_numbering_mode,
        credit_note_number_prefix,
        fiscal_year_start_month,
        default_net_days,
        pro_rate_policy,
        auto_email_enabled,
        tenant_logo_count
      ) VALUES (
        ${TENANT_SLUG},
        0.0700,
        500000,
        ${'หอการค้าไทย-สวีเดน'},
        ${'Thailand-Swedish Chamber of Commerce'},
        ${'0000000000000'},
        ${'กรุงเทพมหานคร 10110'},
        ${'Bangkok 10110'},
        'SC',
        'yearly',
        'combined',
        'CN',
        1,
        30,
        'monthly',
        TRUE,
        0
      )
      ON CONFLICT (tenant_id) DO NOTHING
    `);

    console.log(`✓ seeded tenant_invoice_settings for ${TENANT_SLUG} (idempotent)`);
  } catch (error) {
    console.error('✗ seed-f4-invoice-settings failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('seed-f4-invoice-settings: crashed:', error);
  process.exit(1);
});
