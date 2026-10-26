/**
 * 130 (D-029) slice 7 — the buyer-PII redaction step's tombstone UPDATEs bind
 * `tenant_id`, and the invoice repo's composed filter lists stay fenced. The
 * invoice repo needed no change: every `and(...filters)` starts with
 * `eq(invoices.tenantId, …)`, and the hand-written COUNT embeds that same
 * list — so it is pinned here as the only raw block without a literal
 * `tenant_id`.
 */
import { readFileSync } from 'node:fs';
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

const { SHAPE_TENANT: T, tenantPredicateViolations, tenantScopedTables, unfencedRawSql, unfencedWheres } =
  await import('../../../../helpers/tenant-sql-shape');
const { tombstoneBuyerPiiAndAuditInTx } = await import(
  '@/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step'
);

const TABLES = tenantScopedTables();
const REDACT_SRC = 'src/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step.ts';
const INVOICE_SRC = 'src/modules/invoicing/infrastructure/repos/drizzle-invoice-repo.ts';

describe('invoicing — tenant predicate on the redaction UPDATEs and the invoice repo filters (130 s7)', () => {
  it('the tombstone UPDATE binds the tenant for both document tables', async () => {
    rec.statements.length = 0;
    for (const documentTable of ['invoices', 'credit_notes'] as const) {
      await tombstoneBuyerPiiAndAuditInTx({
        tx: rec.db as never,
        documentTable,
        documentId: 'doc-1',
        blobKeys: [],
        alreadyTombstoned: false,
        audit: { emit: async () => undefined } as never,
        auditPayloadExtra: { document_kind: documentTable === 'invoices' ? 'invoice' : 'credit_note' },
        tenantId: T,
        requestId: null,
        route: 'test',
      });
    }
    expect(rec.statements.length).toBe(2);
    // Positive control: both UPDATEs name a tenant table the parse sees.
    expect(rec.statements.map((s) => [...tenantPredicateViolations(s, TABLES).tables])).toEqual([
      ['invoices'],
      ['credit_notes'],
    ]);
    expect(rec.statements.flatMap((s) => tenantPredicateViolations(s, TABLES).violations)).toEqual([]);
  });

  it('every hand-written sql block in the redaction step names tenant_id (row-dependent marker UPDATEs included)', () => {
    expect(unfencedRawSql(readFileSync(REDACT_SRC, 'utf8'), TABLES)).toEqual([]);
  });

  it('the invoice repo: only the composed filter lists and the COUNT that embeds them lack a literal tenant_id', () => {
    const src = readFileSync(INVOICE_SRC, 'utf8');
    expect(unfencedWheres(src)).toEqual(['and(...filters)', 'and(...filters)', 'and(...filters)']);
    expect(unfencedRawSql(src, TABLES)).toEqual(['SELECT COUNT(*)::int AS c FROM invoices WHERE ${and(...filters)!}']);
    // Each composed list starts with the tenant predicate.
    expect(src.match(/const filters = \[\s*eq\(invoices\.tenantId, tenantIdArg\)/g)?.length).toBe(3);
  });
});
