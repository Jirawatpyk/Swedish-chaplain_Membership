/**
 * COMP-1 US3-C — `listMemberResendAudienceContactsInTx` on the Drizzle
 * broadcasts repo.
 *
 * Sub-processor propagation (GDPR Art.17 / PDPA §33): on member erasure a
 * later cascade removes the member's email from the Resend AUDIENCES the
 * member received broadcasts in. By post-commit time the join keys are
 * destroyed — the US2b delivery tombstone (which runs INSIDE the atomic scrub
 * tx) redacts `broadcast_deliveries.recipient_email_lower`, and
 * `recipient_member_id` is always NULL in production. This in-tx read captures
 * the `(resend_audience_id, recipient_email_lower)` pairs WHILE the emails are
 * still live, to be called from `eraseMember`'s atomic tx BEFORE the tombstone.
 *
 * Seeds via the live Neon DB (same pattern as scrub-content-for-member /
 * us3-tenant-isolation): a tenant + a member + a broadcast with a
 * `resend_audience_id` + a `broadcast_delivery` (broadcast_id = the seeded
 * broadcast, recipient_email_lower = lower(E), recipient_member_id = NULL —
 * production shape) all through the chamber_app INSERT grants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import {
  broadcasts,
  broadcastDeliveries,
} from '@/modules/broadcasts/infrastructure/schema';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const F7_MATRIX: BenefitMatrix = {
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

/**
 * Seed plan + member into a tenant so a broadcast (with a
 * NOT NULL requested_by_member_id + plan snapshot) can be inserted.
 * Returns the seeded member id.
 */
