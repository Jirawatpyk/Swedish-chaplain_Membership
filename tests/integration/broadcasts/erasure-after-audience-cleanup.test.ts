/**
 * PR-2 Task 5 (Review-gate blocker) — integration test: COMP-1 member
 * erasure still propagates to the Resend sub-processor AFTER the per-broadcast
 * ephemeral audience was cleaned up by the PR-2 cron.
 *
 * Proves D4: the ephemeral-audience cleanup (Tasks 1–4) does NOT break the
 * GDPR Art. 17 / PDPA §33 sub-processor erasure cascade.
 *
 * Shape (mirrors the COMP-1 US3-C flow exactly):
 *   1. Seed a member + a TERMINAL broadcast whose `audience_deleted_at` is SET
 *      (audience already cleaned) but `resend_audience_id` is still non-null
 *      (the row keeps the id for forensics) + a `broadcast_deliveries` row for
 *      the member's email.
 *   2. `listMemberResendAudienceContactsInTx` returns the `{audienceId, email}`
 *      pair REGARDLESS of `audience_deleted_at` — so the post-cleanup cascade
 *      still knows which audience to scrub.
 *   3. Drive the REAL `subprocessorErasureAdapter.propagate(...)` with the
 *      Resend SDK overridden by a contract-fake whose `contacts.remove`
 *      returns a 404 (`resource_missing`) for the already-deleted audience.
 *   4. The gateway's `removeContactFromAudience` 404-tolerance path fires →
 *      the adapter counts the 404 as REMOVED (the data is already gone at the
 *      sub-processor → erasure goal met), resolves with `resendOutcome: 'ok'`,
 *      and NEVER throws.
 *
 * This is a CONFIRMING test — the code is already 404-tolerant. A failure here
 * (a throw, or a `failed`/`partial` outcome) is a real regression in the
 * cleanup × erasure interaction and must be reported, not papered over.
 *
 * Live Neon Singapore via `.env.local` `DATABASE_URL`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import {
  broadcasts,
  broadcastDeliveries,
} from '@/modules/broadcasts/infrastructure/schema';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { _setTestOverride } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client';
import { subprocessorErasureAdapter } from '@/modules/members/infrastructure/adapters/subprocessor-erasure-adapter';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { Resend } from 'resend';
import { createResendContractFake } from '../../support/broadcasts/resend-contract-fake';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
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

async function seedPlanAndMember(
  tenant: TestTenant,
  user: TestUser,
): Promise<{ planId: string; memberId: string }> {
  const planId = `erase-plan-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Erasure Plan' },
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
      companyName: 'Erasure Member',
      country: 'TH',
      planId,
      planYear: 2026,
    });
  });

  return { planId, memberId };
}

/**
 * Seed a TERMINAL broadcast whose Resend audience has ALREADY been cleaned up
 * (`audience_deleted_at` set) but the `resend_audience_id` is retained.
 */
async function seedCleanedUpBroadcast(
  tenant: TestTenant,
  user: TestUser,
  opts: { memberId: string; planId: string; resendAudienceId: string },
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
      subject: 'Erasure subject',
      bodyHtml: '<p>erasure body</p>',
      bodySource: 'erasure body',
      fromName: 'Chamber',
      replyToEmail: 'reply@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 100,
      // Terminal status — the only state in which an audience may be deleted.
      status: 'sent',
      submittedAt: new Date(),
      quotaYearConsumed: 2026,
      quotaConsumedAt: new Date(),
      resendAudienceId: opts.resendAudienceId,
      // The audience was already cleaned up by the PR-2 cron.
      audienceDeletedAt: new Date(Date.now() - 3600_000),
    }),
  );
  return broadcastId;
}

async function seedDelivery(
  tenant: TestTenant,
  opts: { broadcastId: string; recipientEmailLower: string },
): Promise<void> {
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(broadcastDeliveries).values({
      tenantId: tenant.ctx.slug,
      deliveryId: randomUUID(),
      broadcastId: opts.broadcastId,
      recipientEmailLower: opts.recipientEmailLower,
      recipientMemberId: null,
      status: 'delivered',
      eventTimestamp: new Date(),
      resendEventId: `evt-${randomUUID()}`,
      resendMessageId: `msg-${randomUUID()}`,
    }),
  );
}

