/**
 * Shared seeding helpers for portal-status integration tests
 * (auth `invitations` × members `contacts`/`members`).
 *
 * Extracted 2026-07-23 from `find-pending-invitations.test.ts` (Task 4,
 * `feat/members-portal-status`) — that file keeps its own file-local
 * copies untouched (this is a copy-out-then-share of an already-passing
 * test, not a migration of it). New portal-status tests should import
 * from here instead of re-copying. Two more tasks on the same branch
 * (9 and 13) are expected to reuse these.
 *
 * Never import from outside `tests/integration/**`.
 */
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invitations } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { DEFAULT_TEST_BENEFIT_MATRIX } from './test-benefit-matrix';
import type { TestTenant } from './test-tenant';
import { nextSeedMemberNumber } from './seed-member-number';

/**
 * Seed a minimal active membership plan (+ the `tenant_invoice_settings`
 * row `membership_plans` FK-depends on) for the given tenant. `planId`
 * is caller-supplied so parallel test files never collide on the same
 * plan row within a shared throwaway tenant.
 */
export async function seedPortalPlan(
  tenantSlug: string,
  userId: string,
  planId: string,
): Promise<void> {
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
      planId,
      planYear: 2026,
      planName: { en: 'Portal Status Test Plan' },
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
      benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
      isActive: true,
      createdBy: userId,
      updatedBy: userId,
    });
  });
}

/**
 * Seed a member with one contact. Defaults to a PRIMARY contact (the
 * common case); pass `isPrimary: false` when the test wants the contact
 * to sit alongside a separately-seeded primary (see `addSecondaryContact`
 * below for adding that second contact to an existing member).
 */
export async function seedPortalMemberWithContact(
  tenant: TestTenant,
  planId: string,
  opts: {
    linkedUserId?: string | null;
    removedAt?: Date | null;
    contactEmail?: string;
    isPrimary?: boolean;
    companyName?: string;
  } = {},
): Promise<{ memberId: MemberId; contactId: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName:
        opts.companyName ?? `PortalStatusCo ${Date.now()}-${memberId.slice(0, 6)}`,
      country: 'TH',
      planId,
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
      email: opts.contactEmail ?? `inv-${randomUUID().slice(0, 8)}@example.com`,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: opts.isPrimary ?? true,
      dateOfBirth: null,
      linkedUserId: opts.linkedUserId ?? null,
      removedAt: opts.removedAt ?? null,
    });
  });
  return { memberId: asMemberId(memberId), contactId };
}

/**
 * Add a SECOND (non-primary) contact to an existing member — for tests
 * asserting that a primary-contact-only read ignores a secondary
 * contact's invitation state.
 */
export async function addSecondaryContact(
  tenant: TestTenant,
  memberId: string,
  linkedUserId: string,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Secondary',
      lastName: 'Contact',
      email: `sec-${randomUUID().slice(0, 8)}@example.com`,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId,
      removedAt: null,
    });
  });
}

/**
 * Seed an `invitations` row directly via the OWNER-role `db` singleton
 * (the `chamber_app` role has no INSERT grant on this cross-tenant auth
 * table — see migration 0017). Mirrors `find-pending-invitations.test.ts`.
 */
export async function seedPortalInvitation(
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
