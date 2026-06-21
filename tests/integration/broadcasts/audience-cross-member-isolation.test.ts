/**
 * PR-2 Task 5 (Review-gate blocker) — integration test: each broadcast gets
 * its OWN ephemeral Resend audience, with NO cross-member contact leak.
 *
 * Pins the PR-2 ephemeral-per-broadcast design against any future regression
 * to a single SHARED reusable audience — the design the cross-member PII leak
 * would have had (member B's contacts visible in member A's audience and vice
 * versa).
 *
 * Shape:
 *   1. Seed ONE tenant with TWO members A and B, each with one `approved`
 *      broadcast targeting ONLY its own recipients (distinct email sets) and
 *      one `pending` batch manifest covering those recipients.
 *   2. Drive both `dispatchBroadcastBatch` runs concurrently against the REAL
 *      gateway (`resendBroadcastsGateway`) with the Resend SDK overridden by a
 *      contract-fake that records `(audienceId → contacts)` per
 *      `contacts.create`.
 *   3. Assert: EXACTLY two distinct audiences were created (one per broadcast),
 *      and the two recorded contact sets are EXACTLY {A's recipients} and
 *      {B's recipients} — no A email in B's audience and vice versa.
 *
 * Concrete-value assertions only (no vacuous `not.toContain(stringMatching)`
 * which passes regardless): we assert the exact partition of the two audiences
 * against the two known recipient sets.
 *
 * Live Neon Singapore via `.env.local` `DATABASE_URL`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { makeDrizzleBatchManifestsRepo } from '@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo';
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { noOpAdvisoryLock } from '@/modules/broadcasts/infrastructure/noop-advisory-lock';
import { systemClock } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { _setTestOverride } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-client';
import {
  dispatchBroadcastBatch,
  type DispatchBroadcastBatchDeps,
} from '@/modules/broadcasts/application/use-cases/dispatch-broadcast-batch';
import { asBroadcastId, type BroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { makeIdempotencyKey } from '@/modules/broadcasts/domain/value-objects/idempotency-key';
import { asTenantContext } from '@/modules/tenants';
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
  label: string,
): Promise<{ planId: string; memberId: string }> {
  const planId = `iso-plan-${label}-${randomUUID().slice(0, 8)}`;
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: `Isolation Plan ${label}` },
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
      companyName: `Isolation Member ${label}`,
      country: 'TH',
      planId,
      planYear: 2026,
    });
  });

  return { planId, memberId };
}

/** Seed an `approved` broadcast authored by `memberId`. Returns its id. */
async function seedApprovedBroadcast(
  tenant: TestTenant,
  user: TestUser,
  opts: { memberId: string; planId: string },
): Promise<BroadcastId> {
  const broadcastId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(broadcasts).values({
      tenantId: tenant.ctx.slug,
      broadcastId,
      requestedByMemberId: opts.memberId,
      requestedByMemberPlanIdSnapshot: opts.planId,
      submittedByUserId: user.userId,
      actorRole: 'member_self_service',
      subject: 'Isolation subject',
      bodyHtml: '<p>isolation body</p>',
      bodySource: 'isolation body',
      fromName: 'Chamber',
      replyToEmail: 'reply@example.com',
      segmentType: 'custom',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 100,
      status: 'approved',
      submittedAt: new Date(),
      approvedAt: new Date(),
    }),
  );
  return asBroadcastId(broadcastId);
}

/**
 * Seed a single `pending` batch manifest (batchIndex 0) for `broadcastId`
 * covering [0, recipientCount-1]. Returns the manifest id.
 */
async function seedBatchManifest(
  tenant: TestTenant,
  broadcastId: BroadcastId,
  recipientCount: number,
): Promise<string> {
  const repo = makeDrizzleBatchManifestsRepo(tenant.ctx.slug);
  const result = await repo.bulkInsert(tenant.ctx.slug, [
    {
      broadcastId,
      batchIndex: 0,
      recipientCount,
      recipientRangeStart: 0,
      recipientRangeEnd: recipientCount - 1,
      idempotencyKey: makeIdempotencyKey(broadcastId, 0, 0),
    },
  ]);
  if (!result.ok) {
    throw new Error(
      `seedBatchManifest bulkInsert failed: ${JSON.stringify(result.error)}`,
    );
  }
  const manifest = result.value[0];
  if (manifest === undefined) {
    throw new Error('seedBatchManifest produced no manifest row');
  }
  return manifest.id;
}

function makeDeps(tenant: TestTenant): DispatchBroadcastBatchDeps {
  return {
    batchManifests: makeDrizzleBatchManifestsRepo(tenant.ctx.slug),
    gateway: resendBroadcastsGateway,
    advisoryLock: noOpAdvisoryLock,
    audit: f7AuditAdapter,
    clock: systemClock,
  };
}

function broadcastContentFor(broadcastId: BroadcastId) {
  return {
    broadcastId,
    subject: 'Isolation subject',
    bodyHtml: '<p>isolation body</p>',
    fromName: 'Chamber',
    fromEmail: 'from@example.com',
    replyToEmail: 'reply@example.com',
    tenantDisplayName: 'Test Chamber',
    locale: 'en' as const,
  };
}

