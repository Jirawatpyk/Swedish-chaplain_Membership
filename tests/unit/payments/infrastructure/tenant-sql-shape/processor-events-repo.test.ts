/**
 * 130 (D-029) slice 7 — the processor_events repo binds `tenant_id` on every
 * statement that runs on a tenant tx (`markProcessed` and `updateOutcome`
 * via `tenantSlugOf(tx)`, D-030; `findProcessorEventInTenant` via its ctx). `insertIfNew`'s duplicate read and
 * `findById` run before the webhook knows its tenant (the row may carry a
 * NULL tenant), so they stay global by design — pinned below as the only
 * exemptions. `findByProcessorAccountId` in the payment-settings repo is the
 * same pre-resolution lookup.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RecordedStatement } from '../../../../helpers/tenant-sql-shape';

const rec = vi.hoisted(() => ({ statements: [] as RecordedStatement[], db: null as unknown }));
vi.mock('@/lib/db', async (importOriginal) => {
  const { recordingDb, SHAPE_TENANT } = await import('../../../../helpers/tenant-sql-shape');
  const r = recordingDb();
  rec.statements = r.statements;
  rec.db = r.db;
  const orig = await importOriginal<typeof import('@/lib/db')>();
  // The tx-only writes read their tenant from the tx (`tenantSlugOf`, D-030).
  orig.bindTenantTx(r.db, SHAPE_TENANT);
  return {
    ...orig,
    db: r.db,
    runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(r.db),
  };
});

const { SHAPE_TENANT: T, callEach, recordingDb, tenantPredicateViolations, tenantScopedTables, unfencedWheres } =
  await import('../../../../helpers/tenant-sql-shape');
const { makeDrizzleProcessorEventsRepo, findProcessorEventInTenant } = await import(
  '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo'
);

const TABLES = tenantScopedTables();
const EVENTS_SRC = 'src/modules/payments/infrastructure/repos/drizzle-processor-events-repo.ts';
const SETTINGS_SRC = 'src/modules/payments/infrastructure/repos/drizzle-tenant-payment-settings-repo.ts';

function violationsOf(statements: readonly RecordedStatement[]): string[] {
  // Positive control: each statement names a tenant table the parse sees.
  expect(statements.filter((s) => tenantPredicateViolations(s, TABLES).refs.length === 0).map((s) => s.sql.slice(0, 80))).toEqual([]);
  return statements.flatMap((s) =>
    tenantPredicateViolations(s, TABLES).violations.map((v) => `${v} :: ${s.sql.slice(0, 90)}`),
  );
}

describe('processor_events repo — tenant predicate on every tenant-tx statement (130 s7)', () => {
  it('markProcessed, updateOutcome and the in-tenant read', async () => {
    const { insertIfNew, findById, ...tenantScoped } = makeDrizzleProcessorEventsRepo();
    // The pre-resolution pair is the whole exempt set — a new method lands in `tenantScoped`.
    expect([insertIfNew, findById].every((f) => typeof f === 'function')).toBe(true);
    rec.statements.length = 0;
    await callEach(tenantScoped as never, {
      markProcessed: [rec.db, 'evt_1'],
      updateOutcome: [rec.db, { id: 'evt_1', outcome: 'processed' }],
    });
    await findProcessorEventInTenant(T, 'evt_1');
    expect(rec.statements.length).toBe(3);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('a tx runInTenant did not open is refused before any SQL (fails closed, D-030)', async () => {
    const unbound = recordingDb();
    const repo = makeDrizzleProcessorEventsRepo();
    await expect(repo.markProcessed(unbound.db, 'evt_1')).rejects.toThrow('tenantSlugOf');
    await expect(repo.updateOutcome(unbound.db, { id: 'evt_1', outcome: 'processed' })).rejects.toThrow('tenantSlugOf');
    expect(unbound.statements).toEqual([]);
  });

  it('the pre-resolution reads are the only unfenced .where( in either payments repo', () => {
    expect(unfencedWheres(readFileSync(EVENTS_SRC, 'utf8'))).toEqual([
      'eq(processorEvents.id, id)',
      'eq(processorEvents.id, input.id)',
    ]);
    expect(unfencedWheres(readFileSync(SETTINGS_SRC, 'utf8'))).toEqual([
      'eq(tenantPaymentSettings.processorAccountId, processorAccountId)',
    ]);
  });
});