describe('erasure-after-audience-cleanup (COMP-1 US3-C × PR-2 cleanup, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  });

  afterEach(() => {
    // PROCESS-GLOBAL override — clear after every test so it never leaks into
    // a sibling integration file (no other dispatch integration test uses this
    // seam yet; establishing the hygiene pattern here).
    _setTestOverride(null);
  });

  afterAll(async () => {
    _setTestOverride(null);
    if (tenant) await tenant.cleanup();
  });

  it('resolves with resendOutcome=ok when the audience was already cleaned up (404 counted as ALREADY-ABSENT, not as a removal — round 4 T1)', async () => {
    const { planId, memberId } = await seedPlanAndMember(tenant, user);
    const email = `erase-${randomUUID().slice(0, 8)}@example.com`;
    // A `resend_audience_id` that was NEVER created in the fake → the fake's
    // opt-in `contacts.remove` returns 404 for it (models a deleted audience).
    const deletedAudienceId = `aud_deleted_${randomUUID().slice(0, 8)}`;

    const broadcastId = await seedCleanedUpBroadcast(tenant, user, {
      memberId,
      planId,
      resendAudienceId: deletedAudienceId,
    });
    await seedDelivery(tenant, {
      broadcastId,
      recipientEmailLower: email.toLowerCase(),
    });

    // 1) The in-tx read returns the (audienceId, email) pair EVEN THOUGH the
    //    audience was cleaned up (`audience_deleted_at` is set). This is the
    //    load-bearing invariant: the cascade still knows which audience to
    //    scrub at the sub-processor.
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    const audienceContacts = await runInTenant(tenant.ctx, (tx) =>
      repo.listMemberResendAudienceContactsInTx(tx, tenant.ctx.slug, [email]),
    );
    expect(audienceContacts).toContainEqual({
      audienceId: deletedAudienceId,
      email: email.toLowerCase(),
    });

    // 2) Override the Resend SDK with a contract-fake whose contacts.remove
    //    404s for the (never-created → modelling deleted) audience.
    const fake = createResendContractFake({
      contactsRemove404OnDeletedAudience: true,
    });
    _setTestOverride(fake.client as unknown as Resend);

    // 3) Drive the REAL adapter → REAL gateway → fake SDK. The gateway's
    //    `removeContactFromAudience` discriminates the 404 as
    //    `{kind:'already_absent'}` and the adapter counts it apart from a real
    //    detach — see 4).
    const result = await subprocessorErasureAdapter.propagate({
      memberId,
      reason: 'gdpr_erasure',
      audienceContacts,
      tenantSlug: tenant.ctx.slug,
      requestId: randomUUID(),
    });

    // 4) Assertions — the cascade RESOLVED cleanly (no throw), and D4 still
    //    holds: cleanup does not break GDPR erasure, because the erasure goal is
    //    already met when the audience is gone.
    //
    //    **Round 4 T1 — INVERTED, and this test pinned the defect.** It asserted
    //    `resendContactsRemoved === audienceContacts.length` under the comment
    //    "the 404 was counted as a successful removal". That is exactly the
    //    materially-false count `897dd73d7` split apart: 404s inflated
    //    `resend_contacts_removed_count`, which reaches an append-only Art. 30
    //    row and renders on the DPO's evidence card under the label "Contacts
    //    removed" — a DSR answer asserting removals that never happened
    //    (Art. 12(3)). Found by the pre-push integration gate, not by me: I ran
    //    the erasure suites I could name and did not grep `tests/` for the
    //    method I had changed.
    //
    //    Both outcomes are still SUCCESSES, so `resendOutcome` stays `ok`; only
    //    one of them is a removal.
    expect(result.resendOutcome).toBe('ok');
    expect(result.resendContactsRemoved).toBe(0);
    expect(result.resendContactsAlreadyAbsent).toBe(audienceContacts.length);
    expect(result.resendContactsAlreadyAbsent).toBeGreaterThanOrEqual(1);
    expect(result.resendContactsFailed).toBe(0);
    expect(result.stripeOutcome).toBe('ok');
  });
});
