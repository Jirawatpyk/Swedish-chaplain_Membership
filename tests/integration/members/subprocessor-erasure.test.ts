/**
 * COMP-1 US3-C (Task 5) — end-to-end live-Neon proof that `eraseMember` wires
 * the SUB-PROCESSOR erasure cascade (GDPR Art. 17 / PDPA §33 sub-processor
 * propagation): the member's email is removed from every Resend audience it
 * received broadcasts in, a `subprocessor_erasure_propagated` audit records the
 * outcome, and — critically — the cascade is NON-BLOCKING (a Resend failure
 * does NOT withhold the `member_erased` completion proof).
 *
 * The cascade has two halves:
 *   1. IN-TX capture (FAIL-LOUD) — inside the atomic scrub tx, BEFORE the US2b
 *      delivery tombstone redacts the member's emails, the
 *      `BroadcastsAudienceDerivationPort` reads the `(resend_audience_id,
 *      recipient_email_lower)` pairs the member received broadcasts in. The pairs
 *      cannot be re-derived post-scrub (the tombstone redacts
 *      `recipient_email_lower`; `recipient_member_id` is always NULL in prod).
 *   2. POST-COMMIT propagation (BEST-EFFORT / NON-BLOCKING) — the
 *      `SubprocessorErasurePort` removes each captured pair from its Resend
 *      audience. A failure here is recorded (`resend_outcome:'failed'` audit +
 *      the `member_subprocessor_erasure_total` metric) but does NOT flip
 *      `allCascadesClean` — the captured inputs do not survive a US2d re-drive,
 *      so retrying would re-capture an empty set; the DPO runbook (US3-E) owns
 *      the residual.
 *
 * This test drives the PRODUCTION composition root `buildEraseMemberDeps(ctx)`
 * — the REAL `f7BroadcastsAudienceDerivationAdapter` (in-tx SELECT against live
 * Neon) AND the REAL `subprocessorErasureAdapter` — but `vi.mock`s F7's barrel
 * (`@/modules/broadcasts`) so `resendBroadcastsGateway.removeContactFromAudience`
 * is a spy (no live Resend call). Every OTHER barrel export (notably
 * `makeDrizzleBroadcastsRepo`, which the audience-derivation + content-scrub
 * adapters use) is preserved via `importActual` so the rest of the erasure runs
 * against real F7 infrastructure.
 *
 * Two cases:
 *   A. happy path — the spy resolves → `removeContactFromAudience` is called with
 *      (audienceId, contactEmail); a `subprocessor_erasure_propagated` audit
 *      records `resend_outcome:'ok'` + `resend_contacts_removed_count:1`;
 *      `member_erased` IS emitted (cascadesComplete true).
 *   B. failure path — the spy rejects → `resend_outcome:'failed'` audit, and
 *      `member_erased` is STILL emitted (cascadesComplete true) — proving the
 *      cascade is NON-BLOCKING.
 *
 * Reuses the live-Neon harness shared by `erase-member-f7-content.test.ts`
 * (production builder + fee/plan + renewal-policy seed + BYPASSRLS raw select)
 * and the broadcast/delivery seed pattern — but the seeded broadcast carries a
 * non-NULL `resend_audience_id` and the delivery references THAT broadcast (so
 * the audience-derivation JOIN yields a pair).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

// vi.mock F7's barrel: spy on `removeContactFromAudience`, keep everything else
// real (the audience-derivation + content-scrub adapters need
// `makeDrizzleBroadcastsRepo`; the F7/F8 cancel cascades need the real exports).
// `vi.hoisted` so the spy is initialised BEFORE the hoisted `vi.mock` factory
// references it (the factory runs at the top of the module).
const { removeContactFromAudienceSpy } = vi.hoisted(() => ({
  removeContactFromAudienceSpy: vi.fn<
    (audienceId: string, email: string) => Promise<void>
  >(async () => {}),
}));

vi.mock('@/modules/broadcasts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/broadcasts')>();
  return {
    ...actual,
    resendBroadcastsGateway: {
      ...actual.resendBroadcastsGateway,
      removeContactFromAudience: removeContactFromAudienceSpy,
    },
  };
});

import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  broadcasts,
  broadcastDeliveries,
} from '@/modules/broadcasts/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

const PLAN_ID = 'test-erase-subprocessor-plan';

async function seedPlan(tenant: TestTenant, userId: string) {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: tenant.ctx.slug,
      currencyCode: 'THB',
      vatRate: '0.0700',
      registrationFeeSatang: 100000n,
      legalNameTh: 'Test TH',
      legalNameEn: 'Test EN',
      taxId: '0000000000000',
      registeredAddressTh: 'Test Address TH',
      registeredAddressEn: 'Test Address EN',
      invoiceNumberPrefix: 'INV',
      creditNoteNumberPrefix: 'CN',
    });
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Erase Subprocessor Plan' },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      createdBy: userId,
      updatedBy: userId,
      benefitMatrix: {
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
      },
    });
  });
}

/**
 * Seed a member M + a primary contact (NO linked F1 login, so the F1
 * user-erasure cascade is a clean no-op). Returns the contact's lower-cased
 * email (the delivery recipient + the audience-derivation join key).
 */
