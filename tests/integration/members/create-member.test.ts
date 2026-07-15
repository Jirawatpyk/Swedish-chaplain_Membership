/**
 * T041 — Integration: create-member use case vs live Neon.
 *
 * Covers US1 acceptance:
 *   - happy path: member + primary contact + audit in one tx
 *   - soft-duplicate detection returns typed error on repeat w/o confirm
 *   - confirm_soft_duplicate: true proceeds
 *   - cross-tenant per-email uniqueness holds independently (FR-032)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

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

function goodInput(planId: string) {
  return {
    company_name: `Test Co ${Date.now()}`,
    country: 'TH',
    plan_id: planId,
    plan_year: 2026,
    primary_contact: {
      first_name: 'Anna',
      last_name: 'Andersson',
      email: `anna-${randomUUID().slice(0, 8)}@example.com`,
      preferred_language: 'en' as const,
    },
  };
}

describe('create-member integration (T041, US1)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-premium';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
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
        planId,
        planYear: 2026,
        planName: { en: 'Test Premium' },
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
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    });
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('happy path: creates member + primary contact + audit events', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const input = goodInput(planId);
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}` },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Member row present
    const memberRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, result.value.memberId)),
    );
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]!.companyName).toBe(input.company_name);
    expect(memberRows[0]!.status).toBe('active');

    // Primary contact present
    const contactRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(eq(contacts.contactId, result.value.contactId)),
    );
    expect(contactRows).toHaveLength(1);
    expect(contactRows[0]!.isPrimary).toBe(true);
    expect(contactRows[0]!.email).toBe(input.primary_contact.email);

    // Audit events landed (in same txn)
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.actorUserId, user.userId),
        ),
      );
    const eventTypes = auditRows.map((r) => r.eventType);
    expect(eventTypes).toContain('member_created');
    expect(eventTypes).toContain('contact_created');
  });

  it('rejects creating a member onto a SOFT-DELETED plan → plan_not_found (code-review #9-#14 follow-up)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const deletedPlanId = `test-deleted-${randomUUID().slice(0, 8)}`;
    // Seed a fresh plan (0 members → a legitimate soft-delete) then soft-delete
    // it. `getPlan`/`findOne` still returns the row (deleted_at NOT NULL), so the
    // create path must reject it via the isSoftDeleted guard — never attach a new
    // member to a deleted plan (same rule changePlan enforces).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: deletedPlanId,
        planYear: 2026,
        planName: { en: 'To Be Deleted' },
        description: { en: 'd' },
        sortOrder: 20,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
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
      await tx
        .update(membershipPlans)
        .set({ deletedAt: new Date(), updatedBy: user.userId })
        .where(
          and(
            eq(membershipPlans.planId, deletedPlanId),
            eq(membershipPlans.planYear, 2026),
          ),
        );
    });

    const input = goodInput(deletedPlanId);
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-sd` },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('plan_not_found');

    // No member row was created for this company.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(members)
        .where(eq(members.companyName, input.company_name)),
    );
    expect(rows).toHaveLength(0);
  });

  it('soft-duplicate: repeating (company_name, country) without confirm rejects', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const shared = goodInput(planId);
    // Keep company_name + country identical; use different email
    const first = await createMember(
      shared,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-a` },
      deps,
    );
    expect(first.ok).toBe(true);

    const second = await createMember(
      {
        ...shared,
        primary_contact: {
          ...shared.primary_contact,
          email: `second-${randomUUID().slice(0, 8)}@example.com`,
        },
      },
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-b` },
      deps,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.type).toBe('soft_duplicate');
  });

  it('soft-duplicate: confirm_soft_duplicate=true proceeds', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const shared = goodInput(planId);
    await createMember(
      shared,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-c` },
      deps,
    );
    const confirmed = await createMember(
      {
        ...shared,
        confirm_soft_duplicate: true,
        primary_contact: {
          ...shared.primary_contact,
          email: `confirmed-${randomUUID().slice(0, 8)}@example.com`,
        },
      },
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-d` },
      deps,
    );
    expect(confirmed.ok).toBe(true);
  });

  it('validation: malformed email rejected', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const input = goodInput(planId);
    input.primary_contact.email = 'not-an-email';
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-e` },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_email');
  });

  it('persists notes supplied at create time', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const input = { ...goodInput(planId), notes: 'Introduced by the Swedish embassy' };
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-notes` },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, result.value.memberId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notes).toBe('Introduced by the Swedish embassy');
  });

  it('persists registered capital and sub-district (058 / PR-B)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const input = {
      ...goodInput(planId),
      registered_capital_thb: 5_000_000,
      sub_district: 'คลองตันเหนือ',
      city: 'เขตวัฒนา',
      province: 'กรุงเทพมหานคร',
      postal_code: '10110',
    };
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-capital` },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, result.value.memberId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.registeredCapitalThb).toBe(5_000_000);
    expect(rows[0]!.subDistrict).toBe('คลองตันเหนือ');
  });

  it('rejects a negative registered capital at the database (058 / PR-B)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const input = {
      ...goodInput(planId),
      registered_capital_thb: -1,
    };
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-neg-capital` },
      deps,
    );
    // The zod `nonnegative()` catches this first — that is fine and intended;
    // this test pins the behaviour (create rejects), not the layer.
    expect(result.ok).toBe(false);
  });

  it('defaults is_vat_registered to false and round-trips an explicit true (059 / PR-A)', async () => {
    const deps = buildMembersDeps(tenant.ctx);

    const off = await createMember(
      goodInput(planId),
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-vat-off` },
      deps,
    );
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    const offRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, off.value.memberId)),
    );
    expect(offRows).toHaveLength(1);
    expect(offRows[0]!.isVatRegistered).toBe(false);

    // The tax_id here is not decoration — Task 4 adds the registrant ⇒ TIN
    // invariant, and this test must keep passing once it lands.
    const on = await createMember(
      { ...goodInput(planId), is_vat_registered: true, tax_id: '0105562087242' },
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-vat-on` },
      deps,
    );
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const onRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, on.value.memberId)),
    );
    expect(onRows).toHaveLength(1);
    expect(onRows[0]!.isVatRegistered).toBe(true);
  });

  it('registrant ⇒ TIN: a VAT registrant with NO tax_id is REJECTED, and no row is written (059 / PR-A Task 4)', async () => {
    // The NEGATIVE case, against the real database. Every other proof of this
    // invariant on this branch runs against a mocked `runInTenant` — which can
    // only show that the use case returns an error object, never that the row
    // was not written.
    //
    // ประกาศอธิบดีฯ 196 (buyer TIN) + 199 (สำนักงานใหญ่/สาขา) are a PAIR: both are
    // mandatory of a VAT-registrant buyer. A member stored as
    // `is_vat_registered = true` with no `tax_id` would print the branch line on
    // a §86/4 tax invoice with NO taxpayer number on it — a defective legal
    // document. This is the state that must be unreachable.
    const deps = buildMembersDeps(tenant.ctx);

    const before = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.tenantId, tenant.ctx.slug)),
    );

    const result = await createMember(
      { ...goodInput(planId), is_vat_registered: true, tax_id: null },
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-vat-no-tin` },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('invalid_body');

    // The point of doing this on live Neon: prove nothing landed. A mocked repo
    // cannot tell you that.
    const after = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.tenantId, tenant.ctx.slug)),
    );
    expect(after).toHaveLength(before.length);
  });

  it('validation: bad Thai tax_id checksum rejected', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const input = {
      ...goodInput(planId),
      tax_id: '1234567890122', // checksum mismatch
    };
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-f` },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_tax_id');
  });

  // --- PR-B task 8 — secondary contact -----------------------------------

  it('creates a secondary contact alongside the primary, both audited (PR-B task 8)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const input = {
      ...goodInput(planId),
      secondary_contact: {
        first_name: 'Björn',
        last_name: 'Svensson',
        email: `bjorn-${randomUUID().slice(0, 8)}@example.com`,
        preferred_language: 'sv' as const,
        art14_attested: true as const,
      },
    };
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-sec` },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const memberRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, result.value.memberId)),
    );
    expect(memberRows).toHaveLength(1);

    const contactRows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(contacts)
        .where(eq(contacts.memberId, result.value.memberId)),
    );
    expect(contactRows).toHaveLength(2);
    const primary = contactRows.find((c) => c.isPrimary);
    const secondary = contactRows.find((c) => !c.isPrimary);
    expect(primary?.email).toBe(input.primary_contact.email);
    expect(secondary?.email).toBe(input.secondary_contact.email);
    expect(secondary?.preferredLanguage).toBe('sv');

    // Task 8 (GDPR Art. 14) — the primary contact is first-party (member
    // supplied their own representative), so NULL; the secondary contact's
    // data came from the admin, so its attestation was recorded.
    expect(primary?.art14AttestedAt).toBeNull();
    expect(secondary?.art14AttestedAt).not.toBeNull();
    expect(secondary?.art14AttestedAt).toBeInstanceOf(Date);

    // Both contacts got their OWN contact_created audit row, in the SAME tx.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'contact_created'),
        ),
      );
    const payloads = auditRows.map((r) => r.payload as Record<string, unknown>);
    const forThisMember = payloads.filter(
      (p) => p.member_id === result.value.memberId,
    );
    expect(forThisMember).toHaveLength(2);
    expect(forThisMember.some((p) => p.is_primary === true)).toBe(true);
    expect(forThisMember.some((p) => p.is_primary === false)).toBe(true);
  });

  it('rejects when secondary_contact.email equals primary_contact.email, before touching the DB', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const sharedEmail = `same-${randomUUID().slice(0, 8)}@example.com`;
    const input = {
      ...goodInput(planId),
      primary_contact: { ...goodInput(planId).primary_contact, email: sharedEmail },
      secondary_contact: {
        first_name: 'Dup',
        last_name: 'Email',
        email: sharedEmail,
        preferred_language: 'en' as const,
        art14_attested: true as const,
      },
    };
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-samee` },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('secondary_email_same_as_primary');

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.companyName, input.company_name)),
    );
    expect(rows).toHaveLength(0);
  });

  it('validation: malformed secondary_contact email rejected', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const input = {
      ...goodInput(planId),
      secondary_contact: {
        first_name: 'Bad',
        last_name: 'Email',
        email: 'not-an-email',
        preferred_language: 'en' as const,
        art14_attested: true as const,
      },
    };
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-secbad` },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_secondary_email');
  });

  it('rolls back the member + primary contact as a unit when secondary_contact.email collides with an EXISTING contact (PR-B task 8)', async () => {
    const deps = buildMembersDeps(tenant.ctx);

    // Seed an existing member whose primary contact owns the email that
    // will collide below.
    const collidingEmail = `existing-${randomUUID().slice(0, 8)}@example.com`;
    const seeded = await createMember(
      { ...goodInput(planId), primary_contact: { ...goodInput(planId).primary_contact, email: collidingEmail } },
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-seed` },
      deps,
    );
    expect(seeded.ok).toBe(true);

    // Attempt to create a NEW member whose secondary contact reuses that
    // email. The member row + the primary-contact row for the NEW member
    // must BOTH be inserted successfully first (this is what proves the
    // rollback, not just an early validation short-circuit) before the
    // secondary insert hits `contacts_tenant_email_uniq` and fails.
    const freshPrimaryEmail = `fresh-${randomUUID().slice(0, 8)}@example.com`;
    const newCompanyName = `Rollback Co ${Date.now()}`;
    const input = {
      ...goodInput(planId),
      company_name: newCompanyName,
      primary_contact: {
        first_name: 'Fresh',
        last_name: 'Primary',
        email: freshPrimaryEmail,
        preferred_language: 'en' as const,
      },
      secondary_contact: {
        first_name: 'Colliding',
        last_name: 'Secondary',
        email: collidingEmail,
        preferred_language: 'en' as const,
        art14_attested: true as const,
      },
    };
    const result = await createMember(
      input,
      { actorUserId: user.userId, requestId: `rq-${Date.now()}-rollback` },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('conflict');
      if (result.error.type === 'conflict') {
        expect(result.error.reason).toBe('secondary_email_in_use');
      }
    }

    // No orphan member row for the NEW company.
    const memberRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.companyName, newCompanyName)),
    );
    expect(memberRows).toHaveLength(0);

    // No orphan primary-contact row either — the whole tx rolled back, not
    // just the failing secondary insert.
    const contactRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(contacts).where(eq(contacts.email, freshPrimaryEmail)),
    );
    expect(contactRows).toHaveLength(0);

    // The pre-existing seeded contact is untouched.
    const existingContactRows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(contacts).where(eq(contacts.email, collidingEmail)),
    );
    expect(existingContactRows).toHaveLength(1);
  });
});
