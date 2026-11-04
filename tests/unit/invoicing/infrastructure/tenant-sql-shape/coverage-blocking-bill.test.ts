/**
 * #730 (D-029) — the read that names the bill blocking a coverage overlap
 * binds the tenant on every `invoices` reference: the draft it starts from and
 * the committed bill it returns.
 */
import { describe, expect, it } from 'vitest';
import {
  SHAPE_TENANT as T,
  recordingDb,
  tenantPredicateViolations,
  tenantScopedTables,
} from '../../../../helpers/tenant-sql-shape';
import { makeDrizzleInvoiceRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-invoice-repo';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';

const rec = recordingDb();
const TABLES = tenantScopedTables();
const INV = '11111111-1111-4111-8111-111111111111';

describe('invoice repo — findCoverageBlockingBillInTx binds the tenant (#730)', () => {
  it('one statement, both invoices references fenced on tenant_id', async () => {
    rec.statements.length = 0;
    const repo = makeDrizzleInvoiceRepo(T);
    await repo.findCoverageBlockingBillInTx?.(rec.db, { tenantId: T, invoiceId: asInvoiceId(INV) });
    expect(rec.statements.length).toBe(1);
    const check = tenantPredicateViolations(rec.statements[0]!, TABLES);
    // Positive control: the parse sees the table.
    expect([...check.tables]).toEqual(['invoices']);
    expect(check.refs.length).toBe(2);
    expect(check.violations).toEqual([]);
  });
});
