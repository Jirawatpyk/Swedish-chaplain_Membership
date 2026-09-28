/**
 * Dev-only: reset the E2E `ISSUED` test invoice (SC-2026-900003) to a fresh,
 * unpaid bill after an E2E run paid it. The payment-card-happy-path spec
 * assumes a fresh issued invoice on every run; without this reset, re-running
 * the suite times out at `getByTestId('pay-now-button')` because the page
 * correctly hides Pay for already-paid invoices.
 *
 * Looked up by NUMBER, not by a hardcoded invoice id: re-seeding once minted a
 * new id and left `E2E_ISSUED_INVOICE_ID` stale (42 failures in the 2026-09-26
 * full-suite run). The fixture is an 088 bill, so the SC number rides
 * `bill_document_number_raw`; a legacy-shaped row still carries it in
 * `document_number`. A miss fails loudly.
 *
 * Paying the 088 bill mints an RC receipt number that migration 0235 freezes,
 * so the row is re-created rather than updated in place — the same reset
 * `tests/e2e/global-setup.ts` runs (scripts/lib/e2e-issued-fixture-reset.ts).
 */
import postgres from 'postgres';
import { resetE2eIssuedFixture } from './lib/e2e-issued-fixture-reset';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const ISSUED_NUMBER = 'SC-2026-900003';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('[reset-e2e-issued-invoice] DATABASE_URL is not set');
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    const [row] = await sql<{ invoice_id: string }[]>`
      SELECT invoice_id::text AS invoice_id FROM invoices
       WHERE tenant_id = ${TENANT_ID}
         AND (bill_document_number_raw = ${ISSUED_NUMBER} OR document_number = ${ISSUED_NUMBER})
       LIMIT 1`;
    if (!row || !(await resetE2eIssuedFixture(sql, row.invoice_id))) {
      throw new Error(
        `[reset-e2e-issued-invoice] no invoice ${ISSUED_NUMBER} in tenant ` +
          `${TENANT_ID} — re-run scripts/seed-e2e-portal-invoices.ts, then point ` +
          `E2E_ISSUED_INVOICE_ID in .env.local at the pinned id.`,
      );
    }
    console.log(`[reset-e2e-issued-invoice] reset ${ISSUED_NUMBER} (${row.invoice_id}) to an unpaid bill`);
    console.log(`[reset-e2e-issued-invoice] E2E_ISSUED_INVOICE_ID must be ${row.invoice_id}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
