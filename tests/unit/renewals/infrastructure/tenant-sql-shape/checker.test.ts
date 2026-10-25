/**
 * 130 (D-029) — the tenant-predicate checker itself: positive and negative
 * controls, so a parse that silently matches nothing cannot pass a repo.
 */
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { recordingDb, tenantPredicateViolations, tenantScopedTables } from '../../../../helpers/tenant-sql-shape';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';

const TABLES = tenantScopedTables();

describe('tenantPredicateViolations (130)', () => {
  it('finds the tenant-scoped tables from the schemas (positive control)', () => {
    expect(TABLES).toEqual(expect.arrayContaining(['renewal_cycles', 'members', 'contacts', 'invoices', 'membership_plans']));
    expect(TABLES.length).toBeGreaterThan(20);
  });

  it('passes builder statements that carry the predicate', async () => {
    const { db, statements } = recordingDb();
    await db.select().from(renewalCycles).where(and(eq(renewalCycles.tenantId, 't'), eq(renewalCycles.memberId, 'm')));
    await db.update(renewalCycles).set({ status: 'cancelled' }).where(eq(renewalCycles.tenantId, 't'));
    await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, 't'));
    for (const s of statements) {
      const r = tenantPredicateViolations(s.sql, TABLES);
      expect(r.refs).toEqual(['renewal_cycles']);
      expect(r.violations).toEqual([]);
    }
  });

  it('catches a builder statement without the predicate (negative control)', async () => {
    const { db, statements } = recordingDb();
    await db.select().from(renewalCycles).where(eq(renewalCycles.memberId, 'm'));
    await db.update(renewalCycles).set({ status: 'cancelled' }).where(eq(renewalCycles.cycleId, 'c'));
    for (const s of statements) {
      expect(tenantPredicateViolations(s.sql, TABLES).violations).toEqual([
        'renewal_cycles: 1 reference(s), 0 tenant predicate(s)',
      ]);
    }
  });

  it('handles hand-written SQL: aliases, a correlated join, CTEs ignored', async () => {
    const { db, statements } = recordingDb();
    await db.execute(sql`WITH due AS (SELECT 1) SELECT 1 FROM renewal_cycles rc
      JOIN members m ON m.member_id = rc.member_id AND m.tenant_id = rc.tenant_id
      JOIN due ON true WHERE rc.tenant_id = ${'t'}`);
    await db.execute(sql`SELECT 1 FROM renewal_cycles rc JOIN contacts c ON c.member_id = rc.member_id WHERE rc.tenant_id = ${'t'}`);
    const [good, bad] = statements.map((s) => tenantPredicateViolations(s.sql, TABLES));
    expect(good!.refs.sort()).toEqual(['m', 'rc']);
    expect(good!.violations).toEqual([]);
    expect(bad!.violations).toEqual(['c: 1 reference(s), 0 tenant predicate(s)']);
  });
});
