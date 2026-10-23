/**
 * The §78/1 tax point of a paid invoice: the admin-entered Bangkok-local
 * `payment_date`, falling back to the server `paid_at` (as a Bangkok-local
 * date) only when a row has none.
 *
 * ONE definition, shared by every reader that buckets receipts by date:
 *   - the tax-document register and its CSV export (`drizzle-invoice-repo.ts`),
 *     so the ภ.พ.30 register and the bookkeeper's CSV never disagree about
 *     which month a receipt belongs to;
 *   - the invoice dashboard's Collected figures (spec 124, via the barrel);
 *   - migration 0318's expression index `invoices_tenant_tax_point_paid_idx`.
 *     Postgres uses an expression index only when the query's expression
 *     matches the indexed one, so the migration carries this exact text and
 *     `tests/unit/invoicing/invoice-tax-point-migration-guard.test.ts` fails
 *     the moment the two drift.
 *
 * A row with neither date has no tax point (NULL) and never matches a range.
 */
import { sql } from 'drizzle-orm';
import { invoices } from './schema-invoices';

export const invoiceTaxPointSql = sql`COALESCE(${invoices.paymentDate}, (${invoices.paidAt} AT TIME ZONE 'Asia/Bangkok')::date)`;