describe('audience-cross-member-isolation (PR-2 ephemeral-per-broadcast, live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  // Distinct recipient sets per member — concrete values the assertions pin.
  const aRecipients = [
    'alpha-1@member-a.example.com',
    'alpha-2@member-a.example.com',
  ];
  const bRecipients = [
    'bravo-1@member-b.example.com',
    'bravo-2@member-b.example.com',
    'bravo-3@member-b.example.com',
  ];

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
  });

  afterEach(() => {
    _setTestOverride(null);
  });

  afterAll(async () => {
    _setTestOverride(null);
    if (tenant) await tenant.cleanup();
  });

  it('each broadcast gets its OWN audience holding EXACTLY its own recipients (no cross-member leak)', async () => {
    // ── Seed two members + their approved broadcasts + batch manifests ──────
    const a = await seedPlanAndMember(tenant, user, 'A');
    const b = await seedPlanAndMember(tenant, user, 'B');

    const broadcastA = await seedApprovedBroadcast(tenant, user, {
      memberId: a.memberId,
      planId: a.planId,
    });
    const broadcastB = await seedApprovedBroadcast(tenant, user, {
      memberId: b.memberId,
      planId: b.planId,
    });

    const manifestA = await seedBatchManifest(
      tenant,
      broadcastA,
      aRecipients.length,
    );
    const manifestB = await seedBatchManifest(
      tenant,
      broadcastB,
      bRecipients.length,
    );

    // ── Override the Resend SDK with a recording contract-fake ──────────────
    const fake = createResendContractFake();
    _setTestOverride(fake.client as unknown as Resend);

    const deps = makeDeps(tenant);
    const tenantCtx = asTenantContext(tenant.ctx.slug);

    // ── Drive BOTH dispatches concurrently ──────────────────────────────────
    const [resultA, resultB] = await Promise.all([
      dispatchBroadcastBatch(deps, {
        tenantId: tenantCtx,
        batchManifestId: manifestA,
        allRecipients: aRecipients.map((emailLower) => ({ emailLower })),
        broadcastContent: broadcastContentFor(broadcastA),
      }),
      dispatchBroadcastBatch(deps, {
        tenantId: tenantCtx,
        batchManifestId: manifestB,
        allRecipients: bRecipients.map((emailLower) => ({ emailLower })),
        broadcastContent: broadcastContentFor(broadcastB),
      }),
    ]);

    // Both dispatches must succeed (else the assertion below is meaningless).
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    // ── EXACTLY two distinct audiences were created — one per broadcast ─────
    const createdAudiences = fake.createdAudienceIdsInOrder();
    expect(createdAudiences).toHaveLength(2);
    expect(new Set(createdAudiences).size).toBe(2); // distinct ids

    // ── Each audience holds EXACTLY one member's recipients ─────────────────
    // Ordering across Promise.all is nondeterministic, so assert the PARTITION
    // by content: the two audiences' contact sets are EXACTLY {A's} and {B's}.
    const expectedA = new Set(aRecipients.map((e) => e.toLowerCase()));
    const expectedB = new Set(bRecipients.map((e) => e.toLowerCase()));

    const contactSets = createdAudiences.map((id) =>
      [...fake.getAudienceContacts(id)].sort(),
    );
    const sortedExpectedA = [...expectedA].sort();
    const sortedExpectedB = [...expectedB].sort();

    // The collection of two recorded sets must equal the collection {A, B}.
    expect(contactSets).toContainEqual(sortedExpectedA);
    expect(contactSets).toContainEqual(sortedExpectedB);

    // ── No cross-member leak (explicit, concrete-value form) ────────────────
    // The audience holding A's recipients must contain ZERO B recipients,
    // and vice versa. Find each audience by its A/B signature.
    const audienceWithA = createdAudiences.find((id) => {
      const set = fake.getAudienceContacts(id);
      return aRecipients.every((e) => set.has(e.toLowerCase()));
    });
    const audienceWithB = createdAudiences.find((id) => {
      const set = fake.getAudienceContacts(id);
      return bRecipients.every((e) => set.has(e.toLowerCase()));
    });

    expect(audienceWithA).toBeDefined();
    expect(audienceWithB).toBeDefined();
    expect(audienceWithA).not.toBe(audienceWithB);

    const aAudienceContacts = fake.getAudienceContacts(audienceWithA!);
    const bAudienceContacts = fake.getAudienceContacts(audienceWithB!);

    // A's audience contains none of B's emails …
    for (const bEmail of bRecipients) {
      expect(aAudienceContacts.has(bEmail.toLowerCase())).toBe(false);
    }
    // … and B's audience contains none of A's emails.
    for (const aEmail of aRecipients) {
      expect(bAudienceContacts.has(aEmail.toLowerCase())).toBe(false);
    }

    // Exact-size guard — no extra/duplicate contacts crept in.
    expect(aAudienceContacts.size).toBe(aRecipients.length);
    expect(bAudienceContacts.size).toBe(bRecipients.length);
  });
});
