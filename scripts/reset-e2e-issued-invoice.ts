/**
 * Dev-only: reset the E2E `ISSUED` test invoice (SC-2026-900003) back to
 * `status='issued'` after an E2E run flipped it to `paid`. The
 * payment-card-happy-path spec assumes a fresh issued invoice on every
 * run; without this reset, re-running the suite times out at
 * `getByTestId('pay-now-button')` because the page correctly hides Pay
 * for already-paid invoices.
 */
import { db } from '@/lib/db';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { eq } from 'drizzle-orm';

const ISSUED_INVOICE_ID = 'b070ff99-e7f1-48c4-a87c-f04cada85036';

async function main() {
  const result = await db
    .update(invoices)
    .set({
      status: 'issued',
      paidAt: null,
      paymentMethod: null,
    })
    .where(eq(invoices.invoiceId, ISSUED_INVOICE_ID))
    .returning({
      id: invoices.invoiceId,
      docNumber: invoices.documentNumber,
      status: invoices.status,
    });
  console.log('reset:', result);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
