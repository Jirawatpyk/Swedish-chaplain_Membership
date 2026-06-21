/**
 * Design D1 (2026-06-21) — a `failed_to_dispatch` broadcast RELEASES the
 * member's annual E-Blast quota slot (live Neon, RLS-scoped).
 *
 * Bug being pinned: `failed_to_dispatch` is a TERMINAL state with no
 * re-trigger route. The previous `countForMemberQuota` SQL counted it as
 * `reserved` (`IN ('submitted', 'approved', 'failed_to_dispatch')`), so a
 * member whose only broadcast permanently failed to dispatch was locked out
 * of their benefit forever with no recovery. D1 drops `failed_to_dispatch`
 * from the reserved set → the slot is freed.
 *
 * Why live Neon (not a mock): the inverted unit test in
 * `tests/unit/broadcasts/application/compute-quota-counter.test.ts` encodes
 * the use-case contract against a MOCKED repo — it cannot prove the SQL
 * predicate actually excludes `failed_to_dispatch`. This test drives the
 * REAL `computeQuotaCounter` (production `plansBridge` F2 lookup +
 * `makeDrizzleBroadcastsRepo` SQL aggregate) over real, RLS-scoped rows so a
 * future SQL regression that re-adds `failed_to_dispatch` to the reserved
 * `IN (...)` fails here.
 *
 * Harness reused from `proxy-submit-quota-cap.integration.test.ts`:
 *   - `createTestTenant` (UUID-suffixed slug + FK-ordered cleanup)
 *   - `createActiveTestUser('admin')` (membership_plans.created_by FK)
 *   - `nextSeedMemberNumber()` (collision-free member_number for raw inserts)
 *   - a plan with `eblast_per_year = 1` so cap = 1 and a freed slot →
 *     remaining = 1.
 *
 * Note on the seed: a `failed_to_dispatch` row is NOT in
 * ('sent', 'partial_delivery_accepted'), so the
 * `broadcasts_quota_year_only_on_sent` CHECK requires
 * `quota_year_consumed` and `quota_consumed_at` to be NULL — they are
 * left unset below. The status-transition + immutability triggers fire on
 * UPDATE only (they read `OLD.status`), so a direct INSERT of a terminal
 * status row is permitted (mirrors the `sent` seed in the proxy-submit test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  asMemberId,
} from '@/modules/members';
import {
  computeQuotaCounter,
  currentQuotaYear,
  makeDrizzleBroadcastsRepo,
} from '@/modules/broadcasts';
import {
  broadcasts,
  type NewBroadcastRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { plansBridge } from '@/modules/broadcasts/infrastructure/plans-bridge';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// eblast_per_year = 1: cap = 1 so a released slot drives remaining → 1.
const CAP_1_MATRIX: BenefitMatrix = {
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

describe('Design D1 — failed_to_dispatch releases the quota slot (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let memberId: string;
  let planId: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    planId = `d1-cap1-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'D1 Cap-1 Plan' },
        description: { en: 'eblast_per_year = 1 for the failed-dispatch release test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: CAP_1_MATRIX,
        isActive: true,
        createdBy: admin.userId,
        updatedBy: admin.userId,
      }),
    );

    memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'D1 Failed-Dispatch Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );

    // Seed the member's ONLY broadcast in `failed_to_dispatch`. Pre-D1 this
    // would hold the reservation (reserved=1, remaining=0); post-D1 the slot
    // is released (reserved=0, remaining=1). quota_year_consumed /
    // quota_consumed_at MUST be NULL for a non-sent row
    // (`broadcasts_quota_year_only_on_sent` CHECK).
    const failedBroadcast: NewBroadcastRow = {
      tenantId: tenant.ctx.slug,
      broadcastId: randomUUID(),
      requestedByMemberId: memberId,
      requestedByMemberPlanIdSnapshot: planId,
      submittedByUserId: randomUUID(),
      actorRole: 'member_self_service',
      subject: 'Permanently failed dispatch (must NOT hold the quota slot)',
      bodyHtml: '<p>failed</p>',
      bodySource: 'failed',
      fromName: 'D1 Failed-Dispatch Member via Test Chamber',
      replyToEmail: 'member@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 0,
      status: 'failed_to_dispatch',
      failedToDispatchAt: new Date(),
    };
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values(failedBroadcast),
    );
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => {
      console.error('[D1 quota-release] cleanup failed:', e);
    });
  });

  it('a failed_to_dispatch broadcast does not count toward reserved (reserved=0, remaining=cap)', async () => {
    const result = await computeQuotaCounter(
      {
        tenant: tenant.ctx,
        plansBridge,
        broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
        clock: { now: () => new Date() },
      },
      { memberId: asMemberId(memberId) },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.counter.cap).toBe(1);
      // The freed slot — pre-D1 this was reserved=1 / remaining=0.
      expect(result.value.counter.reserved).toBe(0);
      expect(result.value.counter.used).toBe(0);
      expect(result.value.counter.remaining).toBe(1);
    }
  });

  it('the repo SQL aggregate excludes failed_to_dispatch from submittedOrApproved', async () => {
    // Pin the SQL predicate directly so a regression that re-adds
    // failed_to_dispatch to the reserved `IN (...)` fails at the SQL layer
    // even if the use-case wiring changes. quotaYear must match the year the
    // use-case computes (Asia/Bangkok per FR-006/FR-007) — the seeded
    // failed_to_dispatch row has no quota_year_consumed, so the `sent` count
    // is 0 regardless, but we use the same helper for consistency.
    const quotaYear = currentQuotaYear(new Date(), 'Asia/Bangkok');
    const counts = await makeDrizzleBroadcastsRepo(
      tenant.ctx.slug,
    ).countForMemberQuota(tenant.ctx.slug, asMemberId(memberId), quotaYear);

    expect(counts.submittedOrApproved).toBe(0);
    expect(counts.sent).toBe(0);
  });
});
