/**
 * DV-4 / T-10 — admin_proxy submit MUST honour the proxied member's
 * quota cap against live Neon (RLS-scoped).
 *
 * Scenario: a member sits on a plan with `eblast_per_year = 1` and has
 * already SENT 1 broadcast in the current quota year (`used == cap`,
 * `remaining === 0`). An admin proxy-submitting on that member's behalf
 * MUST be blocked with `broadcast_quota_blocked` — there is no
 * admin bypass (security.md CHK005 / spec Q12). No NEW broadcast row may
 * be inserted by the blocked call.
 *
 * Why live Neon (not a mock): the quota counter (`computeQuotaCounter`)
 * derives `used`/`reserved`/`cap` from the F2 plan benefit-matrix lookup
 * + the F7 `broadcasts.countForMemberQuota` SQL aggregate over real,
 * RLS-scoped rows. A mocked counter would not exercise the SQL predicate
 * (`status='sent' AND quota_year_consumed = <year>`) nor the RLS+FORCE
 * policy that scopes the count to the proxied member's tenant — exactly
 * the surface T-10 lives in.
 *
 * `used == cap` (NOT `used + reserved > cap`): an over-subscription
 * state surfaces `submit.server_error`, a different code path. This test
 * pins the canonical at-cap → `broadcast_quota_blocked` path.
 *
 * Harness reused verbatim from `tenant-isolation.test.ts`:
 *   - `createTestTenant` (UUID-suffixed slug + FK-ordered cleanup)
 *   - `createActiveTestUser('admin')` (acting admin user for audit)
 *   - `nextSeedMemberNumber()` (collision-free member_number for raw inserts)
 *   - `runInTenant(ctx, tx => ...)` for every RLS-scoped seed write
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  proxySubmitBroadcast,
  makeProxySubmitBroadcastDeps,
} from '@/modules/broadcasts';
import {
  broadcasts,
  type NewBroadcastRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// eblast_per_year = 1 so a single seeded `sent` broadcast saturates the
// cap (used == cap == 1 → remaining 0). Everything else mirrors the
// minimal corporate matrix used by `tenant-isolation.test.ts`.
const AT_CAP_MATRIX: BenefitMatrix = {
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

describe('DV-4 / T-10 — admin_proxy honours member quota cap (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let memberId: string;
  let planId: string;
  // Current quota year (Asia/Bangkok per FR-006/FR-007). UTC year is
  // identical for the vast majority of the year; the seeded `sent` row's
  // `quota_year_consumed` must match the year the use-case computes from
  // its system clock at call time, so derive both from the same `now`.
  const quotaYear = new Date().getUTCFullYear();

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    planId = `dv4-cap-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'DV-4 At-Cap Plan' },
        description: { en: 'eblast_per_year = 1 for the at-cap test' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: AT_CAP_MATRIX,
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
        companyName: 'DV-4 At-Cap Member',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );

    // Seed exactly `cap` (= 1) SENT broadcast for this member in the
    // current quota year so `countForMemberQuota.sent === 1`, driving
    // remaining → 0. A `sent` row MUST set both quota_year_consumed AND
    // quota_consumed_at (CHECK `broadcasts_quota_year_only_on_sent`).
    const sentBroadcast: NewBroadcastRow = {
      tenantId: tenant.ctx.slug,
      broadcastId: randomUUID(),
      requestedByMemberId: memberId,
      requestedByMemberPlanIdSnapshot: planId,
      submittedByUserId: randomUUID(),
      actorRole: 'member_self_service',
      subject: 'Already-sent broadcast (consumes the only quota slot)',
      bodyHtml: '<p>sent</p>',
      bodySource: 'sent',
      fromName: 'DV-4 At-Cap Member via Test Chamber',
      replyToEmail: 'member@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 0,
      status: 'sent',
      sentAt: new Date(),
      quotaYearConsumed: quotaYear,
      quotaConsumedAt: new Date(),
    };
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values(sentBroadcast),
    );
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch((e) => {
      console.error('[DV-4 quota-cap] cleanup failed:', e);
    });
  });

  it('admin_proxy at the member cap is blocked (no free broadcast)', async () => {
    const deps = makeProxySubmitBroadcastDeps(tenant.ctx.slug);

    const result = await proxySubmitBroadcast(deps, {
      proxiedMemberId: memberId,
      adminUserId: admin.userId,
      tenantDisplayName: 'Test Chamber',
      // Task 3 replaces this field with a `memberLookup` discriminated
      // input — write against the CURRENT shape (`memberDisplayName`).
      memberDisplayName: 'DV-4 At-Cap Member',
      subject: 'Proxy at cap',
      bodySource: '<p>hi</p>',
      bodyHtml: '<p>hi</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_quota_blocked');
    }
  });

  it('no NEW broadcast row was inserted by the blocked proxy submit', async () => {
    // Only the single seeded `sent` row should exist for this member —
    // the blocked call must NOT have inserted a draft/submitted row.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(broadcasts)
        .where(
          and(
            eq(broadcasts.tenantId, tenant.ctx.slug),
            eq(broadcasts.requestedByMemberId, memberId),
          ),
        ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('sent');
  });
});
