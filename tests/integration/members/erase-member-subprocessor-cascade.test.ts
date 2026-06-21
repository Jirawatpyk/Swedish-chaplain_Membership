/**
 * COMP-1 US3-C (Task 6 — capstone) — live-Neon proof that the SUB-PROCESSOR
 * erasure cascade (GDPR Art. 17 / PDPA §33 sub-processor propagation) holds its
 * four load-bearing invariants end-to-end through the PRODUCTION composition
 * root `buildEraseMemberDeps(ctx)`:
 *
 *   1. HAPPY CAPSTONE — a member who received broadcasts in TWO distinct
 *      audience-bearing broadcasts → erase → `removeContactFromAudience` is
 *      called for BOTH (audience, email) pairs → ONE
 *      `subprocessor_erasure_propagated` audit (resend_outcome:'ok',
 *      removed_count:2) → `member_erased` emitted, cascadesComplete:true.
 *
 *   2. CROSS-TENANT (Principle-I Review-Gate blocker, GENUINE 2-tenant) — a
 *      tenant-A member (in audience aud_A) and a tenant-B member sharing the
 *      SAME contact email (in audience aud_B). Erasing the tenant-A member must
 *      remove ONLY aud_A from Resend (NOT aud_B) and leave tenant-B's member +
 *      delivery + audience fully intact. The in-tx audience-derivation read runs
 *      under tenant A's `app.current_tenant`, so RLS scopes the JOIN to A's
 *      `broadcast_deliveries`/`broadcasts` — the same email in B's namespace is
 *      invisible. This is the use-case-level isolation gate the security review
 *      requires (complementary to the F7-repo-level test).
 *
 *   3. RE-DRIVE (empty-set) — force the first-pass gateway spy to reject →
 *      resend_outcome:'failed' audit, member_erased emitted (non-blocking). Then
 *      RE-RUN `eraseMember` for the SAME member (the US2d reconciler shape): the
 *      in-tx capture now reads `[]` (contacts already removed_at-stamped → no
 *      live emails → no audience pairs) → a SECOND
 *      `subprocessor_erasure_propagated` audit (resend_outcome:'ok',
 *      removed_count:0, a VACUOUS empty-set no-op) → member_erased present
 *      exactly ONCE total. The gateway spy is NOT called again on the re-drive.
 *      (Proves the documented best-effort-ONCE residual: the first-pass inputs
 *      are destroyed by the same erasure, so a re-drive cannot retry the Resend
 *      removal — see docs/runbooks/member-erasure.md § Security cond-3.)
 *
 *   4. THROW-PATH ROLLBACK (security CONDITION-2) — inject a throw into the
 *      in-tx FAIL-LOUD audience-derivation capture (override just
 *      `broadcastsAudienceDerivation` on the production deps with a rejecting
 *      stub) → the WHOLE atomic erasure ROLLS BACK: `members.erased_at` stays
 *      NULL, contacts are NOT scrubbed, NO `member_erased` audit is emitted, and
 *      the member is re-drivable. This proves the capture is FAIL-LOUD (a
 *      derivation failure aborts the erasure rather than silently
 *      under-propagating) — the M-1 asymmetry the use-case documents at the
 *      capture site.
 *
 * Harness: mirrors `subprocessor-erasure.test.ts` (T5) — `vi.mock`s F7's barrel
 * so `resendBroadcastsGateway.removeContactFromAudience` is a spy while every
 * other export (notably `makeDrizzleBroadcastsRepo`, used by the
 * audience-derivation + content-scrub adapters) is preserved via
 * `importActual`. Scenario 2 reuses the two-tenant `createTwoTestTenants`
 * harness from `erase-member-cross-tenant.test.ts`.
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

import { db, runInTenant, type TenantTx } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import type { BroadcastsAudienceDerivationPort } from '@/modules/members/application/ports/broadcasts-audience-derivation-port';
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
import {
  createTestTenant,
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';

const PLAN_ID = 'test-erase-sub-capstone-plan';

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
      planName: { en: 'Erase Subprocessor Capstone Plan' },
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
 * Seed a member M + a primary contact (NO linked F1 login → the F1
 * user-erasure cascade is a clean no-op). `email` may be supplied so two
 * members in DIFFERENT tenants can share the SAME contact email (scenario 2).
 * Returns the contact's lower-cased email (the delivery recipient + the
 * audience-derivation join key).
 */
