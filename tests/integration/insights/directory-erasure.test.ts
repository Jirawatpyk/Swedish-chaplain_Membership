/**
 * COMP-1 / GDPR Art.17 / PDPA §33 (integration) — `eraseMemberDirectoryFootprint`
 * HARD-DELETES a member's `directory_listings` row against LIVE Neon, and does
 * so with STRICT tenant isolation (Constitution Principle I: the erase is a new
 * destructive tenant-scoped op, so a cross-tenant regression test is a
 * Review-gate blocker).
 *
 * The directory read paths only gate `erased_at IS NULL` (suppressing FUTURE
 * publication); without this cascade the member-authored PII
 * (description/website/industry/location) survives erasure forever. This proves
 * the row is actually removed AND that erasing tenant A never touches tenant B —
 * even when BOTH tenants hold a listing under the SAME member UUID (so ONLY the
 * explicit tenant predicate + RLS separate them; a regression that dropped the
 * `tenant_id` predicate would delete B's row too and fail here). The public logo
 * BLOB path is covered by the unit test (this seeds NO logo, so the Vercel Blob
 * `del` is not exercised — the test stays hermetic to the DB).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { eraseMemberDirectoryFootprint } from '@/modules/insights';
import { makeDrizzleDirectoryRepo } from '@/modules/insights/infrastructure/repos/drizzle-directory-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { directoryListings } from '@/modules/insights/infrastructure/db/schema-insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('eraseMemberDirectoryFootprint — hard-deletes the directory listing, tenant-scoped (live Neon)', () => {
  let admin: TestUser;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  // SAME member UUID in BOTH tenants — the strongest isolation probe: only the
  // tenant predicate/RLS distinguishes the two directory_listings rows.
  const memberId = randomUUID();

  async function listingCount(ctx: TenantContext): Promise<number> {
    return runInTenant(ctx, async (tx) => {
      const rows = await tx
        .select({ memberId: directoryListings.memberId })
        .from(directoryListings)
        .where(
          and(
            eq(directoryListings.tenantId, ctx.slug),
            eq(directoryListings.memberId, memberId),
          ),
        );
      return rows.length;
    });
  }

  async function seedListing(tenant: TestTenant, planId: string, city: string) {
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Dir Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Dir Co ${city}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active' as const,
        riskScore: null,
        riskScoreBand: null,
      });
      // Directory listing carrying member-authored PII (NO logo → no blob call).
      await tx.insert(directoryListings).values({
        tenantId: tenant.ctx.slug,
        memberId,
        listed: true,
        fieldVisibility: {},
        industry: 'Manufacturing',
        description: `We make things in ${city}.`,
        website: 'https://dir-co.example',
        logoBlobKey: null,
        locationCity: city,
        locationCountry: 'TH',
      });
    });
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-swecham');
    await seedListing(tenantA, `f9-dir-a-${randomUUID().slice(0, 8)}`, 'Bangkok');
    await seedListing(tenantB, `f9-dir-b-${randomUUID().slice(0, 8)}`, 'Chiang Mai');
  }, 240_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await db.delete(directoryListings).where(eq(directoryListings.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, t.ctx.slug)).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('removes the target tenant\'s row (idempotent) and LEAVES the other tenant\'s row untouched', async () => {
    expect(await listingCount(tenantA.ctx)).toBe(1); // seeded
    expect(await listingCount(tenantB.ctx)).toBe(1); // seeded

    await eraseMemberDirectoryFootprint(tenantA.ctx, memberId);

    expect(await listingCount(tenantA.ctx)).toBe(0); // erased
    // Cross-tenant isolation: tenant B's row (SAME member UUID) survives.
    expect(await listingCount(tenantB.ctx)).toBe(1);

    // Re-drive safety: a second call on the already-erased member must not throw
    // and must still not touch tenant B.
    await eraseMemberDirectoryFootprint(tenantA.ctx, memberId);
    expect(await listingCount(tenantA.ctx)).toBe(0);
    expect(await listingCount(tenantB.ctx)).toBe(1);
  });

  it('refuses a directory write for a GDPR-erased member (COMP-1 I-8 race guard)', async () => {
    // Stamp erased_at on tenant B's member, then attempt a logo write — the
    // repo's `erased_at IS NULL` existence guard must refuse it (memberNotFound),
    // so a post-erasure upload can't resurrect a listing / orphan a public blob.
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.execute(
        sql`UPDATE members SET erased_at = now() WHERE tenant_id = ${tenantB.ctx.slug} AND member_id = ${memberId}::uuid`,
      );
    });
    const repo = makeDrizzleDirectoryRepo(tenantB.ctx.slug);
    const result = await runInTenant(tenantB.ctx, (tx) =>
      repo.setLogoInTx(tx, memberId, 'https://blob.example/new-logo.png'),
    );
    expect(result.memberNotFound).toBe(true);
  });
});
