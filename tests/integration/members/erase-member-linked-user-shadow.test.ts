/**
 * COMP-1 US2a (Task 6, Critical security fix) — Integration: the UNFILTERED F1
 * erasure work-list read survives the contacts `removed_at` scrub, against live
 * Neon.
 *
 * The bug this nets: the F1 linked-login erasure work-list used to read the
 * FILTERED `listLinkedUserIdsForMemberInTx` (`removed_at IS NULL`). The contacts
 * scrub (`scrubPiiForMemberInTx`) stamps `removed_at` on every contact but
 * PRESERVES `linked_user_id`. So once the scrub has committed, the filtered read
 * returns `[]` — and on a US2d reconciler RE-DRIVE the F1 loop would silently
 * skip a login that FAILED to erase on a prior pass while `member_erased` was
 * emitted as "complete" → the erased member's credential survives forever
 * (Art.17 credential survival).
 *
 * The fix reads `listAllLinkedUserIdsForMemberInTx` (UNFILTERED by removed_at).
 * This test PROVES the shadow can't hide the login on a REAL UPDATE: it seeds a
 * member + a contact linked to a real `users` row, runs the REAL contacts scrub
 * path (`scrubPiiForMemberInTx`) to stamp `removed_at`, then asserts:
 *   - the FILTERED read now returns [] (the removed_at shadow — control); AND
 *   - the UNFILTERED read STILL returns the linked id (the fix).
 *
 * Mock-only suites can't catch this — the `removed_at` UPDATE only shadows the
 * SELECT against a live tx snapshot (per the security review). Confirm-can-fail:
 * temporarily point the unfiltered assertion at the OLD
 * `listLinkedUserIdsForMemberInTx` → it returns [] → the test fails → restore.
 *
 * Reuses the live-Neon harness shared by `erase-member-cascade.test.ts`
 * (tenant + fee/plan seed + linked-contact seed + real `users` row). No mocks
 * for the read under test — the live UPDATE+SELECT in the same tx is the point.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { asMemberId } from '@/modules/members';
import { drizzleContactRepo } from '@/modules/members/infrastructure/db/drizzle-contact-repo';
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

const PLAN_ID = 'test-erase-shadow-plan';

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
      planName: { en: 'Erase Shadow Plan' },
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

/** Seed a member + a primary contact linked to a real F1 user. */
async function seedMemberWithLinkedContact(
  tenant: TestTenant,
  linkedUserId: string,
): Promise<{ memberId: string; contactId: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Shadow Co ${Date.now()}`,
      country: 'TH',
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
      email: `erik-shadow-${randomUUID().slice(0, 8)}@example.com`,
      phone: '+66812345678',
      roleTitle: 'CEO',
      preferredLanguage: 'sv',
      isPrimary: true,
      dateOfBirth: '1980-01-01',
      linkedUserId,
      removedAt: null,
    });
  });
  return { memberId, contactId };
}

// ---- Test suite ------------------------------------------------------------

describe('listAllLinkedUserIdsForMemberInTx — survives the removed_at scrub shadow (US2a)', () => {
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
    await deleteTestUser(linkedUser).catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  });

  it('still returns the linked id AFTER the contacts scrub stamps removed_at (filtered read goes []; unfiltered does not)', async () => {
    const { memberId } = await seedMemberWithLinkedContact(
      tenant,
      linkedUser.userId,
    );

    await runInTenant(tenant.ctx, async (tx) => {
      // Sanity: BEFORE the scrub, both reads see the linked login.
      const beforeFiltered = await drizzleContactRepo.listLinkedUserIdsForMemberInTx(
        tx,
        asMemberId(memberId),
      );
      const beforeAll = await drizzleContactRepo.listAllLinkedUserIdsForMemberInTx(
        tx,
        asMemberId(memberId),
      );
      expect(beforeFiltered).toContain(linkedUser.userId);
      expect(beforeAll).toContain(linkedUser.userId);

      // Run the REAL contacts scrub — stamps removed_at on every contact (and
      // PRESERVES linked_user_id). This is the exact UPDATE the erasure flow
      // runs; here it shadows the linked-user SELECT in the same tx snapshot.
      const scrub = await drizzleContactRepo.scrubPiiForMemberInTx(
        tx,
        asMemberId(memberId),
        { erasedAt: new Date() },
      );
      expect(scrub.ok, JSON.stringify(scrub)).toBe(true);

      // CONTROL: the FILTERED read now returns [] — the removed_at shadow
      // hides the login. This is the exact gap the bug exploited on a re-drive.
      const afterFiltered = await drizzleContactRepo.listLinkedUserIdsForMemberInTx(
        tx,
        asMemberId(memberId),
      );
      expect(afterFiltered).not.toContain(linkedUser.userId);
      expect(afterFiltered).toHaveLength(0);

      // THE FIX: the UNFILTERED read STILL returns the linked id even though
      // the contact row carries removed_at — so a US2d reconciler re-drive
      // re-discovers (and re-attempts) the login. A mock-only suite can't
      // catch this; only a live UPDATE+SELECT in the same tx does.
      const afterAllRead = await drizzleContactRepo.listAllLinkedUserIdsForMemberInTx(
        tx,
        asMemberId(memberId),
      );
      expect(afterAllRead).toContain(linkedUser.userId);
    });
  }, 30_000);
});
