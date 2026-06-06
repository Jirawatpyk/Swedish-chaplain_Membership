/**
 * 055-member-number — member-number allocator atomicity (live Neon).
 *
 * Mirrors tests/integration/invoicing/seq-number-atomicity.test.ts
 * (advisory-lock serialisation). The member counter is a single
 * per-tenant stream (no document_type / fiscal_year sub-dimensions),
 * lifetime, never resets.
 *
 * Schema-file reconciliation: the canonical Drizzle table object
 * `tenantMemberSequences` lives in `schema-member-sequences.ts` (the
 * Migration/Schema group named the files per-table rather than the
 * plan's draft single `schema-member-number.ts`). The allocator impl
 * uses raw SQL against DB identifiers, so the file naming only affects
 * this test's row-assertion import.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asTenantId } from '@/modules/members';
import { drizzleMemberNumberAllocator } from '@/modules/members/infrastructure/repos/drizzle-member-number-allocator';
import { tenantMemberSequences } from '@/modules/members/infrastructure/db/schema-member-sequences';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('member-number allocator atomicity (live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  }, 60_000);

  afterAll(async () => {
    // The shared cleanup helper does not yet wipe member-number tables
    // (new this feature). Delete the test-tenant counter row explicitly
    // so reruns start clean. Owner role bypasses RLS.
    await db
      .delete(tenantMemberSequences)
      .where(eq(tenantMemberSequences.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  });

  it('first allocate seeds the counter row and returns 1', async () => {
    const ctx = asTenantContext(tenant.ctx.slug);
    const n = await runInTenant(ctx, (tx) =>
      drizzleMemberNumberAllocator.allocate(tx, asTenantId(tenant.ctx.slug)),
    );
    expect(n).toBe(1);

    const rows = await db
      .select()
      .from(tenantMemberSequences)
      .where(eq(tenantMemberSequences.tenantId, tenant.ctx.slug));
    expect(rows).toHaveLength(1);
    // last_number stores the LAST-issued value → equals what we returned.
    expect(rows[0]!.lastNumber).toBe(1);
  }, 30_000);

  it('sequential allocations produce consecutive numbers with no gaps', async () => {
    // Fresh tenant so the stream starts at 1 independent of the test above.
    const fresh = await createTestTenant('test-swecham');
    try {
      const ctx = asTenantContext(fresh.ctx.slug);
      const seqs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const s = await runInTenant(ctx, (tx) =>
          drizzleMemberNumberAllocator.allocate(tx, asTenantId(fresh.ctx.slug)),
        );
        seqs.push(s);
      }
      expect(seqs).toEqual([1, 2, 3]);
    } finally {
      await db
        .delete(tenantMemberSequences)
        .where(eq(tenantMemberSequences.tenantId, fresh.ctx.slug))
        .catch(() => {});
      await fresh.cleanup().catch(() => {});
    }
  }, 60_000);

  // ALLOC reviewer Minor (doc-only): the no-duplicate guarantee under
  // concurrency comes from the allocator's single-statement
  // `UPDATE … SET last_number = last_number + 1 … RETURNING last_number`,
  // which Postgres serialises per-row — the second writer blocks on the first
  // row lock and reads the post-increment value. The per-tenant advisory lock
  // (`pg_advisory_xact_lock(hashtextextended('members:'||tenantId, 0))`) is
  // defence-in-depth, NOT load-bearing for the assertions below.
  it('two concurrent allocations under one tenant yield distinct consecutive numbers (no duplicate)', async () => {
    const fresh = await createTestTenant('test-swecham');
    try {
      const ctx = asTenantContext(fresh.ctx.slug);
      const allocations = await Promise.all(
        Array.from({ length: 2 }, () =>
          runInTenant(ctx, (tx) =>
            drizzleMemberNumberAllocator.allocate(tx, asTenantId(fresh.ctx.slug)),
          ),
        ),
      );
      const sorted = [...allocations].sort((a, b) => a - b);
      expect(sorted).toEqual([1, 2]); // consecutive, no gap
      expect(new Set(allocations).size).toBe(2); // distinct, no duplicate
    } finally {
      await db
        .delete(tenantMemberSequences)
        .where(eq(tenantMemberSequences.tenantId, fresh.ctx.slug))
        .catch(() => {});
      await fresh.cleanup().catch(() => {});
    }
  }, 60_000);

  it('10 concurrent allocations produce contiguous 1..10 with no duplicates', async () => {
    const fresh = await createTestTenant('test-swecham');
    try {
      const ctx = asTenantContext(fresh.ctx.slug);
      const allocations = await Promise.all(
        Array.from({ length: 10 }, () =>
          runInTenant(ctx, (tx) =>
            drizzleMemberNumberAllocator.allocate(tx, asTenantId(fresh.ctx.slug)),
          ),
        ),
      );
      const sorted = [...allocations].sort((a, b) => a - b);
      expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(new Set(allocations).size).toBe(10);
    } finally {
      await db
        .delete(tenantMemberSequences)
        .where(eq(tenantMemberSequences.tenantId, fresh.ctx.slug))
        .catch(() => {});
      await fresh.cleanup().catch(() => {});
    }
  }, 60_000);
});
