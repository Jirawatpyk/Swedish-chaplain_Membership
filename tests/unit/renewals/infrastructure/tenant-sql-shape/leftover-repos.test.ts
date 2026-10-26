/**
 * 130 (D-029) slice 7 — the renewals leftovers: the tier-upgrade suggestion
 * repo, the plan lookup for renewal, and the per-member at-risk scorer carry a
 * `tenant_id` predicate on each tenant-scoped table they name. The source
 * scans cover statements that only run once an earlier read returns rows (the
 * recording db answers none). `lookup-member-by-email` is cross-tenant by
 * design (webhook ingest before a tenant is known) — its two reads are pinned
 * as the only exemptions in that file.
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

const {
  ANY,
  SHAPE_TENANT: T,
  anyWith,
  callEach,
  isPureInsert,
  tenantPredicateViolations,
  tenantScopedTables,
  unfencedRawSql,
  unfencedWheres,
} = await import('../../../../helpers/tenant-sql-shape');
const { makeDrizzleTierUpgradeSuggestionRepo } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo'
);
const { makeDrizzlePlanLookupForRenewal } = await import(
  '@/modules/renewals/infrastructure/ports-adapters/plan-lookup-for-renewal-drizzle'
);
const { makeDrizzleAtRiskScorer } = await import(
  '@/modules/renewals/infrastructure/drizzle/drizzle-at-risk-scorer'
);

const TABLES = tenantScopedTables();
const CTX = { slug: T } as never;
const TIER_SRC = 'src/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo.ts';
const PLAN_SRC = 'src/modules/renewals/infrastructure/ports-adapters/plan-lookup-for-renewal-drizzle.ts';
const SCORER_SRC = 'src/modules/renewals/infrastructure/drizzle/drizzle-at-risk-scorer.ts';
const LOOKUP_SRC = 'src/modules/renewals/infrastructure/lookup-member-by-email.ts';

function violationsOf(statements: readonly RecordedStatement[]): string[] {
  const checked = statements.filter((s) => !isPureInsert(s.sql));
  // Positive control: every read/update names a tenant table the parse sees.
  // An `insert … on conflict … where` writes its tenant in VALUES and names none.
  const reads = checked.filter((s) => !s.sql.trimStart().toLowerCase().startsWith('insert'));
  expect(reads.filter((s) => tenantPredicateViolations(s, TABLES).refs.length === 0).map((s) => s.sql.slice(0, 80))).toEqual([]);
  return checked.flatMap((s) =>
    tenantPredicateViolations(s, TABLES).violations.map((v) => `${v} :: ${s.sql.slice(0, 90)}`),
  );
}

describe('renewals leftovers — tenant predicate on every statement (130 s7)', () => {
  it('tier-upgrade suggestions', async () => {
    const tx = rec.db;
    rec.statements.length = 0;
    await callEach(makeDrizzleTierUpgradeSuggestionRepo(CTX) as never, {
      insertOpen: [tx, ANY],
      findById: [T, 'suggestion-1'],
      findActiveForMember: [T, 'member-1'],
      isSuppressedForMember: [T, 'member-1', '2026-01-01T00:00:00.000Z'],
      findPendingForCycle: [T, 'cycle-1'],
      transitionStatus: [tx, T, 'suggestion-1', anyWith({ to: 'dismissed', expectedFrom: 'open', expectedFromIn: undefined })],
      listOrphanedPending: [T],
      listForAdminQueue: [T, { limit: 10 }],
      bulkGetSuppressedMembers: [tx, ['member-1'], '2026-01-01T00:00:00.000Z'],
      bulkInsertOpenIfAbsent: [tx, [ANY]],
    });
    expect(rec.statements.length).toBeGreaterThanOrEqual(10);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('plan lookup for renewal — freeze and offer paths', async () => {
    const tx = rec.db;
    rec.statements.length = 0;
    const freeze = anyWith({ planId: 'plan-1', fiscalYear: 2026, mode: 'freeze' });
    const offer = anyWith({ planId: 'plan-1', fiscalYear: 2026, mode: 'offer' });
    await callEach(makeDrizzlePlanLookupForRenewal(CTX) as never, {
      loadPlanFrozenFields: [freeze],
      loadPlanFrozenFieldsInTx: [tx, offer],
    });
    // freeze: exact-year, most-recent active, inactive probe; offer: exact-year, offer probe.
    expect(rec.statements.length).toBe(5);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('per-member at-risk scorer', async () => {
    rec.statements.length = 0;
    const scorer = makeDrizzleAtRiskScorer({
      tenant: CTX,
      eventAttendees: { isAvailable: () => false, listAttendances: async () => [] } as never,
      tenantRenewalSettingsRepo: { findByTenant: async () => null } as never,
    });
    await callEach(scorer as never, {
      scoreMember: [T, 'member-1'],
      scoreMembers: [T, []],
    });
    expect(rec.statements.length).toBeGreaterThanOrEqual(3);
    expect(violationsOf(rec.statements)).toEqual([]);
  });

  it('every hand-written sql block on a tenant table names tenant_id (row-dependent statements included)', () => {
    expect(unfencedRawSql(readFileSync(TIER_SRC, 'utf8'), TABLES)).toEqual([]);
    expect(unfencedRawSql(readFileSync(PLAN_SRC, 'utf8'), TABLES)).toEqual([]);
    expect(unfencedRawSql(readFileSync(SCORER_SRC, 'utf8'), TABLES)).toEqual([]);
  });

  it('every .where( names tenant_id (row-dependent statements included)', () => {
    expect(unfencedWheres(readFileSync(TIER_SRC, 'utf8'))).toEqual([]);
    expect(unfencedWheres(readFileSync(PLAN_SRC, 'utf8'))).toEqual([]);
    expect(unfencedWheres(readFileSync(SCORER_SRC, 'utf8'))).toEqual([]);
  });

  it('lookup-member-by-email: its two cross-tenant reads are the only unfenced statements', () => {
    expect(unfencedWheres(readFileSync(LOOKUP_SRC, 'utf8'))).toEqual([
      'and( eq(contacts.contactId, contactId), sql`${contacts.removedAt} IS NULL`, ),',
      'and( sql`LOWER(${contacts.email}) = LOWER(${email})`, sql`${contacts.removedAt} IS NULL`, ),',
    ]);
  });
});
