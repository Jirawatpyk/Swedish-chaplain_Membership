/**
 * COMP-1 US2c (Task 6, capstone) — end-to-end live-Neon proof that
 * `eraseMember` HARD-DELETES every F6 event registration matched to an erased
 * member (each carries the attendee's email / name / company), crediting back
 * any consumed benefit quota per registration, and leaves NO residual attendee
 * PII anywhere in `event_registrations` (GDPR Art. 17 / PDPA §33; spec §5 F6
 * row + §10 "F6 fan-out throw-path" oracle).
 *
 * US2c adds the F6 registration fan-out cascade: a post-commit, best-effort,
 * idempotent step that enumerates every registration `matched_member_id = M`
 * (`listMemberRegistrationsInTx`) and loops the existing single-registration
 * `eraseAttendeePii` once per row — each in its OWN `runInTenant` tx so one
 * failure does not roll back the others. `eraseAttendeePii` per registration:
 * acquires the per-(tenant, member, event) advisory lock, emits a
 * `quota_credit_back_archive` audit per consumed scope, emits
 * `pii_erasure_requested` + `pii_erasure_completed`, and HARD-DELETES the row.
 *
 * This test wires the WHOLE chain — the PRODUCTION composition root
 * `buildEraseMemberDeps(ctx.tenant)` (the REAL `eventRegistrationErasureAdapter`
 * → real `eraseAllRegistrationsForMember` → real
 * `makeEraseAllRegistrationsForMemberDeps` → real `listMemberRegistrationsInTx`
 * + real `eraseAttendeePii` per registration, alongside the REAL F7/F8 cancel +
 * F1 user-erasure + F7 content-scrub cascades) — against live Neon, on a member
 * who has 3 matched registrations across 2 events (≥1 counted against
 * partnership so a credit-back audit fires). The member has NO linked F1 login
 * and NO in-flight broadcast / renewal cycle, so the F1/F7/F8 cascades return
 * clean-with-zero and the F6 fan-out cascade is the subject under test
 * (cascadesComplete stays true on its own success).
 *
 * A SECOND member's registration on the same tenant must survive untouched
 * (cross-member isolation — the member-keyed `matched_member_id` WHERE clause
 * must not over-delete).
 *
 * Oracle (spec §5 F6 + §10):
 *   1. all 3 of M's registrations are GONE (`matched_member_id = M` → 0 rows) —
 *      hard-deleted, not soft / pseudonymised.
 *   2. the OTHER member's registration is UNTOUCHED — attendee data intact.
 *   3. `pii_erasure_completed` audits = 3 (one per registration);
 *      `quota_credit_back_archive` ≥ 1 (the partnership-counted reg);
 *      `member_erased` present (cascade clean); `cascadesComplete: true`.
 *   4. NO residual attendee email for M anywhere in `event_registrations`
 *      (a serialized dump of all the member's seeded attendee emails is absent,
 *      with a before-present sanity).
 *
 * The cascade already exists (Tasks 1-5) so this capstone passes on first green
 * — correct for a verification oracle. A confirm-can-fail (weaken assertion 1
 * to expect the registrations to still exist) was run and observed RED, then
 * restored.
 *
 * Reuses the live-Neon harness shared by `erase-member-f7-content.test.ts`
 * (production `buildEraseMemberDeps` + inline plan/fee + renewal-policy seed +
 * BYPASSRLS raw select) and the registration seed shape from
 * `tests/integration/events/list-member-registrations.test.ts` +
 * `tests/integration/events/pii-erasure.test.ts`. No mocks — the production
 * builder + real cascades are the point.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  events,
  eventRegistrations,
  type NewEventRow,
  type NewEventRegistrationRow,
} from '@/modules/events/infrastructure/schema';
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

const PLAN_ID = 'test-erase-f6-regs-plan';

// ---- Plan + invoice-settings seed (production builder needs both well-formed) ----

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
      planName: { en: 'Erase F6 Regs Plan' },
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
 * Seed a member M (rich PII) + a primary contact (NO linked F1 user — so the
 * F1 user-erasure cascade is a clean no-op and the F6 fan-out is the subject
 * under test). NO in-flight F7 broadcast / F8 cycle.
 */
async function seedMember(
  tenant: TestTenant,
): Promise<{ memberId: string; contactEmail: string }> {
  const memberId = randomUUID();
  const contactEmail = `erik-f6-${randomUUID().slice(0, 8)}@example.com`;
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `F6 Erase Co ${Date.now()}`,
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: '0105536000123',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
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

/** Seed a parent event row (FK target for registrations). */
async function seedEvent(tenant: TestTenant, name: string): Promise<string> {
  const eventId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: `ext_${randomUUID()}`,
      name,
      startDate: new Date('2026-07-21T18:00:00Z'),
    } satisfies NewEventRow),
  );
  return eventId;
}

