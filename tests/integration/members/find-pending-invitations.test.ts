/**
 * C6 round-10 ui-design-specialist — integration test for the
 * `MemberRepo.findPendingInvitationsForMember` cross-schema join
 * (auth.invitations × members.contacts).
 *
 * Covers the 4 minimal cases the inline-badge UI relies on:
 *   1. Happy path — a contact with a pending invitation surfaces.
 *   2. Expired invitation — `expires_at <= NOW()` filtered out.
 *   3. Consumed invitation — `consumed_at IS NOT NULL` filtered out.
 *   4. Removed contact — `contacts.removed_at IS NOT NULL` filtered out.
 *
 * Plus 2 additional asserts the round-10 critique highlighted:
 *   5. Multiple pending invitations sort soonest-to-expire first
 *      (`expiresAt ASC`). Migration 0017 hides `created_at` from
 *      chamber_app so `expires_at` is the only stable sort key
 *      available — soonest-to-expire is the most actionable order
 *      for admins reviewing the badge cluster.
 *   6. Tenant isolation — invitations linked to contacts in another
 *      tenant don't leak via the cross-schema join.
 *
 * Live Neon Singapore against the same throwaway-tenant pattern as
 * archive-cascade.test.ts. No mocks — the cross-schema JOIN behaves
 * identically in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invitations } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const PLAN_ID = 'test-pending-inv-plan';

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

async function seedPlan(tenantSlug: string, userId: string) {
  await runInTenant({ slug: tenantSlug } as never, async (tx) => {
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: tenantSlug,
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
      tenantId: tenantSlug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Pending Inv Plan' },
      description: { en: '' },
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
      createdBy: userId,
      updatedBy: userId,
    });
  });
}

async function seedMemberWithContact(
  tenant: TestTenant,
  opts: {
    linkedUserId?: string | null;
    removedAt?: Date | null;
    contactEmail?: string;
  } = {},
): Promise<{ memberId: MemberId; contactId: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: `PendingInvCo ${Date.now()}-${memberId.slice(0, 6)}`,
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      registrationDate: new Date().toISOString().slice(0, 10),
      registrationFeePaid: false,
      status: 'active',
      archivedAt: null,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Pending',
      lastName: 'Invitee',
      email:
        opts.contactEmail ??
        `inv-${randomUUID().slice(0, 8)}@example.com`,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: true,
      dateOfBirth: null,
      linkedUserId: opts.linkedUserId ?? null,
      removedAt: opts.removedAt ?? null,
    });
  });
  return { memberId: asMemberId(memberId), contactId };
}

async function seedInvitation(
  userId: string,
  invitedByUserId: string,
  opts: {
    createdAt?: Date;
    expiresAt?: Date;
    consumedAt?: Date | null;
  } = {},
): Promise<string> {
  const invitationId = `inv-${randomUUID().replace(/-/g, '')}`;
  const now = new Date();
  await db.insert(invitations).values({
    id: invitationId,
    userId,
    invitedByUserId,
    intendedRole: 'member',
    createdAt: opts.createdAt ?? now,
    expiresAt: opts.expiresAt ?? new Date(now.getTime() + 7 * 86_400_000),
    consumedAt: opts.consumedAt ?? null,
  });
  return invitationId;
}

describe('findPendingInvitationsForMember (C6 round-10)', () => {
  let tenant: TestTenant;
  let adminUser: TestUser;

  beforeAll(async () => {
    adminUser = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    await seedPlan(tenant.ctx.slug, adminUser.userId);
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('happy path — returns 1 row for a contact with a pending invitation', async () => {
    const invitedUser = await createActiveTestUser('member');
    const { memberId, contactId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitedUser.userId,
    });
    await seedInvitation(invitedUser.userId, adminUser.userId);

    const deps = buildMembersDeps(tenant.ctx);
    const result = await deps.memberRepo.findPendingInvitationsForMember(
      tenant.ctx,
      memberId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.contactId).toBe(contactId);
    expect(result.value[0]?.contactEmail).toMatch(/@example\.com$/);
    expect(result.value[0]?.expiresAt).toBeInstanceOf(Date);
  });

  it('expired invitation does NOT surface', async () => {
    const invitedUser = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitedUser.userId,
    });
    // 1 day past
    await seedInvitation(invitedUser.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 8 * 86_400_000),
      expiresAt: new Date(Date.now() - 86_400_000),
    });

    const deps = buildMembersDeps(tenant.ctx);
    const result = await deps.memberRepo.findPendingInvitationsForMember(
      tenant.ctx,
      memberId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('consumed invitation does NOT surface', async () => {
    const invitedUser = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: invitedUser.userId,
    });
    // Future expires_at but consumed
    await seedInvitation(invitedUser.userId, adminUser.userId, {
      consumedAt: new Date(),
    });

    const deps = buildMembersDeps(tenant.ctx);
    const result = await deps.memberRepo.findPendingInvitationsForMember(
      tenant.ctx,
      memberId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('removed contact does NOT surface (even if invitation is pending)', async () => {
    // First seed a primary contact (passing the constraint
    // `contacts_primary_not_removed`), then add a SECOND non-primary
    // contact that's been removed + holds the pending invite.
    const invitedUser = await createActiveTestUser('member');
    const { memberId } = await seedMemberWithContact(tenant, {
      linkedUserId: null,
    });
    // Insert the removed non-primary contact tied to the invited user.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId: memberId as string,
        firstName: 'Removed',
        lastName: 'Person',
        email: `removed-${randomUUID().slice(0, 8)}@example.com`,
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        isPrimary: false,
        dateOfBirth: null,
        linkedUserId: invitedUser.userId,
        removedAt: new Date(),
      });
    });
    await seedInvitation(invitedUser.userId, adminUser.userId);

    const deps = buildMembersDeps(tenant.ctx);
    const result = await deps.memberRepo.findPendingInvitationsForMember(
      tenant.ctx,
      memberId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it('multiple pending invitations sort soonest-to-expire first (expiresAt ASC)', async () => {
    // Two contacts, each with their own pending invitation, one
    // expiring sooner than the other. The repo sorts by `expires_at
    // ASC` (migration 0017 hides `created_at` from chamber_app, so
    // soonest-to-expire is the only stable secondary sort key
    // available).
    const userA = await createActiveTestUser('member');
    const userB = await createActiveTestUser('member');
    const { memberId, contactId: contactA } = await seedMemberWithContact(
      tenant,
      { linkedUserId: userA.userId },
    );
    // Seed a SECOND contact for the same member
    const contactB = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: contactB,
        memberId: memberId as string,
        firstName: 'Second',
        lastName: 'Pending',
        email: `inv-${randomUUID().slice(0, 8)}@example.com`,
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        isPrimary: false,
        dateOfBirth: null,
        linkedUserId: userB.userId,
        removedAt: null,
      });
    });
    // First invitation expires in 7 days
    await seedInvitation(userA.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    // Second invitation expires in 2 days (sooner → should appear first)
    await seedInvitation(userB.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 2 * 86_400_000),
    });

    const deps = buildMembersDeps(tenant.ctx);
    const result = await deps.memberRepo.findPendingInvitationsForMember(
      tenant.ctx,
      memberId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.contactId).toBe(contactB); // expires sooner
    expect(result.value[1]?.contactId).toBe(contactA); // expires later
  });

  it('tenant isolation — invitations for contacts in another tenant do not leak', async () => {
    // Build a SECOND tenant + plan + member + invited user in that tenant.
    // Then query findPendingInvitationsForMember from the first tenant's
    // context with the second tenant's member-id — should return 0.
    const otherTenant = await createTestTenant('test');
    try {
      await seedPlan(otherTenant.ctx.slug, adminUser.userId);
      const otherUser = await createActiveTestUser('member');
      const { memberId: otherMemberId } = await seedMemberWithContact(
        otherTenant,
        { linkedUserId: otherUser.userId },
      );
      await seedInvitation(otherUser.userId, adminUser.userId);

      // Query the foreign member from the FIRST tenant's context.
      const deps = buildMembersDeps(tenant.ctx);
      const result = await deps.memberRepo.findPendingInvitationsForMember(
        tenant.ctx,
        otherMemberId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // RLS on the contacts table blocks the join — 0 rows surface even
      // though auth.invitations holds a pending row for otherUser.
      expect(result.value).toHaveLength(0);
    } finally {
      await otherTenant.cleanup().catch(() => {});
    }
  });
});
