/**
 * Dev-only: reset the E2E `ISSUED` test invoice (SC-2026-900003) back to
 * `status='issued'` after an E2E run flipped it to `paid`. The
 * payment-card-happy-path spec assumes a fresh issued invoice on every
 * run; without this reset, re-running the suite times out at
 * `getByTestId('pay-now-button')` because the page correctly hides Pay
 * for already-paid invoices.
 *
 * Looked up by DOCUMENT NUMBER, not by a hardcoded invoice id. The id was
 * pinned here and in `.env.local`'s `E2E_ISSUED_INVOICE_ID`; re-seeding the
 * dev branch kept the document number and minted a new id, so both went
 * stale. The script then updated zero rows and said nothing, and every
 * `pay*`/`payment*` spec timed out waiting for a drawer that could not open
 * because `/portal/invoices/<dead id>` redirects to the invoice list — 42
 * failures in the 2026-09-26 full-suite run, all from this one dangling id.
 * The document number is stable across re-seeds, so this cannot rot the same
 * way, and a miss now fails loudly.
 */
import { db } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { and, eq } from 'drizzle-orm';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? 'swecham';
const ISSUED_DOCUMENT_NUMBER = 'SC-2026-900003';

async function main() {
  const result = await db
    .update(invoices)
    .set({
      status: 'issued',
      paidAt: null,
      paymentMethod: null,
    })
    .where(
      and(
        eq(invoices.tenantId, TENANT_ID),
        eq(invoices.documentNumber, ISSUED_DOCUMENT_NUMBER),
      ),
    )
    .returning({
      id: invoices.invoiceId,
      docNumber: invoices.documentNumber,
      status: invoices.status,
    });

  if (result.length === 0) {
    throw new Error(
      `[reset-e2e-issued-invoice] no invoice ${ISSUED_DOCUMENT_NUMBER} in tenant ` +
        `${TENANT_ID} — re-seed the dev branch, then point E2E_ISSUED_INVOICE_ID ` +
        `in .env.local at the new row's id.`,
    );
  }

  console.log('reset:', result);
  console.log(
    `[reset-e2e-issued-invoice] E2E_ISSUED_INVOICE_ID must be ${result[0]!.id}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
