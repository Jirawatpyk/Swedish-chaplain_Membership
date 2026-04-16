/**
 * T128 — Integration: per-member timeline vs live Neon (US6).
 *
 * Covers:
 *   - Member-scoped filter returns only events for the target member
 *   - Newest-first ordering
 *   - Cursor pagination — limit 2 returns nextCursor; second page loads rest
 *   - Member-role redaction — override_reason_* stripped for 'member' role
 *   - Cross-tenant isolation — RLS keeps tenant B's events invisible
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant, db } from '@/lib/db';
import { createMember, timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  membershipPlans,
  tenantFeeConfig,
} from '@/modules/plans/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

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

async function seedPlanAndMember(
  tenant: TestTenant,
  user: TestUser,
  companyName: string,
): Promise<string> {
  const planId = `timeline-plan-${randomUUID().slice(0, 6)}`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx
      .insert(tenantFeeConfig)
      .values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeMinorUnits: 100000,
        updatedBy: user.userId,
      })
      .onConflictDoNothing();
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Timeline Plan' },
      description: { en: '' },
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
  });

  const deps = buildMembersDeps(tenant.ctx);
  const slug = `timeline-${randomUUID().slice(0, 8)}`;
  const r = await createMember(
    {
      company_name: companyName,
      country: 'SE',
      plan_id: planId,
      plan_year: 2026,
      primary_contact: {
        first_name: 'Anna',
        last_name: 'Andersson',
        email: `${slug}@example.com`,
        preferred_language: 'sv' as const,
      },
    },
    { actorUserId: user.userId, requestId: `timeline-seed-${slug}` },
    deps,
  );
  if (!r.ok) throw new Error(`seed failed: ${JSON.stringify(r.error)}`);
  return r.value.memberId;
}

/**
 * Append synthetic audit rows with override_reason payload for
 * redaction testing — bypass the use-case layer to control the payload.
 */
async function insertSyntheticEvent(
  tenant: TestTenant,
  memberId: string,
  eventType:
    | 'member_plan_changed'
    | 'member_updated'
    | 'member_status_changed',
  payloadExtras: Record<string, unknown>,
  timestamp?: Date,
): Promise<void> {
  await db.insert(auditLog).values({
    eventType,
    actorUserId: 'admin-synthetic',
    summary: `synthetic ${eventType}`,
    requestId: `synth-${randomUUID()}`,
    tenantId: tenant.ctx.slug,
    payload: { member_id: memberId, ...payloadExtras },
    ...(timestamp ? { timestamp } : {}),
  });
}

describe('timeline integration (T128, US6)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let memberIdA: string;
  let memberIdB: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    memberIdA = await seedPlanAndMember(tenantA, user, 'Timeline AB');
    memberIdB = await seedPlanAndMember(tenantB, user, 'Timeline CD');

    // Seed extra synthetic events on memberA with override_reason (for redaction test)
    await insertSyntheticEvent(
      tenantA,
      memberIdA,
      'member_plan_changed',
      { override_reason_code: 'other', override_reason_note: 'secret' },
    );
    await insertSyntheticEvent(
      tenantA,
      memberIdA,
      'member_updated',
      { fields_changed: ['company_name'] },
    );
    await insertSyntheticEvent(
      tenantA,
      memberIdA,
      'member_status_changed',
      { old_status: 'active', new_status: 'inactive' },
    );

    // Seed an event on memberB (different tenant) — timeline on A must NOT see it
    await insertSyntheticEvent(
      tenantB,
      memberIdB,
      'member_updated',
      { fields_changed: ['notes'] },
    );
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('returns member-scoped events newest-first (admin role)', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const r = await timelineList(
      { memberId: memberIdA, limit: 50 },
      {
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId: 'test-1',
      },
      tenantA.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // At least: member_created, contact_created, + 3 synthetic = 5
    expect(r.value.events.length).toBeGreaterThanOrEqual(5);
    // Newest-first: first event timestamp >= second event timestamp
    for (let i = 0; i < r.value.events.length - 1; i++) {
      expect(r.value.events[i]!.timestamp.getTime()).toBeGreaterThanOrEqual(
        r.value.events[i + 1]!.timestamp.getTime(),
      );
    }
    // Every event MUST be for memberA
    for (const e of r.value.events) {
      if (e.payload && 'member_id' in e.payload) {
        expect(e.payload.member_id).toBe(memberIdA);
      }
    }
  });

  it('cursor pagination: limit 2 returns nextCursor; next page continues', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const first = await timelineList(
      { memberId: memberIdA, limit: 2 },
      {
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId: 'test-2a',
      },
      tenantA.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.events).toHaveLength(2);
    expect(first.value.nextCursor).not.toBeNull();

    const second = await timelineList(
      {
        memberId: memberIdA,
        limit: 2,
        ...(first.value.nextCursor
          ? { cursor: first.value.nextCursor }
          : {}),
      },
      {
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId: 'test-2b',
      },
      tenantA.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.events.length).toBeGreaterThanOrEqual(1);
    // No overlap between pages
    const firstIds = new Set(first.value.events.map((e) => e.id));
    for (const e of second.value.events) {
      expect(firstIds.has(e.id)).toBe(false);
    }
  });

  it('member role — override_reason_* payload keys are redacted', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const r = await timelineList(
      { memberId: memberIdA, limit: 50 },
      {
        actorUserId: user.userId,
        actorRole: 'member',
        requestId: 'test-3',
      },
      tenantA.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Find the plan-changed event
    const planChanged = r.value.events.find(
      (e) => e.eventType === 'member_plan_changed',
    );
    expect(planChanged).toBeTruthy();
    if (!planChanged?.payload) return;
    expect(planChanged.payload.override_reason_code).toBeUndefined();
    expect(planChanged.payload.override_reason_note).toBeUndefined();
    // Non-sensitive keys survive
    expect(planChanged.payload.member_id).toBe(memberIdA);
  });

  it('admin role — override_reason_* payload keys are preserved', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const r = await timelineList(
      { memberId: memberIdA, limit: 50 },
      {
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId: 'test-4',
      },
      tenantA.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const planChanged = r.value.events.find(
      (e) => e.eventType === 'member_plan_changed',
    );
    expect(planChanged).toBeTruthy();
    if (!planChanged?.payload) return;
    expect(planChanged.payload.override_reason_code).toBe('other');
    expect(planChanged.payload.override_reason_note).toBe('secret');
  });

  it('tenant isolation — timeline on tenantA never sees tenantB events', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const r = await timelineList(
      { memberId: memberIdB, limit: 50 },
      {
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId: 'test-5',
      },
      tenantA.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    // Either:
    //  - 404 not_found (memberB is not in tenantA — the getMember guard
    //    short-circuits before the timeline query), OR
    //  - ok with zero events (guard rejected, empty result)
    // We accept either branch — both satisfy "tenantA cannot see tenantB".
    if (r.ok) {
      expect(r.value.events.length).toBe(0);
    } else {
      expect(r.error.type).toBe('not_found');
    }
  });

  it('404 not_found — invalid memberId', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const r = await timelineList(
      {
        memberId: '00000000-0000-4000-8000-000000000000',
        limit: 50,
      },
      {
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId: 'test-6',
      },
      tenantA.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe('not_found');
  });
});
