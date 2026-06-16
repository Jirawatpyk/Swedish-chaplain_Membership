/**
 * COMP-1 (Member Erasure) — H4 regression net for the F9 insights directory.
 *
 * `eraseMember` keeps `status` and stamps only `erased_at`. The F9 directory
 * management view (`DirectoryRepo.search`) and the public-directory / E-Book /
 * JSON export source (`DirectoryRepo.listPublishedInTx`) both filtered
 * `status <> 'archived'` but NOT `erased_at IS NULL`, so an anonymised
 * '[erased]' tombstone still surfaced in the admin directory and — if it had a
 * `listed = true` row — in the PUBLIC export. This proves both are excluded.
 *
 * Seeds an erased row directly (member with `erased_at` set + a listed
 * directory_listings row) — the F9 repo only reads `members`/`directory_listings`,
 * so the full eraseMember cascade is unnecessary to exercise these two reads.
 *
 * Live Neon. Mirrors `directory.test.ts` seed scaffolding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import {
  searchDirectory,
  makeSearchDirectoryDeps,
  updateDirectoryListing,
  makeUpdateDirectoryListingDeps,
} from '@/modules/insights';
import { directoryListings } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('F9 directory excludes GDPR-erased members (COMP-1 H4)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `f9-erased-${randomUUID().slice(0, 8)}`;
  const kept = randomUUID(); // active, listed — must appear
  const erased = randomUUID(); // erased_at set, listed — must NOT appear

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Corporate Gold' },
        planCategory: 'corporate',
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      const seedMember = (
        memberId: string,
        companyName: string,
        erasedAt: Date | null,
      ) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active', // erasure keeps status active — the whole point
          erasedAt,
        });
      await seedMember(kept, 'Kept Active Co', null);
      await seedMember(erased, '[erased]', new Date());

      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: kept,
        firstName: 'Somchai',
        lastName: 'Lastname',
        email: 'somchai@kept.example',
        isPrimary: true,
      });
    });

    // Both members opt INTO the public directory (listed = true).
    for (const memberId of [kept, erased]) {
      const r = await updateDirectoryListing(
        {
          memberId,
          listed: true,
          fieldVisibility: { name: true },
          industry: 'Manufacturing',
          description: null,
          website: null,
          locationCity: null,
          locationCountry: null,
        },
        {
          actorUserId: admin.userId,
          actorRole: 'admin' as const,
          actorMemberId: null,
          requestId: `dir-${randomUUID()}`,
        },
        tenant.ctx,
        makeUpdateDirectoryListingDeps(tenant.ctx.slug),
      );
      expect(r.ok).toBe(true);
    }
  }, 180_000);

  afterAll(async () => {
    const slug = tenant.ctx.slug;
    await db
      .delete(directoryListings)
      .where(eq(directoryListings.tenantId, slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  const adminMeta = () => ({
    actorUserId: admin.userId,
    actorRole: 'admin' as const,
    actorMemberId: null,
    requestId: 'erased-search',
  });

  it('search (admin directory view) excludes the erased member', async () => {
    const result = await searchDirectory(
      {},
      adminMeta(),
      tenant.ctx,
      makeSearchDirectoryDeps(tenant.ctx.slug),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.items.map((i) => i.memberId);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(erased);
  });

  it('listPublishedInTx (public/E-Book/JSON export) excludes the erased member', async () => {
    const repo = makeSearchDirectoryDeps(tenant.ctx.slug).directoryRepo;
    const published = await runInTenant(tenant.ctx, (tx) =>
      repo.listPublishedInTx(tx),
    );
    const ids = published.map((p) => p.memberId);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(erased);
  });
});