/**
 * Seed a registration matched to `memberId` on `eventId`, with a DISTINCTIVE
 * attendee email. `countedAgainstPartnership` flips the per-registration
 * quota credit-back audit (the CHECK `event_registrations_non_member_no_quota`
 * permits the quota flags because `match_type = 'member_contact'` is not in
 * (`non_member`,`unmatched`)).
 *
 * Returns `{ registrationId, attendeeEmail }`.
 */
async function seedRegistration(
  tenant: TestTenant,
  memberId: string,
  eventId: string,
  opts: { attendeeEmail: string; countedAgainstPartnership?: boolean },
): Promise<{ registrationId: string; attendeeEmail: string }> {
  const registrationId = randomUUID();
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(eventRegistrations).values({
      tenantId: tenant.ctx.slug,
      registrationId,
      eventId,
      externalId: `att_${randomUUID()}`,
      attendeeEmail: opts.attendeeEmail,
      attendeeName: 'Erik Eriksson',
      attendeeCompany: 'F6 Erase Co',
      matchType: 'member_contact',
      matchedMemberId: memberId,
      countedAgainstPartnership: opts.countedAgainstPartnership ?? false,
      countedAgainstCulturalQuota: false,
      registeredAt: new Date(),
    } as unknown as NewEventRegistrationRow),
  );
  return { registrationId, attendeeEmail: opts.attendeeEmail };
}

// ---- Raw (BYPASSRLS) reads -------------------------------------------------

/** Rows matched to the member — the §10 "all gone" oracle. */
async function rawSelectRegistrationsForMember(
  tenantSlug: string,
  memberId: string,
) {
  return db
    .select()
    .from(eventRegistrations)
    .where(
      and(
        eq(eventRegistrations.tenantId, tenantSlug),
        eq(eventRegistrations.matchedMemberId, memberId),
      ),
    );
}

/** A specific registration by id (for the "other member untouched" oracle). */
async function rawSelectRegistrationById(registrationId: string) {
  return db
    .select()
    .from(eventRegistrations)
    .where(eq(eventRegistrations.registrationId, registrationId));
}

/** Full registration rows for the seeded ids (serialised for the §10 dump). */
async function rawSelectRegistrationsByIds(registrationIds: readonly string[]) {
  if (registrationIds.length === 0) return [];
  return db
    .select()
    .from(eventRegistrations)
    .where(inArray(eventRegistrations.registrationId, [...registrationIds]));
}

/**
 * `pii_erasure_completed` audit rows for the tenant whose payload.registrationId
 * is in the set. The `event_type` is filtered in JS (not the typed `eq` on the
 * pgEnum column): `pii_erasure_completed` is an F6 audit type stored in the
 * shared `audit_log` table but absent from the auth-module pgEnum union, so a
 * typed `eq(auditLog.eventType, 'pii_erasure_completed')` does not type-check.
 * This mirrors `tests/integration/events/pii-erasure.test.ts`.
 */
async function rawSelectErasureCompletedAudits(
  tenantSlug: string,
  registrationIds: readonly string[],
) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantSlug));
  const idSet = new Set(registrationIds);
  return rows.filter(
    (r) =>
      String(r.eventType) === 'pii_erasure_completed' &&
      idSet.has(
        String(
          (r.payload as { registrationId?: string } | null)?.registrationId,
        ),
      ),
  );
}

/** `quota_credit_back_archive` audit rows for the tenant whose payload.registrationId is in the set (F6 type → JS-filtered, see above). */
async function rawSelectCreditBackAudits(
  tenantSlug: string,
  registrationIds: readonly string[],
) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantSlug));
  const idSet = new Set(registrationIds);
  return rows.filter(
    (r) =>
      String(r.eventType) === 'quota_credit_back_archive' &&
      idSet.has(
        String(
          (r.payload as { registrationId?: string } | null)?.registrationId,
        ),
      ),
  );
}

/** `member_erased` audit rows for the tenant whose payload.member_id matches. */
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

// ---- Test suite ------------------------------------------------------------

