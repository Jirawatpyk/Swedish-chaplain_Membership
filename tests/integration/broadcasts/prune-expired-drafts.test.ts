/**
 * Phase 8 / T171a — integration test: prune-expired-drafts on live Neon.
 *
 * Verifies FR-001a: deletes `broadcasts WHERE status='draft' AND
 * updated_at < cutoff` for the bound tenant, leaves non-draft rows
 * intact, and is tenant-isolated (tenant A's prune does NOT touch
 * tenant B's drafts even when both have expired drafts).
 *
 * Live-DB constraints:
 *   - Inserts seed rows under `runInTenant(ctx, ...)` so RLS+FORCE
 *     stamps `tenant_id` correctly.
 *   - Cleanup helper deletes everything via the BYPASSRLS owner role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import {
  pruneExpiredDrafts,
  makePruneExpiredDraftsDeps,
} from '@/modules/broadcasts';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

interface DraftSeedSpec {
  readonly id: string;
  readonly status: 'draft' | 'submitted' | 'approved';
  readonly updatedAtOffsetDays: number; // negative = older than NOW
}

async function seedBroadcasts(
  tenant: TestTenant,
  specs: ReadonlyArray<DraftSeedSpec>,
): Promise<void> {
  for (const spec of specs) {
    const updatedAt = new Date(FROZEN_NOW.getTime() + spec.updatedAtOffsetDays * 24 * 60 * 60 * 1000);
    await runInTenant(tenant.ctx, (tx) =>
      tx.execute(sql`
        INSERT INTO broadcasts (
          tenant_id, broadcast_id, requested_by_member_id,
          requested_by_member_plan_id_snapshot, submitted_by_user_id,
          actor_role, subject, body_html, body_source, from_name,
          reply_to_email, segment_type, segment_params,
          custom_recipient_emails, estimated_recipient_count, status,
          retention_years, created_at, updated_at
        ) VALUES (
          ${tenant.ctx.slug},
          ${spec.id}::uuid,
          ${randomUUID()}::uuid,
          ${'plan-x'},
          ${randomUUID()}::uuid,
          ${'member_self_service'},
          ${'Test ' + spec.id.slice(0, 8)},
          ${'<p>Body</p>'},
          ${'plain'},
          ${'Test Member via Test Chamber'},
          ${'reply@example.com'},
          ${'all_members'},
          NULL,
          NULL,
          ${0},
          ${spec.status}::broadcast_status,
          ${5},
          ${updatedAt.toISOString()},
          ${updatedAt.toISOString()}
        )
      `),
    );
  }
}

async function countRows(
  tenant: TestTenant,
  status?: 'draft' | 'submitted' | 'approved',
): Promise<number> {
  return runInTenant(tenant.ctx, async (tx) => {
    const where = status
      ? and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.status, status))
      : eq(broadcasts.tenantId, tenant.ctx.slug);
    const rows = await tx
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(broadcasts)
      .where(where);
    return rows[0]?.n ?? 0;
  });
}

describe('Phase 8 / T171a — prune-expired-drafts integration (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const tenants = await createTwoTestTenants();
    tenantA = tenants.a;
    tenantB = tenants.b;
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  it('prunes draft rows older than 30 days, leaves non-draft + recent rows intact', async () => {
    // Seed: 2 drafts older than 30 days, 1 draft recent, 1 submitted (any age),
    // 1 approved (any age) — only the 2 old drafts should be pruned.
    const oldDraftA = '11111111-1111-1111-1111-111111111111';
    const oldDraftB = '22222222-2222-2222-2222-222222222222';
    const recentDraft = '33333333-3333-3333-3333-333333333333';
    const oldSubmitted = '44444444-4444-4444-4444-444444444444';
    const oldApproved = '55555555-5555-5555-5555-555555555555';

    await seedBroadcasts(tenantA, [
      { id: oldDraftA, status: 'draft', updatedAtOffsetDays: -45 },
      { id: oldDraftB, status: 'draft', updatedAtOffsetDays: -90 },
      { id: recentDraft, status: 'draft', updatedAtOffsetDays: -10 },
      { id: oldSubmitted, status: 'submitted', updatedAtOffsetDays: -100 },
      { id: oldApproved, status: 'approved', updatedAtOffsetDays: -100 },
    ]);

    expect(await countRows(tenantA)).toBe(5);

    const deps = makePruneExpiredDraftsDeps(tenantA.ctx.slug);
    const result = await pruneExpiredDrafts({
      ...deps,
      clock: { now: () => FROZEN_NOW },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prunedCount).toBe(2);
    }

    // After prune: 1 recent draft + 1 submitted + 1 approved = 3 rows
    expect(await countRows(tenantA)).toBe(3);
    expect(await countRows(tenantA, 'draft')).toBe(1);
    expect(await countRows(tenantA, 'submitted')).toBe(1);
    expect(await countRows(tenantA, 'approved')).toBe(1);
  });

  it('tenant isolation — pruning tenant A drafts does NOT touch tenant B drafts', async () => {
    // Seed each tenant with 1 old draft. Prune tenant A. Tenant B's draft
    // MUST survive (Constitution Principle I clause 1+2 — the SQL
    // WHERE tenant_id = $1 + assertTenantBoundTx defence-in-depth).
    const tenantAOldDraft = '66666666-6666-6666-6666-666666666666';
    const tenantBOldDraft = '77777777-7777-7777-7777-777777777777';

    await seedBroadcasts(tenantA, [
      { id: tenantAOldDraft, status: 'draft', updatedAtOffsetDays: -45 },
    ]);
    await seedBroadcasts(tenantB, [
      { id: tenantBOldDraft, status: 'draft', updatedAtOffsetDays: -45 },
    ]);

    // Snapshot tenant B count BEFORE the prune
    const tenantBCountBefore = await countRows(tenantB, 'draft');

    const deps = makePruneExpiredDraftsDeps(tenantA.ctx.slug);
    const result = await pruneExpiredDrafts({
      ...deps,
      clock: { now: () => FROZEN_NOW },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prunedCount).toBeGreaterThanOrEqual(1); // at least the 1 we seeded
    }

    // Tenant B's count UNCHANGED
    expect(await countRows(tenantB, 'draft')).toBe(tenantBCountBefore);
  });

  it('zero prune is the steady state — no rows touched, no error', async () => {
    // After prior tests left 1 recent draft + 1 submitted + 1 approved in
    // tenant A, plus tenant B's old draft (NOT pruned by tenant A's
    // earlier call). Re-running prune on tenant A with FROZEN_NOW + 5 min
    // (still under 30 days from the recent draft) should prune 0.
    const deps = makePruneExpiredDraftsDeps(tenantA.ctx.slug);
    const result = await pruneExpiredDrafts({
      ...deps,
      clock: { now: () => FROZEN_NOW },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.prunedCount).toBe(0);
    }
  });
});
