/**
 * 108 T041 review round 4 (F4-#5) — bulk `unarchive` enforces the same rule as
 * the single undelete: a member with no live primary contact is not restored.
 *
 * Migration 0293 exempts a CONTACT-LESS member, so before this gate the Undo of
 * a bulk archive brought such a member back `active` — the state that, since
 * 108 PR-A, silently receives no receipts — while the single undelete refused
 * it with 409 `no_primary_contact`. Live Neon (dev), real use case + repos.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { bulkAction } from '@/modules/members/application/use-cases/bulk-action';
import { buildMembersDeps } from '@/modules/members/members-deps';
import type { MemberId } from '@/modules/members';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('bulk unarchive — no live primary → refused, member stays archived (108 round 4)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
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
        planId: 'test-plan',
        planYear: 2026,
        planName: { en: 'Test Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        createdBy: admin.userId,
        updatedBy: admin.userId,
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
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup();
    await deleteTestUser(admin);
  });

  async function seedArchived(
    shape: 'contactless' | 'no_primary' | 'with_primary',
  ): Promise<MemberId> {
    const memberId = randomUUID() as MemberId;
    const rand = randomUUID().slice(0, 8);
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Bulk Undo ${shape} ${rand}`,
        country: 'TH',
        planId: 'test-plan',
        planYear: 2026,
        status: 'archived',
        archivedAt: new Date(),
      });
      if (shape !== 'contactless') {
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId: randomUUID(),
          memberId,
          firstName: 'Ann',
          lastName: 'Alpha',
          email: `ann-${rand}@example.com`,
          preferredLanguage: 'en',
          isPrimary: shape === 'with_primary',
        });
      }
    });
    return memberId;
  }

  function deps() {
    const full = buildMembersDeps(tenant.ctx);
    return {
      tenant: full.tenant,
      memberRepo: full.memberRepo,
      audit: full.audit,
      clock: full.clock,
      plans: full.plans,
    };
  }

  async function statusOf(memberId: MemberId): Promise<string | undefined> {
    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx.select({ status: members.status }).from(members).where(eq(members.memberId, memberId)),
    );
    return row?.status;
  }

  it.each(['contactless', 'no_primary'] as const)(
    'refuses a %s archived member with state_error{no_primary_contact} and leaves it archived',
    async (shape) => {
      const memberId = await seedArchived(shape);

      const result = await bulkAction(
        { action: 'unarchive', member_ids: [memberId] },
        { actorUserId: admin.userId, requestId: `req-${shape}-${memberId.slice(0, 8)}` },
        deps(),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({
        type: 'state_error',
        memberId,
        code: 'no_primary_contact',
      });
      expect(await statusOf(memberId)).toBe('archived');
    },
    30_000,
  );

  it('still restores an archived member that has its live primary', async () => {
    const memberId = await seedArchived('with_primary');

    const result = await bulkAction(
      { action: 'unarchive', member_ids: [memberId] },
      { actorUserId: admin.userId, requestId: `req-ok-${memberId.slice(0, 8)}` },
      deps(),
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await statusOf(memberId)).toBe('active');
  }, 30_000);
});
