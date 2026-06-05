/**
 * T102 (F9 / Principle I Review-Gate BLOCKER) — directory + export cross-tenant
 * isolation. Closes the US5 half of T019 (which covered the 3 FK-free F9 tables).
 *
 * Proves, against live Neon, that tenant B can never see or mutate tenant A's
 * `directory_listings` (member-FK chain) at the DB layer (RLS+FORCE, migration
 * 0187) AND that the F9 use-cases self-scope: `searchDirectory` /
 * `listPublishedInTx` never surface another tenant's members, and an export job
 * created in tenant A resolves to `not_found` under tenant B (RLS-scoped
 * `findById`). Together with T019 + the per-feature integration suites this is
 * the "all surfaces GREEN" closure across dashboard/audit/timeline/directory/export.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { directoryListings, exportJobs } from '@/modules/insights/infrastructure/db/schema-insights';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  exportDirectoryJson,
  prepareExportDownload,
  searchDirectory,
  makeGenerateDirectoryExportDeps,
  makePrepareExportDownloadDeps,
  makeSearchDirectoryDeps,
} from '@/modules/insights';
import { makeDrizzleExportJobRepo } from '@/modules/insights/infrastructure/repos/drizzle-export-job-repo';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('F9 directory + export cross-tenant isolation — REVIEW-GATE BLOCKER (T102)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const memberA = randomUUID();
  const memberB = randomUUID();

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    for (const [t, mid, name] of [
      [tenantA, memberA, 'Acme A'],
      [tenantB, memberB, 'Beta B'],
    ] as const) {
      const planId = `f9-xt-${randomUUID().slice(0, 8)}`;
      await runInTenant(t.ctx, async (tx) => {
        await seedF8MembershipPlan(tx, {
          tenantSlug: t.ctx.slug,
          planId,
          planName: { en: 'Plan' },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: admin.userId,
        });
        await tx.insert(members).values({
          tenantId: t.ctx.slug,
          memberId: mid,
          memberNumber: nextSeedMemberNumber(),
          companyName: name,
          country: 'TH',
          planId,
          planYear: 2026,
          status: 'active',
          riskScore: null,
          riskScoreBand: null,
        });
        await tx.insert(contacts).values({
          tenantId: t.ctx.slug,
          contactId: randomUUID(),
          memberId: mid,
          firstName: 'Contact',
          lastName: 'Person',
          email: `c-${mid.slice(0, 8)}@example.com`,
          isPrimary: true,
        });
        await tx.insert(directoryListings).values({
          tenantId: t.ctx.slug,
          memberId: mid,
          listed: true,
          fieldVisibility: { name: true, industry: true },
          industry: `Industry-${t.ctx.slug}`,
        });
      });
    }
  }, 180_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db.delete(directoryListings).where(eq(directoryListings.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(exportJobs).where(eq(exportJobs.tenantId, t.ctx.slug)).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  describe('directory_listings (DB-layer RLS+FORCE)', () => {
    it('READ: tenant B cannot SELECT tenant A listing', async () => {
      const rows = await runInTenant(tenantB.ctx, (tx) =>
        tx.select().from(directoryListings).where(eq(directoryListings.memberId, memberA)),
      );
      expect(rows).toEqual([]);
    });

    it('UPDATE: tenant B UPDATE on tenant A listing affects ZERO rows', async () => {
      const updated = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .update(directoryListings)
          .set({ listed: false })
          .where(eq(directoryListings.memberId, memberA))
          .returning({ memberId: directoryListings.memberId }),
      );
      expect(updated).toEqual([]);
      const surviving = await db
        .select({ listed: directoryListings.listed })
        .from(directoryListings)
        .where(
          and(eq(directoryListings.tenantId, tenantA.ctx.slug), eq(directoryListings.memberId, memberA)),
        );
      expect(surviving[0]?.listed).toBe(true);
    });

    it('INSERT: tenant B INSERT with tenantId=tenantA is rejected by RLS WITH CHECK', async () => {
      await expect(
        runInTenant(tenantB.ctx, (tx) =>
          tx.insert(directoryListings).values({
            tenantId: tenantA.ctx.slug, // spoof
            memberId: memberA,
            listed: true,
            fieldVisibility: {},
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('use-case self-scoping', () => {
    it('searchDirectory in tenant B never returns tenant A members', async () => {
      const r = await searchDirectory(
        {},
        { actorUserId: admin.userId, actorRole: 'admin', requestId: randomUUID() },
        tenantB.ctx,
        makeSearchDirectoryDeps(tenantB.ctx.slug),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ids = r.value.items.map((i) => i.memberId);
      expect(ids).toContain(memberB);
      expect(ids).not.toContain(memberA);
    });

    it('listPublishedInTx in tenant B excludes tenant A listings (SC-007 + Principle I)', async () => {
      const repo = makeSearchDirectoryDeps(tenantB.ctx.slug).directoryRepo;
      const published = await runInTenant(tenantB.ctx, (tx) => repo.listPublishedInTx(tx));
      const ids = published.map((p) => p.memberId);
      expect(ids).toContain(memberB);
      expect(ids).not.toContain(memberA);
    });

    it('an export job created in tenant A resolves to not_found under tenant B', async () => {
      const ref = await exportDirectoryJson(
        { actorUserId: admin.userId, actorRole: 'admin', requestId: randomUUID() },
        tenantA.ctx,
        makeGenerateDirectoryExportDeps(tenantA.ctx.slug),
      );
      expect(ref.ok).toBe(true);
      if (!ref.ok) return;
      const jobAId = ref.value.jobId;

      // Tenant B cannot mint a download for tenant A's job (RLS → findById null).
      const prep = await prepareExportDownload(
        { jobId: jobAId },
        { actorUserId: admin.userId, actorRole: 'admin', actorMemberId: null, requestId: randomUUID() },
        tenantB.ctx,
        makePrepareExportDownloadDeps(tenantB.ctx.slug),
      );
      expect(prep.ok).toBe(false);
      if (!prep.ok) expect(prep.error).toBe('not_found');

      // Tenant A resolves its own job normally.
      const jobA = await makeDrizzleExportJobRepo(tenantA.ctx.slug).findById(tenantA.ctx, jobAId);
      expect(jobA?.id).toBe(jobAId);
    });
  });
});
