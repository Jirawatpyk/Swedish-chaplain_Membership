/**
 * 058 G1 cross-tenant integration test (Principle I clause 3 — Review-Gate
 * blocker). The Benefits → Broadcasts tab reads via listMemberBroadcasts +
 * computeQuotaCounter (barrels). This proves member A's tenant context never
 * returns member B's (other-tenant) broadcasts or quota. Live Neon Singapore.
 * All seed data is SIMULATED — never real PII.
 *
 * This suite proves BOTH layers of Principle I tenant isolation:
 *   1. Application layer — the barrel use-cases (listMemberBroadcasts +
 *      computeQuotaCounter → port → adapter → SQL) re-derive tenant scoping
 *      in their WHERE clause. A dropped predicate or a mis-wired tenant
 *      context would leak cross-tenant rows here even with RLS intact at the
 *      row level, so those reads are an explicit defence-in-depth check on
 *      the two reads the redesigned Broadcasts tab depends on.
 *   2. Postgres RLS layer — the raw-tx probe at the bottom issues a SELECT
 *      with NO application tenant predicate (only the RLS+FORCE policy on
 *      `broadcasts` governs visibility) under tenantA's context via
 *      runInTenant (app role, subject to RLS). If it returned tenantB's row,
 *      the DB-layer policy would be broken. The app-layer reads alone cannot
 *      prove this because their explicit `tenantId` predicate would hide the
 *      leak even with RLS disabled.
 *
 * A computeQuotaCounter positive control proves the cross-tenant not-found is
 * specifically RLS-driven (plans-bridge folds server_error → member_not_found,
 * so a genuinely-broken call would otherwise pass for the wrong reason).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  computeQuotaCounter,
  listMemberBroadcasts,
  makeComputeQuotaDeps,
  makeListMemberBroadcastsDeps,
} from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 3,
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

describe('058 G1 Benefits→Broadcasts tab tenant isolation (Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let aMemberId: string;
  let bMemberId: string;
  let aBroadcastId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    for (const [t, label] of [
      [tenantA, 'a'] as const,
      [tenantB, 'b'] as const,
    ]) {
      const planId = `g1-iso-${randomUUID().slice(0, 8)}`;
      const memberUuid = randomUUID();
      if (label === 'a') aMemberId = memberUuid;
      else bMemberId = memberUuid;

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
          description: { en: 'desc' },
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

      // Seed broadcasts via owner role (BYPASS RLS) — same pattern as the
      // F7 perf-test seeder. This intentionally plants a cross-tenant row
      // (tenantB's broadcast) that the tenant-scoped barrel reads below
      // must then NOT surface under tenantA's context.
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
        status: 'sent',
        // CHECK `broadcasts_quota_year_only_on_sent` (schema.ts:282) requires
        // both quota columns to be NON-NULL when status='sent' (and NULL
        // otherwise). Seed the current calendar year so the row models a
        // genuinely-consumed quota slot.
        quotaYearConsumed: new Date().getUTCFullYear(),
        quotaConsumedAt: new Date(),
        retentionYears: 5,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  // I2 (2026-06-07 follow-up): the use-cases are called DIRECTLY — no outer
  // `runInTenant` wrapper. The deps factories carry the tenant slug and the
  // repo opens its OWN `runInTenant(ctx)` internally; the Neon driver does
  // NOT nest `db.transaction` as a savepoint, so an outer wrapper's
  // `SET LOCAL app.current_tenant` would apply to a transaction the read
  // never uses (dead code that misrepresents what enforces isolation).
  it('listMemberBroadcasts — tenantA context, tenantB memberId → empty (no leak)', async () => {
    const result = await listMemberBroadcasts(
      makeListMemberBroadcastsDeps(tenantA.ctx.slug),
      {
        memberId: asMemberId(bMemberId),
        page: 1,
        perPage: 10,
      },
    );
    expect(result.total).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it('listMemberBroadcasts — tenantA sees its own member broadcast', async () => {
    const result = await listMemberBroadcasts(
      makeListMemberBroadcastsDeps(tenantA.ctx.slug),
      {
        memberId: asMemberId(aMemberId),
        page: 1,
        perPage: 10,
      },
    );
    expect(result.total).toBe(1);
    expect(result.rows[0]?.broadcastId as string).toBe(aBroadcastId);
  });

  it('computeQuotaCounter — tenantA context, tenantB memberId → no cross-tenant quota', async () => {
    const result = await computeQuotaCounter(
      makeComputeQuotaDeps(tenantA.ctx.slug),
      {
        memberId: asMemberId(bMemberId),
      },
    );
    if (result.ok) {
      // Member B is invisible under tenantA's context; if the use-case still
      // returns ok it MUST carry a zero counter (no cross-tenant usage leaked).
      expect(result.value.counter.used).toBe(0);
    } else {
      // Expected path: member-not-found under tenantA's context.
      expect(result.error.kind).toMatch(/not_found/);
    }
  });

  // I1 (2026-06-07 follow-up) — positive control. The cross-tenant
  // not-found above asserts only `error.kind` matches /not_found/, but
  // plans-bridge.ts folds plan_lookup.server_error → member_not_found
  // (and get-plan-for-member emits server_error on ANY thrown/non-not-found
  // failure), so a genuinely BROKEN call would ALSO surface as
  // member_not_found and the cross-tenant assertion could pass for the
  // wrong reason. This control proves the SAME call SUCCEEDS for the
  // member's own tenant, so the cross-tenant not-found is specifically
  // RLS-driven, not a wiring fault.
  it('computeQuotaCounter — tenantA sees its own member quota (positive control)', async () => {
    const result = await computeQuotaCounter(makeComputeQuotaDeps(tenantA.ctx.slug), {
      memberId: asMemberId(aMemberId),
    });
    expect(result.ok).toBe(true);
    // Member A consumed exactly one 'sent' broadcast this quota year (cap = 3).
    if (result.ok) {
      expect(result.value.counter.used).toBe(1);
    }
  });

  // I3 (2026-06-07 follow-up) — DB-layer RLS probe. The app-layer reads
  // above filter with an explicit `eq(broadcasts.tenantId, ...)` predicate,
  // so `total 0` is guaranteed by the WHERE clause even if RLS were
  // disabled — that proves the application layer but NOT the Postgres RLS
  // policy. This raw query carries NO tenant predicate (only RLS governs
  // it) and runs as the app role via `runInTenant` (subject to RLS+FORCE),
  // NOT the owner `db` (which bypasses RLS). If it returns B's row, the
  // RLS+FORCE policy on `broadcasts` is broken.
  it('RLS layer — raw query under tenantA context cannot see tenantB broadcast (DB-layer isolation)', async () => {
    const rows = await runInTenant(tenantA.ctx, async (tx) =>
      tx.select().from(broadcasts).where(eq(broadcasts.requestedByMemberId, bMemberId)),
    );
    // No tenantId predicate here — if this returns B's row, RLS+FORCE is broken.
    expect(rows).toHaveLength(0);
  });
});