async function seedMember(
  tenant: TestTenant,
): Promise<{ memberId: string; contactEmail: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  const contactEmail = `erik-sub-${randomUUID().slice(0, 8)}@example.com`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Subprocessor Erase Co ${Date.now()}`,
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: '0105536000123',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Erik',
      lastName: 'Eriksson',
      email: contactEmail,
      phone: '+66812345678',
      roleTitle: 'CEO',
      preferredLanguage: 'sv',
      isPrimary: true,
      dateOfBirth: '1980-01-01',
      linkedUserId: null,
      removedAt: null,
    });
  });
  return { memberId, contactEmail };
}

/**
 * Seed an audience-bearing broadcast (status `submitted`, `resend_audience_id`
 * SET) + a delivery row that references THAT broadcast at `recipientEmail`
 * (production shape: recipient_member_id NULL). The audience-derivation read
 * JOINs delivery→broadcast on broadcast_id and filters
 * `resend_audience_id IS NOT NULL`, so the pair is yielded only when the
 * delivery points at a real audience-bearing broadcast.
 */
async function seedAudienceDelivery(
  tenant: TestTenant,
  authorMemberId: string,
  submittedByUserId: string,
  recipientEmail: string,
  audienceId: string,
): Promise<{ broadcastId: string; deliveryId: string }> {
  const broadcastId = randomUUID();
  const deliveryId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(broadcasts).values({
      tenantId: tenant.ctx.slug,
      broadcastId,
      requestedByMemberId: authorMemberId,
      requestedByMemberPlanIdSnapshot: PLAN_ID,
      submittedByUserId,
      actorRole: 'member_self_service',
      subject: 'Audience broadcast',
      bodyHtml: '<p>Audience broadcast body</p>',
      bodySource: 'Audience broadcast body',
      fromName: 'Audience Sender',
      replyToEmail: 'audience@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 100,
      status: 'submitted',
      submittedAt: new Date(),
      // The audience the member received this broadcast in — the join key the
      // sub-processor cascade removes the member's email from.
      resendAudienceId: audienceId,
    });
    await tx.insert(broadcastDeliveries).values({
      tenantId: tenant.ctx.slug,
      deliveryId,
      // Reference the REAL audience-bearing broadcast above (NOT an orphan
      // randomUUID) so the audience-derivation JOIN yields a pair.
      broadcastId,
      recipientEmailLower: recipientEmail,
      recipientMemberId: null,
      status: 'delivered',
      eventTimestamp: new Date(),
      resendEventId: `evt-${randomUUID()}`,
      resendMessageId: `msg-${randomUUID()}`,
    });
  });
  return { broadcastId, deliveryId };
}

/** `subprocessor_erasure_propagated` audit rows for this tenant + member. */
async function rawSelectSubprocessorAudits(tenantSlug: string, memberId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantSlug),
        eq(auditLog.eventType, 'subprocessor_erasure_propagated'),
      ),
    );
  return rows.filter(
    (r) =>
      (r.payload as { member_id?: string } | null)?.member_id === memberId,
  );
}

/** `member_erased` audit rows for this tenant + member. */
async function rawSelectMemberErasedAudits(tenantSlug: string, memberId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantSlug),
        eq(auditLog.eventType, 'member_erased'),
      ),
    );
  return rows.filter(
    (r) =>
      (r.payload as { member_id?: string } | null)?.member_id === memberId,
  );
}

describe('eraseMember — sub-processor erasure cascade (COMP-1 US3-C, live Neon, production deps)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
    // The production builder wires the REAL F8 cascade (makeRenewalsDeps) — seed
    // the renewal policies/settings fixture so that composition root is
    // well-formed even though no in-flight cycle exists for this member.
    await seedRenewalPolicies(tenant.ctx);
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('A — propagates to Resend (removeContactFromAudience called), records resend_outcome:ok + removed_count:1, and emits member_erased (non-blocking)', async () => {
    removeContactFromAudienceSpy.mockClear();
    removeContactFromAudienceSpy.mockResolvedValue(undefined);

    const { memberId, contactEmail } = await seedMember(tenant);
    const audienceId = `aud-ok-${randomUUID().slice(0, 8)}`;
    await seedAudienceDelivery(
      tenant,
      memberId,
      admin.userId,
      contactEmail,
      audienceId,
    );

    const requestId = `rq-erase-sub-ok-${Date.now()}`;
    const deps = buildEraseMemberDeps(tenant.ctx);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId },
      deps,
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // Non-blocking + clean Resend → the whole erasure completes.
    expect(result.value.cascadesComplete).toBe(true);

    // The Resend gateway was asked to remove the member's email from the
    // audience it received the broadcast in (captured pre-redaction in-tx).
    expect(removeContactFromAudienceSpy).toHaveBeenCalledTimes(1);
    expect(removeContactFromAudienceSpy).toHaveBeenCalledWith(
      audienceId,
      contactEmail,
    );

    // A subprocessor_erasure_propagated audit records the ok outcome + counts.
    const subAudits = await rawSelectSubprocessorAudits(
      tenant.ctx.slug,
      memberId,
    );
    expect(
      subAudits.length,
      'expected a subprocessor_erasure_propagated audit row',
    ).toBeGreaterThanOrEqual(1);
    const payload = subAudits[0]!.payload as {
      resend_outcome?: string;
      resend_contacts_removed_count?: number;
      resend_contacts_failed_count?: number;
      stripe_outcome?: string;
      reason?: string;
    };
    expect(payload.resend_outcome).toBe('ok');
    expect(payload.resend_contacts_removed_count).toBe(1);
    expect(payload.resend_contacts_failed_count).toBe(0);
    expect(payload.stripe_outcome).toBe('ok');
    expect(payload.reason).toBe('gdpr_erasure_request');
    // No PII in the audit row (ids + outcomes only).
    expect(JSON.stringify(subAudits[0])).not.toContain(contactEmail);

    // member_erased emitted (completion proof — cascadesComplete held).
    const erased = await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId);
    expect(erased.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('B — NON-BLOCKING: a Resend removal failure records resend_outcome:failed but member_erased is STILL emitted', async () => {
    removeContactFromAudienceSpy.mockClear();
    removeContactFromAudienceSpy.mockRejectedValue(
      new Error('resend 503 service unavailable'),
    );

    const { memberId, contactEmail } = await seedMember(tenant);
    const audienceId = `aud-fail-${randomUUID().slice(0, 8)}`;
    await seedAudienceDelivery(
      tenant,
      memberId,
      admin.userId,
      contactEmail,
      audienceId,
    );

    const requestId = `rq-erase-sub-fail-${Date.now()}`;
    const deps = buildEraseMemberDeps(tenant.ctx);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId },
      deps,
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // The Resend removal failed but the cascade is NON-BLOCKING — the whole
    // erasure still completes (the captured inputs do not survive a re-drive).
    expect(result.value.cascadesComplete).toBe(true);

    // The spy was invoked (and rejected) for the captured pair.
    expect(removeContactFromAudienceSpy).toHaveBeenCalledTimes(1);
    expect(removeContactFromAudienceSpy).toHaveBeenCalledWith(
      audienceId,
      contactEmail,
    );

    // A subprocessor_erasure_propagated audit records the FAILED outcome.
    const subAudits = await rawSelectSubprocessorAudits(
      tenant.ctx.slug,
      memberId,
    );
    expect(subAudits.length).toBeGreaterThanOrEqual(1);
    const payload = subAudits[0]!.payload as {
      resend_outcome?: string;
      resend_contacts_removed_count?: number;
      resend_contacts_failed_count?: number;
    };
    expect(payload.resend_outcome).toBe('failed');
    expect(payload.resend_contacts_removed_count).toBe(0);
    expect(payload.resend_contacts_failed_count).toBe(1);

    // CRITICAL: member_erased is STILL emitted — the sub-processor cascade does
    // NOT withhold the completion proof.
    const erased = await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId);
    expect(
      erased.length,
      'member_erased MUST be emitted even when sub-processor propagation fails (non-blocking)',
    ).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