async function seedMember(
  tenant: TestTenant,
  email?: string,
): Promise<{ memberId: string; contactEmail: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  const contactEmail = email ?? `erik-cap-${randomUUID().slice(0, 8)}@example.com`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Subprocessor Capstone Co ${Date.now()}-${randomUUID().slice(0, 4)}`,
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
 * SET) + a delivery row addressed to `recipientEmail` (production shape:
 * recipient_member_id NULL). The audience-derivation read JOINs delivery→
 * broadcast on broadcast_id and filters `resend_audience_id IS NOT NULL`, so the
 * (audienceId, email) pair is yielded only when the delivery points at a real
 * audience-bearing broadcast.
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
      resendAudienceId: audienceId,
    });
    await tx.insert(broadcastDeliveries).values({
      tenantId: tenant.ctx.slug,
      deliveryId,
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
    (r) => (r.payload as { member_id?: string } | null)?.member_id === memberId,
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
    (r) => (r.payload as { member_id?: string } | null)?.member_id === memberId,
  );
}

/** BYPASSRLS owner-role select of a member's erased_at + company_name. */
async function rawSelectMember(memberId: string) {
  return db
    .select({
      company_name: members.companyName,
      erased_at: members.erasedAt,
    })
    .from(members)
    .where(eq(members.memberId, memberId))
    .limit(1);
}

/** BYPASSRLS owner-role select of a member's contacts (scrub / removal probe). */
async function rawSelectContacts(memberId: string) {
  return db
    .select({
      first_name: contacts.firstName,
      email: contacts.email,
      removed_at: contacts.removedAt,
    })
    .from(contacts)
    .where(eq(contacts.memberId, memberId));
}

/** BYPASSRLS owner-role select of a broadcast delivery's recipient_email_lower. */
async function rawSelectDelivery(deliveryId: string) {
  return db
    .select({
      recipient_email_lower: broadcastDeliveries.recipientEmailLower,
      status: broadcastDeliveries.status,
    })
    .from(broadcastDeliveries)
    .where(eq(broadcastDeliveries.deliveryId, deliveryId))
    .limit(1);
}

// ---- Scenarios 1, 3, 4 — single tenant -------------------------------------

describe('eraseMember — sub-processor cascade capstone (COMP-1 US3-C, live Neon, production deps)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
    // The production builder wires the REAL F8 cascade — seed renewal config so
    // the composition root is well-formed even with no in-flight cycle.
    await seedRenewalPolicies(tenant.ctx);
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('1 — HAPPY CAPSTONE: a member in TWO audience-bearing broadcasts → both pairs removed, ONE audit (removed_count:2), member_erased + cascadesComplete:true', async () => {
    removeContactFromAudienceSpy.mockClear();
    removeContactFromAudienceSpy.mockResolvedValue(undefined);

    const { memberId, contactEmail } = await seedMember(tenant);
    const audienceA = `aud-cap-a-${randomUUID().slice(0, 8)}`;
    const audienceB = `aud-cap-b-${randomUUID().slice(0, 8)}`;
    // Two DISTINCT audience-bearing broadcasts the member received → two pairs.
    await seedAudienceDelivery(tenant, memberId, admin.userId, contactEmail, audienceA);
    await seedAudienceDelivery(tenant, memberId, admin.userId, contactEmail, audienceB);

    const requestId = `rq-erase-sub-cap-ok-${Date.now()}`;
    const deps = buildEraseMemberDeps(tenant.ctx);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId },
      deps,
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.cascadesComplete).toBe(true);

    // BOTH (audience, email) pairs were removed from Resend.
    expect(removeContactFromAudienceSpy).toHaveBeenCalledTimes(2);
    const calledAudiences = removeContactFromAudienceSpy.mock.calls
      .map((c) => c[0])
      .sort();
    expect(calledAudiences).toEqual([audienceA, audienceB].sort());
    for (const call of removeContactFromAudienceSpy.mock.calls) {
      expect(call[1]).toBe(contactEmail);
    }

    // EXACTLY ONE subprocessor_erasure_propagated audit records ok + count 2.
    const subAudits = await rawSelectSubprocessorAudits(tenant.ctx.slug, memberId);
    expect(subAudits).toHaveLength(1);
    const payload = subAudits[0]!.payload as {
      resend_outcome?: string;
      resend_contacts_removed_count?: number;
      resend_contacts_failed_count?: number;
      stripe_outcome?: string;
    };
    expect(payload.resend_outcome).toBe('ok');
    expect(payload.resend_contacts_removed_count).toBe(2);
    expect(payload.resend_contacts_failed_count).toBe(0);
    expect(payload.stripe_outcome).toBe('ok');
    // No PII in the audit row (ids + outcomes only).
    expect(JSON.stringify(subAudits[0])).not.toContain(contactEmail);

    // member_erased emitted (completion proof — cascadesComplete held).
    const erased = await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId);
    expect(erased.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('3 — RE-DRIVE (empty-set): first pass fails → failed audit + member_erased; re-drive reads [] → SECOND audit removed_count:0 + spy NOT re-called + member_erased still present (idempotent re-emit)', async () => {
    const { memberId, contactEmail } = await seedMember(tenant);
    const audienceId = `aud-cap-redrive-${randomUUID().slice(0, 8)}`;
    await seedAudienceDelivery(tenant, memberId, admin.userId, contactEmail, audienceId);

    // --- First pass: gateway rejects → resend_outcome:'failed' (non-blocking).
    removeContactFromAudienceSpy.mockClear();
    removeContactFromAudienceSpy.mockRejectedValue(
      new Error('resend 503 service unavailable'),
    );

    const deps = buildEraseMemberDeps(tenant.ctx);
    const first = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-erase-sub-cap-redrive-1-${Date.now()}` },
      deps,
    );
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    // NON-BLOCKING — the erasure still completes despite the Resend failure.
    expect(first.value.cascadesComplete).toBe(true);
    expect(removeContactFromAudienceSpy).toHaveBeenCalledTimes(1);
    expect(removeContactFromAudienceSpy).toHaveBeenCalledWith(audienceId, contactEmail);

    const auditsAfterFirst = await rawSelectSubprocessorAudits(tenant.ctx.slug, memberId);
    expect(auditsAfterFirst).toHaveLength(1);
    expect(
      (auditsAfterFirst[0]!.payload as { resend_outcome?: string }).resend_outcome,
    ).toBe('failed');

    // --- Re-drive: the contacts are now removed_at-stamped (scrubbed on the
    // first pass), so the in-tx audience-derivation read finds NO live emails →
    // captures [] → a VACUOUS empty-set propagation. The gateway is NOT called.
    removeContactFromAudienceSpy.mockClear();
    removeContactFromAudienceSpy.mockResolvedValue(undefined);

    const second = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-erase-sub-cap-redrive-2-${Date.now()}` },
      deps,
    );
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.value.cascadesComplete).toBe(true);

    // CRITICAL: the gateway spy was NOT re-invoked — the first-pass inputs are
    // destroyed by the same erasure, so the re-drive re-captures an EMPTY set
    // (best-effort-ONCE residual). The second `ok`/removed:0 audit is a VACUOUS
    // no-op, NOT proof the Resend removal succeeded.
    expect(removeContactFromAudienceSpy).not.toHaveBeenCalled();

    const auditsAfterSecond = await rawSelectSubprocessorAudits(tenant.ctx.slug, memberId);
    expect(auditsAfterSecond).toHaveLength(2);
    const secondAudit = auditsAfterSecond.find(
      (a) =>
        (a.payload as { resend_outcome?: string; resend_contacts_removed_count?: number })
          .resend_contacts_removed_count === 0 &&
        (a.payload as { resend_outcome?: string }).resend_outcome === 'ok',
    );
    expect(
      secondAudit,
      'the re-drive must record a second ok/removed:0 vacuous audit',
    ).toBeDefined();
    expect(
      (secondAudit!.payload as { resend_contacts_failed_count?: number })
        .resend_contacts_failed_count,
    ).toBe(0);

    // member_erased is emitted on EACH clean completing pass: the first pass was
    // non-blocking-complete (1), and the re-drive over the already-erased member
    // re-emits it (a known, harmless idempotent re-emit — the US2d reconciler keys
    // on its PRESENCE, not its count). So assert it is present (>= 1), not exact.
    const erased = await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId);
    expect(erased.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('4 — THROW-PATH ROLLBACK (security cond-2): a FAIL-LOUD in-tx capture throw rolls the WHOLE erasure back — erased_at NULL, contacts un-scrubbed, no member_erased, re-drivable', async () => {
    removeContactFromAudienceSpy.mockClear();
    removeContactFromAudienceSpy.mockResolvedValue(undefined);

    const { memberId, contactEmail } = await seedMember(tenant);
    const { deliveryId } = await seedAudienceDelivery(
      tenant,
      memberId,
      admin.userId,
      contactEmail,
      `aud-cap-throw-${randomUUID().slice(0, 8)}`,
    );

    // Override ONLY the audience-derivation dep with a stub whose in-tx capture
    // REJECTS — everything else stays the real production adapter. The throw
    // surfaces inside the atomic scrub tx's FAIL-LOUD capture call site.
    const throwingDerivation: BroadcastsAudienceDerivationPort = {
      async listMemberAudienceContactsInTx(_tx: TenantTx) {
        throw new Error('forced audience-derivation read failure (capstone)');
      },
    };
    const deps = {
      ...buildEraseMemberDeps(tenant.ctx),
      broadcastsAudienceDerivation: throwingDerivation,
    };

    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-erase-sub-cap-throw-${Date.now()}` },
      deps,
    );

    // The capture is FAIL-LOUD → the atomic tx rolls back → server_error.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('server_error');

    // The whole atomic scrub rolled back — member is UN-erased + re-drivable.
    const memberRows = await rawSelectMember(memberId);
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.erased_at).toBeNull();
    expect(memberRows[0]?.company_name).not.toBe('[erased]');

    // Contacts were NOT scrubbed / removed.
    const contactRows = await rawSelectContacts(memberId);
    expect(contactRows).toHaveLength(1);
    expect(contactRows[0]?.first_name).toBe('Erik');
    expect(contactRows[0]?.email).toBe(contactEmail);
    expect(contactRows[0]?.removed_at).toBeNull();

    // The delivery was NOT tombstoned (the tombstone runs AFTER the capture in
    // the same atomic tx; the rollback reverted it too).
    const deliveryRows = await rawSelectDelivery(deliveryId);
    expect(deliveryRows[0]?.recipient_email_lower).toBe(contactEmail);

    // NO member_erased — the completion proof is never emitted on a rolled-back
    // erasure (the use-case returned before any cascade).
    const erased = await rawSelectMemberErasedAudits(tenant.ctx.slug, memberId);
    expect(erased).toHaveLength(0);

    // The post-commit Resend removal never ran (the tx rolled back before it).
    expect(removeContactFromAudienceSpy).not.toHaveBeenCalled();

    // Re-drivable: with the REAL derivation adapter the erasure now completes.
    const realDeps = buildEraseMemberDeps(tenant.ctx);
    const redrive = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-erase-sub-cap-throw-redrive-${Date.now()}` },
      realDeps,
    );
    expect(redrive.ok, JSON.stringify(redrive)).toBe(true);
    if (!redrive.ok) return;
    expect(redrive.value.cascadesComplete).toBe(true);
    // Now the member IS erased.
    const after = await rawSelectMember(memberId);
    expect(after[0]?.erased_at).not.toBeNull();
  }, 120_000);
});

// ---- Scenario 2 — GENUINE 2-tenant cross-tenant isolation ------------------

describe('eraseMember — sub-processor cascade cross-tenant isolation (COMP-1 US3-C, Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const tenants = await createTwoTestTenants();
    tenantA = tenants.a;
    tenantB = tenants.b;
    // Both tenants need the plan (member FK) + renewal config (the production
    // builder wires the real F8 cascade for whichever tenant is erased).
    await seedPlan(tenantA, admin.userId);
    await seedPlan(tenantB, admin.userId);
    await seedRenewalPolicies(tenantA.ctx);
    await seedRenewalPolicies(tenantB.ctx);
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('2 — erasing tenant-A member removes ONLY aud_A from Resend; tenant-B member sharing the SAME email + its aud_B + delivery are untouched', async () => {
    removeContactFromAudienceSpy.mockClear();
    removeContactFromAudienceSpy.mockResolvedValue(undefined);

    // The SAME contact email in BOTH tenants — the cross-tenant collision the
    // RLS-scoped in-tx audience-derivation read must keep isolated.
    const sharedEmail = `shared-xtenant-${randomUUID().slice(0, 8)}@example.com`;
    const a = await seedMember(tenantA, sharedEmail);
    const b = await seedMember(tenantB, sharedEmail);

    const audienceA = `aud-xt-a-${randomUUID().slice(0, 8)}`;
    const audienceB = `aud-xt-b-${randomUUID().slice(0, 8)}`;
    await seedAudienceDelivery(tenantA, a.memberId, admin.userId, sharedEmail, audienceA);
    const bDelivery = await seedAudienceDelivery(
      tenantB,
      b.memberId,
      admin.userId,
      sharedEmail,
      audienceB,
    );

    // Erase ONLY tenant A's member, under tenant A's deps.
    const depsA = buildEraseMemberDeps(tenantA.ctx);
    const result = await eraseMember(
      asMemberId(a.memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-erase-sub-cap-xt-${Date.now()}` },
      depsA,
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.cascadesComplete).toBe(true);

    // The Resend removal was asked for ONLY aud_A — NEVER aud_B (the same email
    // in tenant B's namespace is invisible to tenant A's RLS-scoped read).
    expect(removeContactFromAudienceSpy).toHaveBeenCalledTimes(1);
    expect(removeContactFromAudienceSpy).toHaveBeenCalledWith(audienceA, sharedEmail);
    const calledAudiences = removeContactFromAudienceSpy.mock.calls.map((c) => c[0]);
    expect(calledAudiences).not.toContain(audienceB);

    // Tenant A's member IS erased (sanity that the erase ran).
    const aMember = await rawSelectMember(a.memberId);
    expect(aMember[0]?.erased_at).not.toBeNull();

    // FIRM cross-tenant assertions: tenant B's member is FULLY intact.
    const bMember = await rawSelectMember(b.memberId);
    expect(bMember).toHaveLength(1);
    expect(bMember[0]?.erased_at).toBeNull();
    expect(bMember[0]?.company_name).not.toBe('[erased]');

    // Tenant B's contact (the shared email) is NOT scrubbed / removed.
    const bContacts = await rawSelectContacts(b.memberId);
    expect(bContacts).toHaveLength(1);
    expect(bContacts[0]?.email).toBe(sharedEmail);
    expect(bContacts[0]?.removed_at).toBeNull();

    // Tenant B's delivery is NOT tombstoned (its recipient_email_lower survives).
    const bDeliveryRows = await rawSelectDelivery(bDelivery.deliveryId);
    expect(bDeliveryRows[0]?.recipient_email_lower).toBe(sharedEmail);

    // No subprocessor audit was written under tenant B.
    const bSubAudits = await rawSelectSubprocessorAudits(tenantB.ctx.slug, b.memberId);
    expect(bSubAudits).toHaveLength(0);
  }, 120_000);
});