async function seedPlanAndMember(
  tenant: TestTenant,
  user: TestUser,
): Promise<{ planId: string; memberId: string }> {
  const planId = `aud-plan-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Audience Plan' },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: F7_MATRIX,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    }),
  );

  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: 'Audience Member',
      country: 'TH',
      planId,
      planYear: 2026,
    });
  });

  return { planId, memberId };
}

/**
 * Seed a broadcast authored by `memberId` carrying a given
 * `resend_audience_id` (or null). Returns the broadcast id.
 */
async function seedBroadcast(
  tenant: TestTenant,
  user: TestUser,
  opts: { memberId: string; planId: string; resendAudienceId: string | null },
): Promise<string> {
  const broadcastId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(broadcasts).values({
      tenantId: tenant.ctx.slug,
      broadcastId,
      requestedByMemberId: opts.memberId,
      requestedByMemberPlanIdSnapshot: opts.planId,
      submittedByUserId: user.userId,
      actorRole: 'member_self_service',
      subject: 'Audience subject',
      bodyHtml: '<p>audience body</p>',
      bodySource: 'audience body',
      fromName: 'Chamber',
      replyToEmail: 'reply@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 100,
      status: 'sent',
      submittedAt: new Date(),
      quotaYearConsumed: 2026,
      quotaConsumedAt: new Date(),
      resendAudienceId: opts.resendAudienceId,
    }),
  );
  return broadcastId;
}

/**
 * Seed a delivery row addressed to `recipientEmailLower` under a given
 * broadcast, in the PRODUCTION shape (recipient_member_id = NULL — the
 * Resend webhook is the only inserter and hard-codes null).
 */
async function seedDelivery(
  tenant: TestTenant,
  opts: { broadcastId: string; recipientEmailLower: string },
): Promise<string> {
  const deliveryId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(broadcastDeliveries).values({
      tenantId: tenant.ctx.slug,
      deliveryId,
      broadcastId: opts.broadcastId,
      recipientEmailLower: opts.recipientEmailLower,
      recipientMemberId: null,
      status: 'delivered',
      eventTimestamp: new Date(),
      resendEventId: `evt-${randomUUID()}`,
      resendMessageId: `msg-${randomUUID()}`,
    }),
  );
  return deliveryId;
}

describe('broadcasts repo — listMemberResendAudienceContactsInTx (COMP-1 US3-C)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const tenants = await createTwoTestTenants();
    tenantA = tenants.a;
    tenantB = tenants.b;
  });

  afterAll(async () => {
    if (tenantA) await tenantA.cleanup();
    if (tenantB) await tenantB.cleanup();
  });

  it('returns the (audienceId, lower-cased email) pair for a delivery in an audience-bearing broadcast', async () => {
    const { planId, memberId } = await seedPlanAndMember(tenantA, user);
    const email = `aud-hit-${randomUUID().slice(0, 8)}@example.com`;
    const audienceId = `aud_${randomUUID().slice(0, 8)}`;
    const broadcastId = await seedBroadcast(tenantA, user, {
      memberId,
      planId,
      resendAudienceId: audienceId,
    });
    await seedDelivery(tenantA, {
      broadcastId,
      recipientEmailLower: email.toLowerCase(),
    });

    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const pairs = await runInTenant(tenantA.ctx, (tx) =>
      repo.listMemberResendAudienceContactsInTx(tx, tenantA.ctx.slug, [email]),
    );

    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs).toContainEqual({
      audienceId,
      email: email.toLowerCase(),
    });
  });

  it('matches case-insensitively: a mixed-case email set still returns the pair (BLOCKING-3)', async () => {
    // recipient_email_lower is ALWAYS lower-cased; contact emails are
    // case-PRESERVED in storage. Passing the UPPER-CASE form must STILL match
    // the lower-cased delivery — else a Mixed.Case contact misses its own
    // delivery → its audience is missed → the member's contact SURVIVES in a
    // Resend audience (coverage-survival class).
    const { planId, memberId } = await seedPlanAndMember(tenantA, user);
    const localPart = `aud-mixed-${randomUUID().slice(0, 8)}`;
    const storedDeliveredLower = `${localPart}@example.com`; // as the webhook stored it
    const upperCaseContact = `${localPart}@EXAMPLE.COM`; // as a contact stores it
    const audienceId = `aud_${randomUUID().slice(0, 8)}`;
    const broadcastId = await seedBroadcast(tenantA, user, {
      memberId,
      planId,
      resendAudienceId: audienceId,
    });
    await seedDelivery(tenantA, {
      broadcastId,
      recipientEmailLower: storedDeliveredLower,
    });

    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const pairs = await runInTenant(tenantA.ctx, (tx) =>
      repo.listMemberResendAudienceContactsInTx(tx, tenantA.ctx.slug, [
        upperCaseContact,
      ]),
    );

    expect(pairs).toContainEqual({
      audienceId,
      email: storedDeliveredLower,
    });
  });

  it('a broadcast with resend_audience_id NULL yields no pair', async () => {
    const { planId, memberId } = await seedPlanAndMember(tenantA, user);
    const email = `aud-null-${randomUUID().slice(0, 8)}@example.com`;
    const broadcastId = await seedBroadcast(tenantA, user, {
      memberId,
      planId,
      resendAudienceId: null,
    });
    await seedDelivery(tenantA, {
      broadcastId,
      recipientEmailLower: email.toLowerCase(),
    });

    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const pairs = await runInTenant(tenantA.ctx, (tx) =>
      repo.listMemberResendAudienceContactsInTx(tx, tenantA.ctx.slug, [email]),
    );

    expect(pairs.find((p) => p.email === email.toLowerCase())).toBeUndefined();
  });

  it('an email not present in any delivery returns []', async () => {
    const absentEmail = `aud-absent-${randomUUID().slice(0, 8)}@example.com`;
    const repo = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const pairs = await runInTenant(tenantA.ctx, (tx) =>
      repo.listMemberResendAudienceContactsInTx(tx, tenantA.ctx.slug, [
        absentEmail,
      ]),
    );
    expect(pairs).toEqual([]);
  });

  it('cross-tenant: tenant A does not return tenant B audience pair for the same email', async () => {
    // Seed the SAME email E in tenant B's own audience-bearing broadcast.
    // Tenant A's call must NOT return B's pair (the tenant_id filter on
    // broadcast_deliveries).
    const sharedEmail = `aud-cross-${randomUUID().slice(0, 8)}@example.com`;

    const a = await seedPlanAndMember(tenantA, user);
    const audienceA = `aud_a_${randomUUID().slice(0, 8)}`;
    const broadcastA = await seedBroadcast(tenantA, user, {
      memberId: a.memberId,
      planId: a.planId,
      resendAudienceId: audienceA,
    });
    await seedDelivery(tenantA, {
      broadcastId: broadcastA,
      recipientEmailLower: sharedEmail.toLowerCase(),
    });

    const b = await seedPlanAndMember(tenantB, user);
    const audienceB = `aud_b_${randomUUID().slice(0, 8)}`;
    const broadcastB = await seedBroadcast(tenantB, user, {
      memberId: b.memberId,
      planId: b.planId,
      resendAudienceId: audienceB,
    });
    await seedDelivery(tenantB, {
      broadcastId: broadcastB,
      recipientEmailLower: sharedEmail.toLowerCase(),
    });

    const repoA = makeDrizzleBroadcastsRepo(tenantA.ctx.slug);
    const pairsA = await runInTenant(tenantA.ctx, (tx) =>
      repoA.listMemberResendAudienceContactsInTx(tx, tenantA.ctx.slug, [
        sharedEmail,
      ]),
    );

    // Tenant A sees only its own audience for the shared email.
    expect(pairsA).toContainEqual({
      audienceId: audienceA,
      email: sharedEmail.toLowerCase(),
    });
    expect(pairsA.find((p) => p.audienceId === audienceB)).toBeUndefined();
  });
});
