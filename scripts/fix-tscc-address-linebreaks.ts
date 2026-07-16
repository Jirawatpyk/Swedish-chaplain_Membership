/**
 * One-off operational fix — insert PDF line breaks into the SweCham tenant's
 * §86/4 seller address (`tenant_invoice_settings.registered_address_{th,en}`).
 *
 * WHY: the admin Settings form used a single-line <input> for the address, so a
 * line break could never be entered, and the invoice/receipt PDF auto-wrapped
 * the seller block at bad points (prod UAT: Thai "ถนน" split from "พญาไท"; the
 * English street overflowing onto "Thung Phayathai, ...Bangkok 10400"). The form
 * is now a <textarea> and the PDF template honours '\n', so this backfills the
 * two desired break points into the EXISTING stored value.
 *
 * TRANSFORM-IN-PLACE (not overwrite): reads the live value and inserts a newline
 * BEFORE "ถนนพญาไท" (TH) and BEFORE "Thung Phayathai" (EN), consuming any
 * whitespace already there. It never reconstructs the address from a literal, so
 * whatever the admin actually typed is preserved — only the break is added.
 *
 * IDEMPOTENT: the `\s*<token>` match also consumes an already-inserted '\n', so
 * re-running is a no-op. SAFE: it only affects NEW invoice previews / issuances —
 * already-issued documents keep their frozen address snapshot (FR-011).
 *
 * Usage:
 *   node --import tsx scripts/fix-tscc-address-linebreaks.ts [envFile] [apply]
 *     envFile : path to the env file to load (default `.env.local` = dev branch)
 *     apply   : the literal word `apply` to WRITE; omit for a read-only dry-run
 *
 *   Dry-run dev :  node --import tsx scripts/fix-tscc-address-linebreaks.ts
 *   Apply dev   :  node --import tsx scripts/fix-tscc-address-linebreaks.ts .env.local apply
 *   Dry-run prod:  node --import tsx scripts/fix-tscc-address-linebreaks.ts .env.production
 *   Apply prod  :  node --import tsx scripts/fix-tscc-address-linebreaks.ts .env.production apply
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

const args = process.argv.slice(2);
const envFile = args.find((a) => a.endsWith('.env') || a.includes('.env')) ?? '.env.local';
const apply = args.includes('apply');

process.loadEnvFile?.(envFile);

const url =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_URL;
if (!url) {
  console.error('fix-tscc-address-linebreaks: DATABASE_URL is required.');
  process.exit(1);
}

const TENANT_SLUG = process.env.TENANT_SLUG ?? 'swecham';

/** Insert a newline before `token`, consuming any whitespace already present. */
function breakBefore(value: string, token: string): string {
  const re = new RegExp(`\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return re.test(value) ? value.replace(re, `\n${token}`) : value;
}

function show(label: string, before: string, after: string): void {
  const changed = before !== after;
  console.log(`\n--- ${label} ${changed ? '(CHANGED)' : '(no change / token not found)'} ---`);
  console.log('BEFORE:', JSON.stringify(before));
  console.log('AFTER :', JSON.stringify(after));
}

async function main(): Promise<void> {
  console.log(`env=${envFile}  tenant=${TENANT_SLUG}  mode=${apply ? 'APPLY (write)' : 'dry-run (read-only)'}`);
  const client = postgres(url!, { max: 1, ssl: 'require' });
  const db = drizzle(client);

  try {
    await db.execute(sql`SELECT set_config('app.current_tenant', ${TENANT_SLUG}, TRUE)`);

    const rows = await db.execute<{
      registered_address_th: string;
      registered_address_en: string;
    }>(sql`
      SELECT registered_address_th, registered_address_en
      FROM tenant_invoice_settings
      WHERE tenant_id = ${TENANT_SLUG}
    `);
    const row = rows[0];
    if (!row) {
      console.error(`✗ no tenant_invoice_settings row for ${TENANT_SLUG}`);
      process.exitCode = 1;
      return;
    }

    const newTh = breakBefore(row.registered_address_th, 'ถนนพญาไท');
    const newEn = breakBefore(row.registered_address_en, 'Thung Phayathai');
    show('registered_address_th', row.registered_address_th, newTh);
    show('registered_address_en', row.registered_address_en, newEn);

    const changed = newTh !== row.registered_address_th || newEn !== row.registered_address_en;
    if (!changed) {
      console.log('\n= nothing to change (already broken, or tokens absent on this env).');
      return;
    }
    if (!apply) {
      console.log('\n(dry-run) re-run with `apply` as the last arg to write.');
      return;
    }

    await db.execute(sql`
      UPDATE tenant_invoice_settings
      SET registered_address_th = ${newTh},
          registered_address_en = ${newEn}
      WHERE tenant_id = ${TENANT_SLUG}
    `);
    console.log('\n✓ applied.');
  } catch (error) {
    console.error('✗ fix-tscc-address-linebreaks failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('fix-tscc-address-linebreaks: crashed:', error);
  process.exit(1);
});
