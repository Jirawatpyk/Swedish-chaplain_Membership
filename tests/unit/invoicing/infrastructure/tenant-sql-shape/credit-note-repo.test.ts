/**
 * #66 (D-029) — the credit-note repo's idempotency lookups bind the tenant.
 * `findByIdempotencyKey` answers an admin issue repeat with the note already
 * issued; like `findBySourceRefundId` it runs on the caller's tx under the
 * invoice lock, so it must fence `credit_notes` (and the joined `invoices`)
 * on `tenant_id`, never rely on RLS alone.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], db: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb } = await import('../../../../helpers/tenant-sql-shape');
  const r = recordingDb();
  rec.statements = r.statements;
  rec.db = r.db;
  return {
    ...(await importOriginal<typeof import('@/lib/db')>()),
    db: r.db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(r.db),
  };
});

const { SHAPE_TENANT: T, tenantPredicateViolations, tenantScopedTables } = await import(
  '../../../../helpers/tenant-sql-shape'
);
const { makeDrizzleCreditNoteRepo } = await import(
  '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo'
);

const TABLES = tenantScopedTables();

describe('credit-note repo — the idempotency lookups bind the tenant (#66)', () => {
  it.each([
    ['findByIdempotencyKey', '11111111-2222-4333-8444-555555555555'],
    ['findBySourceRefundId', 'rfnd-1'],
  ] as const)('%s fences credit_notes and invoices on tenant_id', async (method, arg) => {
    rec.statements.length = 0;
    const repo = makeDrizzleCreditNoteRepo(T) as unknown as Record<
      string,
      (tx: unknown, tenantId: string, key: string) => Promise<unknown>
    >;
    await repo[method]!(rec.db, T, arg).catch(() => undefined);
    expect(rec.statements.length).toBe(1);
    const check = tenantPredicateViolations(rec.statements[0]!, TABLES);
    // Positive control: the parse sees both tables.
    expect([...check.tables].sort()).toEqual(['credit_notes', 'invoices']);
    expect(check.violations).toEqual([]);
  });
});
