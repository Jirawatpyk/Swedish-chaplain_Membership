/**
 * COMP-1 / GDPR Art.17 / PDPA §33 (integration) — `eraseMemberInsightsFootprint`
 * HARD-DELETES a member's `directory_listings` row against LIVE Neon, and does
 * so with STRICT tenant isolation (Constitution Principle I: the erase is a new
 * destructive tenant-scoped op, so a cross-tenant regression test is a
 * Review-gate blocker).
 *
 * The directory read paths only gate `erased_at IS NULL` (suppressing FUTURE
 * publication); without this cascade the member-authored PII
 * (description/website/industry/location) survives erasure forever. It also
 * expires the member's own `gdpr_member_archive` export jobs (I-7): the archive
 * download token is nulled so the pre-erasure data dump can't be downloaded
 * post-erasure (no wait for the ~1h TTL sweep). This proves both are removed AND
 * that erasing tenant A never touches tenant B — even when BOTH tenants hold a
 * listing + archive under the SAME member UUID (so ONLY the explicit tenant
 * predicate + RLS separate them; a regression that dropped the `tenant_id`
 * predicate would touch B's rows too and fail here). The public/private BLOB
 * `del` paths are covered by the unit test / the same idempotent adapter (seeds
 * carry NO blobKey so this stays hermetic to the DB).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { eraseMemberInsightsFootprint } from '@/modules/insights';
import { makeDrizzleDirectoryRepo } from '@/modules/insights/infrastructure/repos/drizzle-directory-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { directoryListings, exportJobs } from '@/modules/insights/infrastructure/db/schema-insights';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('eraseMemberInsightsFootprint — hard-deletes the directory listing, tenant-scoped (live Neon)', () => {
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

  // I-7: the member's own GDPR archive (delivered, with a live download token).
  // blobKey=null keeps the seed hermetic to the DB (no Vercel Blob `del`); the
  // blob-delete path is the same idempotent adapter proven by the unit test.
  async function seedGdprArchive(tenant: TestTenant) {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(exportJobs).values({
        tenantId: tenant.ctx.slug,
        kind: 'gdpr_member_archive',
        subjectMemberId: memberId,
        requestedBy: admin.userId,
        status: 'delivered',
        idempotencyKey: `gdpr-${randomUUID()}`,
        blobKey: null,
        downloadTokenHash: 'live-token-hash',
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    });
  }

  async function archiveState(
    ctx: TenantContext,
  ): Promise<{ status: string; token: string | null } | null> {
    return runInTenant(ctx, async (tx) => {
      const rows = await tx
        .select({ status: exportJobs.status, token: exportJobs.downloadTokenHash })
        .from(exportJobs)
        .where(
          and(eq(exportJobs.tenantId, ctx.slug), eq(exportJobs.subjectMemberId, memberId)),
        );
      return rows[0] ?? null;
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
    await seedGdprArchive(tenantA);
    await seedGdprArchive(tenantB);
  }, 240_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await db.delete(exportJobs).where(eq(exportJobs.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(directoryListings).where(eq(directoryListings.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, t.ctx.slug)).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('erases the target tenant\'s directory + GDPR-archive footprint (idempotent), leaving the other tenant untouched', async () => {
    expect(await listingCount(tenantA.ctx)).toBe(1); // seeded
    expect(await listingCount(tenantB.ctx)).toBe(1); // seeded
    expect((await archiveState(tenantA.ctx))?.status).toBe('delivered'); // seeded, downloadable

    await eraseMemberInsightsFootprint(tenantA.ctx, memberId);

    // Directory listing hard-deleted.
    expect(await listingCount(tenantA.ctx)).toBe(0);
    // I-7: the member's own GDPR archive is expired + its download token nulled.
    const a = await archiveState(tenantA.ctx);
    expect(a?.status).toBe('expired');
    expect(a?.token).toBeNull();

    // Cross-tenant isolation (directory AND export): tenant B's rows (SAME member
    // UUID) survive untouched.
    expect(await listingCount(tenantB.ctx)).toBe(1);
    const b = await archiveState(tenantB.ctx);
    expect(b?.status).toBe('delivered');
    expect(b?.token).toBe('live-token-hash');

    // Re-drive safety: a second call must not throw and must not touch tenant B.
    await eraseMemberInsightsFootprint(tenantA.ctx, memberId);
    expect(await listingCount(tenantA.ctx)).toBe(0);
    expect((await archiveState(tenantA.ctx))?.status).toBe('expired');
    expect(await listingCount(tenantB.ctx)).toBe(1);
    expect((await archiveState(tenantB.ctx))?.status).toBe('delivered');
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
