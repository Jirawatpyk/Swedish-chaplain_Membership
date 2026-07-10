/**
 * COMP-1 / GDPR Art.17 / PDPA §33 (integration) — `eraseMemberDirectoryFootprint`
 * HARD-DELETES a member's `directory_listings` row against LIVE Neon.
 *
 * The directory read paths only gate `erased_at IS NULL` (suppressing FUTURE
 * publication); without this cascade the member-authored PII
 * (description/website/industry/location) survives erasure forever. This proves
 * the row is actually removed. The public logo BLOB path is covered by the unit
 * test (this seeds NO logo, so the Vercel Blob `del` is not exercised — the test
 * stays hermetic to the DB).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { eraseMemberDirectoryFootprint } from '@/modules/insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { directoryListings } from '@/modules/insights/infrastructure/db/schema-insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('eraseMemberDirectoryFootprint — hard-deletes the directory listing (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-dir-erase-${randomUUID().slice(0, 8)}`;
  const memberId = randomUUID();

  async function listingCount(): Promise<number> {
    return runInTenant(tenant.ctx, async (tx) => {
      const rows = await tx
        .select({ memberId: directoryListings.memberId })
        .from(directoryListings)
        .where(
          and(
            eq(directoryListings.tenantId, tenant.ctx.slug),
            eq(directoryListings.memberId, memberId),
          ),
        );
      return rows.length;
    });
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
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
        companyName: 'Dir Co',
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
        description: 'We make things. Contact jane@dir-co.example.',
        website: 'https://dir-co.example',
        logoBlobKey: null,
        locationCity: 'Bangkok',
        locationCountry: 'TH',
      });
    });
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db.delete(directoryListings).where(eq(directoryListings.tenantId, slug)).catch(() => {});
    await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('removes the directory_listings row (idempotent — a second call is a no-op)', async () => {
    expect(await listingCount()).toBe(1); // seeded

    await eraseMemberDirectoryFootprint(tenant.ctx, memberId);
    expect(await listingCount()).toBe(0); // erased

    // Re-drive safety: a second call on the already-erased member must not throw.
    await eraseMemberDirectoryFootprint(tenant.ctx, memberId);
    expect(await listingCount()).toBe(0);
  });
});
