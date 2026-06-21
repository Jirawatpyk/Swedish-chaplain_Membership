/**
 * PR-2 Task 5 — integration test: `existingBroadcastIds` repo method (live Neon).
 *
 * Verifies:
 *   1. Returns exactly the subset of given ids that exist as broadcasts rows
 *      for the queried tenant — non-existent UUID is excluded; set size and
 *      membership are asserted precisely.
 *   2. Empty input → empty set WITHOUT error (short-circuit guard).
 *   3. Tenant isolation — tenant B's broadcast id is NOT returned when queried
 *      from tenant A, and vice versa. This is the Review-Gate isolation proof
 *      required by Constitution v1.4.0 Principle I.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

// ---------------------------------------------------------------------------
// Seed helper — same shape as audience-cleanup.test.ts for consistency
// ---------------------------------------------------------------------------

/** Seed a minimal broadcast row with the supplied status. */
async function seedBroadcast(
  tenant: TestTenant,
  opts: {
    broadcastId: string;
    status: string;
  },
): Promise<void> {
  const now = new Date();

  // The broadcasts_quota_year_only_on_sent CHECK requires quota_year_consumed +
  // quota_consumed_at to be NON-NULL iff status is 'sent' or
  // 'partial_delivery_accepted'. Provide them for those statuses only.
  const isQuotaConsumedStatus =
    opts.status === 'sent' || opts.status === 'partial_delivery_accepted';
  const quotaYear = isQuotaConsumedStatus ? new Date().getFullYear() : null;
  const quotaConsumedAt = isQuotaConsumedStatus ? now.toISOString() : null;

  await runInTenant(tenant.ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO broadcasts (
        tenant_id, broadcast_id, requested_by_member_id,
        requested_by_member_plan_id_snapshot, submitted_by_user_id,
        actor_role, subject, body_html, body_source, from_name,
        reply_to_email, segment_type, segment_params,
        custom_recipient_emails, estimated_recipient_count, status,
        retention_years, quota_year_consumed, quota_consumed_at,
        resend_audience_id, audience_deleted_at,
        created_at, updated_at
      ) VALUES (
        ${tenant.ctx.slug},
        ${opts.broadcastId}::uuid,
        ${randomUUID()}::uuid,
        ${'plan-test'},
        ${randomUUID()}::uuid,
        ${'member_self_service'},
        ${'Test subject'},
        ${'<p>Body</p>'},
        ${'plain'},
        ${'Test Sender via Test Chamber'},
        ${'reply@example.com'},
        ${'all_members'},
        NULL,
        NULL,
        ${0},
        ${opts.status}::broadcast_status,
        ${5},
        ${quotaYear},
        ${quotaConsumedAt ? sql`${quotaConsumedAt}::timestamptz` : sql`NULL`},
        NULL,
        NULL,
        ${now.toISOString()}::timestamptz,
        ${now.toISOString()}::timestamptz
      )
    `),
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PR-2 Task 5 — existingBroadcastIds repo method (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  // IDs seeded for tenant A
  const broadcastA1 = randomUUID(); // status: cancelled
  const broadcastA2 = randomUUID(); // status: approved
  // ID seeded for tenant B
  const broadcastB1 = randomUUID(); // status: cancelled

  beforeAll(async () => {
    const t = await createTwoTestTenants();
    tenantA = t.a;
    tenantB = t.b;

    // Tenant A: seed two broadcasts with simple non-quota statuses
    await seedBroadcast(tenantA, { broadcastId: broadcastA1, status: 'cancelled' });
    await seedBroadcast(tenantA, { broadcastId: broadcastA2, status: 'approved' });

    // Tenant B: seed one broadcast
    await seedBroadcast(tenantB, { broadcastId: broadcastB1, status: 'cancelled' });
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  // -------------------------------------------------------------------------
  // AS1: returns exactly the seeded ids; random non-existent UUID excluded
  // -------------------------------------------------------------------------

  it('returns exactly the seeded ids and excludes a non-existent UUID', async () => {
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const nonExistentId = randomUUID();

    const result = await repo.existingBroadcastIds(tenantA.ctx.slug, [
      broadcastA1,
      broadcastA2,
      nonExistentId,
    ]);

    // Set size must be exactly 2 (the two seeded ids)
    expect(result.size).toBe(2);
    // Both seeded ids must be present
    expect(result.has(broadcastA1)).toBe(true);
    expect(result.has(broadcastA2)).toBe(true);
    // The random non-existent id must NOT be present
    expect(result.has(nonExistentId)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AS2: empty input → empty set without error
  // -------------------------------------------------------------------------

  it('returns an empty set without throwing when given an empty array', async () => {
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);

    const result = await repo.existingBroadcastIds(tenantA.ctx.slug, []);

    expect(result.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AS3: tenant isolation — A cannot see B's broadcasts; B cannot see A's
  // -------------------------------------------------------------------------

  it('tenant A cannot see tenant B broadcasts (cross-tenant id returns empty)', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);

    const result = await repoA.existingBroadcastIds(tenantA.ctx.slug, [broadcastB1]);

    // The set must be empty — tenant A has no row for broadcastB1
    expect(result.size).toBe(0);
    expect(result.has(broadcastB1)).toBe(false);
  });

  it('tenant B cannot see tenant A broadcasts (cross-tenant ids return empty)', async () => {
    const repoB = makeDrizzleBroadcastsRepo(tenantB.ctx.slug);

    const result = await repoB.existingBroadcastIds(tenantB.ctx.slug, [
      broadcastA1,
      broadcastA2,
    ]);

    // The set must be empty — tenant B has no rows for tenant A's broadcasts
    expect(result.size).toBe(0);
    expect(result.has(broadcastA1)).toBe(false);
    expect(result.has(broadcastA2)).toBe(false);
  });

  it('mixed cross-tenant + own-tenant lookup: only own-tenant ids returned', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const nonExistentId = randomUUID();

    // Supply: one valid tenant-A id, one tenant-B id (invisible), one non-existent id
    const result = await repoA.existingBroadcastIds(tenantA.ctx.slug, [
      broadcastA1,
      broadcastB1,
      nonExistentId,
    ]);

    // Only broadcastA1 belongs to tenant A
    expect(result.size).toBe(1);
    expect(result.has(broadcastA1)).toBe(true);
    expect(result.has(broadcastB1)).toBe(false);
    expect(result.has(nonExistentId)).toBe(false);
  });
});