describe('eraseMember — hard-deletes all F6 registrations matched to an erased member, leaving no residual attendee PII (COMP-1 US2c, live Neon, production deps)', () => {
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

  it('hard-deletes all 3 of M\'s registrations across 2 events + credits back partnership quota + emits 3 pii_erasure_completed + member_erased, completes — leaving the OTHER member untouched and no residual attendee email', async () => {
    // The F6 oracle keys on the per-registration attendee emails (the PII the
    // fan-out hard-deletes), not the member's contact email — so we ignore the
    // contactEmail the seeder returns.
    const { memberId } = await seedMember(tenant);
    const { memberId: otherMemberId } = await seedMember(tenant);
    expect(otherMemberId).not.toBe(memberId);

    // Two events; member M has 2 registrations on eventA + 1 on eventB. The
    // eventA[0] registration is counted against partnership → a credit-back
    // audit must fire for it.
    const eventA = await seedEvent(tenant, 'Event A');
    const eventB = await seedEvent(tenant, 'Event B');

    const mEmail1 = `m-a1-${randomUUID().slice(0, 8)}@example.com`;
    const mEmail2 = `m-a2-${randomUUID().slice(0, 8)}@example.com`;
    const mEmail3 = `m-b1-${randomUUID().slice(0, 8)}@example.com`;

    const regA1 = await seedRegistration(tenant, memberId, eventA, {
      attendeeEmail: mEmail1,
      countedAgainstPartnership: true, // ≥1 counted → credit-back audit fires
    });
    const regA2 = await seedRegistration(tenant, memberId, eventA, {
      attendeeEmail: mEmail2,
    });
    const regB1 = await seedRegistration(tenant, memberId, eventB, {
      attendeeEmail: mEmail3,
    });
    const mRegistrationIds = [
      regA1.registrationId,
      regA2.registrationId,
      regB1.registrationId,
    ];

    // A registration matched to a DIFFERENT member on eventA — MUST survive.
    const otherEmail = `other-${randomUUID().slice(0, 8)}@example.com`;
    const otherReg = await seedRegistration(tenant, otherMemberId, eventA, {
      attendeeEmail: otherEmail,
    });

    // Sanity: BEFORE erasure all 3 of M's registrations exist + carry the
    // distinctive attendee emails (so the absence assertions are meaningful,
    // not vacuously true), and the other member's row exists.
    const beforeMRegs = await rawSelectRegistrationsForMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(beforeMRegs).toHaveLength(3);
    const beforeDump = JSON.stringify(beforeMRegs);
    expect(beforeDump).toContain(mEmail1);
    expect(beforeDump).toContain(mEmail2);
    expect(beforeDump).toContain(mEmail3);
    expect(
      (await rawSelectRegistrationById(otherReg.registrationId)).length,
    ).toBe(1);

    // PRODUCTION composition root — REAL F1/F7/F8 + REAL F6 registration fan-out.
    const requestId = `rq-erase-f6-regs-${Date.now()}`;
    const deps = buildEraseMemberDeps(tenant.ctx);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId },
      deps,
    );

    // 3 (part 1). cascadesComplete — every cascade clean (no in-flight F7/F8 +
    //   no linked login → ok-zero; F6 fan-out hard-deleted all 3) →
    //   member_erased emitted.
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.cascadesComplete).toBe(true);

    // 1. All 3 of M's registrations are GONE — hard-deleted (the F6 fan-out
    //    calls registrationsRepo.hardDelete, not a soft / pseudonymise path).
    const afterMRegs = await rawSelectRegistrationsForMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(afterMRegs).toHaveLength(0);

    // 2. The OTHER member's registration is UNTOUCHED — its attendee data is
    //    intact, member-keyed WHERE-clause did NOT over-delete.
    const otherRows = await rawSelectRegistrationById(otherReg.registrationId);
    expect(otherRows).toHaveLength(1);
    const otherRow = otherRows[0]!;
    expect(otherRow.matchedMemberId).toBe(otherMemberId);
    expect(otherRow.attendeeEmail).toBe(otherEmail);

    // 3 (part 2). Audits: 3 pii_erasure_completed (one per registration);
    //   ≥1 quota_credit_back_archive (the partnership-counted reg);
    //   member_erased present (completion proof — cascadesComplete held).
    const completedAudits = await rawSelectErasureCompletedAudits(
      tenant.ctx.slug,
      mRegistrationIds,
    );
    expect(
      completedAudits.length,
      'expected exactly 3 pii_erasure_completed audits — one per registration',
    ).toBe(3);
    expect(new Set(completedAudits.map((r) =>
      String((r.payload as { registrationId?: string }).registrationId),
    ))).toEqual(new Set(mRegistrationIds));

    const creditBacks = await rawSelectCreditBackAudits(
      tenant.ctx.slug,
      mRegistrationIds,
    );
    expect(
      creditBacks.length,
      'expected ≥1 quota_credit_back_archive (the partnership-counted reg)',
    ).toBeGreaterThanOrEqual(1);
    // The credit-back belongs to the partnership-counted registration (regA1).
    expect(
      creditBacks.some(
        (r) =>
          String((r.payload as { registrationId?: string }).registrationId) ===
            regA1.registrationId &&
          (r.payload as { scope?: string }).scope === 'partnership',
      ),
    ).toBe(true);

    const memberErasedAudits = await rawSelectMemberErasedAudits(
      tenant.ctx.slug,
      memberId,
    );
    expect(
      memberErasedAudits.length,
      'expected the member_erased completion-proof audit (cascadesComplete held)',
    ).toBeGreaterThanOrEqual(1);

    // 4. NO residual attendee email for M anywhere in `event_registrations`.
    //    The rows are hard-deleted, so a dump of the seeded ids is empty AND
    //    contains none of M's distinctive attendee emails. The other member's
    //    email is NOT in M's set, so we don't assert on it here (covered by 2).
    const remainingMById = await rawSelectRegistrationsByIds(mRegistrationIds);
    expect(remainingMById).toHaveLength(0);
    const residualDump = JSON.stringify(remainingMById);
    expect(residualDump).not.toContain(mEmail1);
    expect(residualDump).not.toContain(mEmail2);
    expect(residualDump).not.toContain(mEmail3);
  }, 120_000);
});
