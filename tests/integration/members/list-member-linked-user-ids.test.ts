/**
 * COMP-1 US3-D (Task 1) — Integration: `listMemberLinkedUserIds` against live
 * Neon.
 *
 * The DPO erasure-evidence use-case (US3-D Task 3) binds the tenant-NULL
 * `user_erased` audit arm to a specific member via the member's linked-login
 * user ids. This free function delegates to the UNFILTERED
 * `listAllLinkedUserIdsForMemberInTx` (it deliberately includes logins on
 * `removed_at`-stamped contact rows, so the evidence binding still resolves
 * after the erasure scrub). Two cases:
 *   1. member with a linked login → [that user id]
 *   2. member with no linked login → []
 *
 * Integration (not unit) — same convention as `getMemberErasureStatus`
 * (`member-erasure-status.test.ts`): the read runs a live tenant-scoped
 * `runInTenant` + a real contacts SELECT, so a unit mock would not exercise
 * the RLS-scoped query path that is the whole point. Reuses the live-Neon
 * harness shared by `erase-member-linked-user-shadow.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  asMemberId,
  type MemberId,
  listMemberLinkedUserIds,
} from '@/modules/members';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---- Test scaffold ---------------------------------------------------------

const PLAN_ID = 'test-linked-user-ids-plan';

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
      planName: { en: 'Linked User Ids Plan' },
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

/** Seed a member + (optional) a primary contact linked to a real F1 user. */
async function seedMember(
  tenant: TestTenant,
  linkedUserId: string | null,
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Linked User Ids Co ${Date.now()}`,
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Anna',
      lastName: 'Andersson',
      email: `anna-${randomUUID().slice(0, 8)}@example.com`,
      isPrimary: true,
      linkedUserId,
      removedAt: null,
    });
  });
  return memberId;
}

// ---- Test suite ------------------------------------------------------------

describe('listMemberLinkedUserIds — live-Neon read (COMP-1 US3-D)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let linkedUser: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    linkedUser = await createActiveTestUser('member');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
    await deleteTestUser(linkedUser).catch(() => {});
  });

  it('returns the member’s linked user id', async () => {
    const memberId = await seedMember(tenant, linkedUser.userId);

    const ids = await listMemberLinkedUserIds(
      tenant.ctx,
      asMemberId(memberId) as MemberId,
    );

    expect(ids).toEqual([linkedUser.userId]);
  }, 30_000);

  it('returns [] for a member with no linked login', async () => {
    const memberId = await seedMember(tenant, null);

    const ids = await listMemberLinkedUserIds(
      tenant.ctx,
      asMemberId(memberId) as MemberId,
    );

    expect(ids).toEqual([]);
  }, 30_000);
});
