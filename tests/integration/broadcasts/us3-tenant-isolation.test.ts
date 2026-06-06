/**
 * F7 US3 tenant-isolation integration test (REVIEW-GATE BLOCKER).
 *
 * Constitution v1.4.0 Principle I clause 3 — "mandatory cross-tenant
 * integration test as a Review-Gate blocker." Existing
 * `tenant-isolation.test.ts` (T022) covers raw-table CRUD; this file
 * covers the **3 new BroadcastsRepo methods + `MemberRepo.findLastPlanChangedAt`**
 * shipped in F7 US3 — each method re-derives tenant scoping in its
 * WHERE clause, so a typo or accidentally-dropped predicate in any of
 * them would silently leak cross-tenant rows. RLS at the DB layer
 * catches direct table queries; this test proves the **Application
 * boundary** (port → adapter → SQL) preserves tenant scoping.
 *
 * Tests run against live Neon Singapore (vitest.integration.config).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { broadcasts, broadcastDeliveries } from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { drizzleMemberRepo, asMemberId } from '@/modules/members';
import { asBroadcastId } from '@/modules/broadcasts';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

describe('F7 US3 Tenant isolation — new repo methods (Principle I clause 3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let aMemberIdRaw: string;
  let bMemberIdRaw: string;
  let aBroadcastId: string;
  let bBroadcastId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    for (const [t, label] of [
      [tenantA, 'a'] as const,
      [tenantB, 'b'] as const,
    ]) {
      const planId = `us3-iso-${randomUUID().slice(0, 8)}`;
      const memberUuid = randomUUID();
      if (label === 'a') aMemberIdRaw = memberUuid;
      else bMemberIdRaw = memberUuid;

      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(tenantInvoiceSettings).values({
          tenantId: t.ctx.slug,
          currencyCode: 'THB',
          vatRate: '0.0700',
          registrationFeeSatang: 100000n,
          legalNameTh: 'TH',
          legalNameEn: 'EN',
          taxId: '0000000000000',
          registeredAddressTh: 'TH',
          registeredAddressEn: 'EN',
          invoiceNumberPrefix: 'INV',
          creditNoteNumberPrefix: 'CN',
        });
        await tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId,
          planYear: 2026,
          planName: { en: 'Iso Plan' },
          description: { en: 'Test description' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 500_000,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: null,
          maxTurnoverMinorUnits: null,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        });
        await tx.insert(members).values({
          tenantId: t.ctx.slug,
          memberId: memberUuid,
          memberNumber: nextSeedMemberNumber(),
          companyName: `Iso Co ${label}`,
          country: 'TH',
          planId,
          planYear: 2026,
          registrationDate: new Date().toISOString().slice(0, 10),
          registrationFeePaid: true,
          status: 'active',
        });
      });

      const broadcastUuid = randomUUID();
      if (label === 'a') aBroadcastId = broadcastUuid;
      else bBroadcastId = broadcastUuid;

      // Seed broadcasts via owner role (BYPASS RLS) — same pattern as
      // perf-test seeder. The repo queries below run inside
      // `runInTenant` so they'll be tenant-scoped at read time.
      await db.insert(broadcasts).values({
        tenantId: t.ctx.slug,
        broadcastId: broadcastUuid,
        requestedByMemberId: memberUuid,
        requestedByMemberPlanIdSnapshot: planId,
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: `Iso ${label}`,
        bodyHtml: '<p>x</p>',
        bodySource: 'plain',
        fromName: `Iso Co ${label}`,
        replyToEmail: 'iso@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'draft',
        retentionYears: 5,
      });

      // Seed a delivery row per broadcast so the aggregator has
      // something to count (via owner role; broadcast_deliveries is
      // append-only).
      await db.insert(broadcastDeliveries).values({
        tenantId: t.ctx.slug,
        deliveryId: randomUUID(),
        broadcastId: broadcastUuid,
        recipientEmailLower: `iso-${label}@example.com`,
        status: 'delivered',
        eventTimestamp: new Date(),
        resendEventId: `iso-${label}-${randomUUID()}`,
        resendMessageId: `msg-${randomUUID()}`,
      });

      // Seed a member_plan_changed audit row per tenant so the
      // findLastPlanChangedAt cross-tenant test has rows to filter
      // out.
      await db.insert(auditLog).values({
        tenantId: t.ctx.slug,
        eventType: 'member_plan_changed',
        actorUserId: user.userId,
        summary: `seed plan-changed ${label}`,
        requestId: `iso-seed-${randomUUID()}`,
        // Production emitter (change-plan.ts:244) + query
        // (drizzle-member-repo.ts:980 `payload ->> 'member_id'`) both use
        // snake_case. The seed must match the production key or
        // findLastPlanChangedAt finds 0 rows (B0-I4 seed-key fix).
        // Match the production emitter's payload shape (change-plan.ts:243-247,
        // all snake_case). The query only filters on member_id, but keeping the
        // rest faithful avoids a misleading seed.
        payload: { member_id: memberUuid, old_plan_id: 'p1', new_plan_id: 'p2' },
        timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });
    }
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  // ─────────── BroadcastsRepo.listForMemberPaginated ───────────
  it('listForMemberPaginated — tenantA cannot see tenantB rows', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    // Query A's repo with tenantA's slug + tenantB's memberId — RLS +
    // explicit WHERE filter should both prevent leak. Expect empty.
    const result = await repoA.listForMemberPaginated(
      tenantA.ctx.slug,
      asMemberId(bMemberIdRaw),
      { page: 1, perPage: 10 },
    );
    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('listForMemberPaginated — tenantA sees its own member rows', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const result = await repoA.listForMemberPaginated(
      tenantA.ctx.slug,
      asMemberId(aMemberIdRaw),
      { page: 1, perPage: 10 },
    );
    expect(result.total).toBe(1);
    expect(result.rows[0]?.broadcastId).toBe(aBroadcastId);
  });

  // ─────────── BroadcastsRepo.findOwnedByMember ───────────
  it('findOwnedByMember — tenantA probe of tenantB broadcastId returns not_found (RLS-filtered)', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const result = await repoA.findOwnedByMember(
      tenantA.ctx.slug,
      asMemberId(aMemberIdRaw),
      asBroadcastId(bBroadcastId),
    );
    // Cross-tenant row is invisible under RLS → repo sees absent row
    // → probeKind:'not_found' (NOT 'cross_member', because the
    // broadcast row is fully RLS-hidden, not just owned by another
    // member in the same tenant).
    //
    // **RLS-leak invariant**: if a future RLS misconfiguration lets
    // tenantA see tenantB's broadcasts, this assertion will fail with
    // probeKind === 'cross_member' (row visible but ownership
    // mismatch). Treat that as a P0 security regression.
    expect(result.broadcast).toBeNull();
    expect(result.probeKind).toBe('not_found');
  });

  it('findOwnedByMember — owned path returns probeKind="owned"', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const result = await repoA.findOwnedByMember(
      tenantA.ctx.slug,
      asMemberId(aMemberIdRaw),
      asBroadcastId(aBroadcastId),
    );
    expect(result.broadcast).not.toBeNull();
    expect(result.probeKind).toBe('owned');
  });

  // ─────────── BroadcastsRepo.aggregateDeliveryCountsForBroadcast ───────────
  it('aggregateDeliveryCountsForBroadcast — tenantA on tenantB broadcast returns zeros (RLS-filtered)', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const counts = await repoA.aggregateDeliveryCountsForBroadcast(
      tenantA.ctx.slug,
      asBroadcastId(bBroadcastId),
    );
    expect(counts).toEqual({
      delivered: 0,
      bounced: 0,
      softBounced: 0,
      complained: 0,
      sent: 0,
    });
  });

  it('aggregateDeliveryCountsForBroadcast — own broadcast aggregates correctly', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const counts = await repoA.aggregateDeliveryCountsForBroadcast(
      tenantA.ctx.slug,
      asBroadcastId(aBroadcastId),
    );
    expect(counts.delivered).toBe(1);
  });

  // ─────────── BroadcastsRepo.aggregateDeliveryCountsForBroadcast empty-input contract ───────────
  it('aggregateDeliveryCountsForBroadcast — broadcast with no deliveries returns all zeros (no NaN leak)', async () => {
    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    // Seed a second broadcast in tenantA with NO delivery rows.
    const emptyBroadcastId = randomUUID();
    const planRows = await runInTenant(tenantA.ctx, async (tx) =>
      tx.execute(
        sql`SELECT plan_id FROM membership_plans WHERE tenant_id = ${tenantA.ctx.slug} LIMIT 1`,
      ),
    );
    const planId = (planRows as unknown as Array<{ plan_id: string }>)[0]
      ?.plan_id;
    // Seed via runInTenant so RLS+FORCE applies (consistent with the
    // beforeAll member/plan inserts; only the broadcasts/deliveries
    // beforeAll inserts use BYPASS-RLS because broadcast_deliveries
    // is append-only-trigger-protected).
    await runInTenant(tenantA.ctx, async (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenantA.ctx.slug,
        broadcastId: emptyBroadcastId,
        requestedByMemberId: aMemberIdRaw,
        requestedByMemberPlanIdSnapshot: planId ?? '',
        submittedByUserId: user.userId,
        actorRole: 'member_self_service',
        subject: 'Empty deliveries',
        bodyHtml: '<p>x</p>',
        bodySource: 'plain',
        fromName: 'Iso Co a',
        replyToEmail: 'iso@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 0,
        status: 'draft',
        retentionYears: 5,
      }),
    );

    const counts = await repoA.aggregateDeliveryCountsForBroadcast(
      tenantA.ctx.slug,
      asBroadcastId(emptyBroadcastId),
    );
    // All zeros — every numeric field is initialised, so the use-case
    // sum cannot produce NaN downstream.
    expect(counts).toEqual({
      delivered: 0,
      bounced: 0,
      softBounced: 0,
      complained: 0,
      sent: 0,
    });
    expect(Number.isNaN(counts.delivered + counts.bounced)).toBe(false);
  });

  // ─────────── MemberRepo.findLastPlanChangedAt ───────────
  it('findLastPlanChangedAt — tenantA cannot see tenantB audit rows for its memberId', async () => {
    // Use F3 repo — runs inside runInTenant(tenantA.ctx, …) and reads
    // audit_log scoped via the explicit `tenant_id = ${ctx.slug}` filter.
    const result = await drizzleMemberRepo.findLastPlanChangedAt(
      tenantA.ctx,
      asMemberId(bMemberIdRaw),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('findLastPlanChangedAt — own member returns the seeded timestamp', async () => {
    const result = await drizzleMemberRepo.findLastPlanChangedAt(
      tenantA.ctx,
      asMemberId(aMemberIdRaw),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(Date);
    }
  });
});
