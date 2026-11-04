/**
 * #729 (D-029) — the orphan PDF sweep's lock-free batch read binds the tenant.
 * `referencedKeys` decides which listed keys are KEPT without a row lock, so
 * it must fence `invoices` and `credit_notes` on `tenant_id`, never rely on
 * RLS alone; and it reads `credit_notes` directly (no join that could drop a
 * row and read as "no reference" — reliability M2, financial L-1).
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], db: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb } = await import('../../../../helpers/tenant-sql-shape');
  const r = recordingDb();
  rec.statements = r.statements;
  rec.db = r.db;
  return { ...(await importOriginal<typeof import('@/lib/db')>()), db: r.db };
});

const { SHAPE_TENANT: T, tenantPredicateViolations, tenantScopedTables } = await import(
  '../../../../helpers/tenant-sql-shape'
);
const { makeDrizzleOrphanPdfReferenceRepo } = await import(
  '@/modules/invoicing/infrastructure/repos/drizzle-orphan-pdf-reference-repo'
);

const TABLES = tenantScopedTables();
const INV = '11111111-1111-4111-8111-111111111111';
const CN = '33333333-3333-4333-8333-333333333333';

describe('orphan PDF reference repo — the batch read binds the tenant (#729)', () => {
  it('reads invoices and credit_notes, each fenced on tenant_id, with no join', async () => {
    rec.statements.length = 0;
    const repo = makeDrizzleOrphanPdfReferenceRepo(rec.db as never);
    await repo.referencedKeys(T, { invoiceIds: [INV], creditNoteIds: [CN] }).catch(() => undefined);
    expect(rec.statements.length).toBe(2);
    const seen = rec.statements.map((s) => {
      const check = tenantPredicateViolations(s, TABLES);
      expect(check.violations).toEqual([]);
      expect(s.params).toContain(T);
      return [...check.tables];
    });
    // Positive control: the parse sees one table per statement.
    expect(seen).toEqual([['invoices'], ['credit_notes']]);
  });

  it('an empty id list runs no query for that table', async () => {
    rec.statements.length = 0;
    const repo = makeDrizzleOrphanPdfReferenceRepo(rec.db as never);
    const keys = await repo.referencedKeys(T, { invoiceIds: [], creditNoteIds: [] });
    expect(rec.statements.length).toBe(0);
    expect([...keys]).toEqual([]);
  });
});
