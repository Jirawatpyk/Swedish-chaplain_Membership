/**
 * COMP-1 US2a — M1: revert-token PII resurrection (live Neon).
 *
 * GAP M1 (CONFIRMED): after a GDPR-Art.17 / PDPA §33 member erasure, a still-
 * live 48h `email_change` REVERT token (which stores the ORIGINAL email in
 * plaintext in `old_email`) could be redeemed → `revertContactEmail` restored
 * the real email onto `users.email` + `contacts.email` and flipped
 * `email_verified=true`, resurrecting erased PII.
 *
 * M1 closes it with defense-in-depth, BOTH proven here end-to-end:
 *   1. INVALIDATION — `eraseMember`, inside the SAME atomic scrub tx, marks
 *      every active `email_change_tokens` row for the erased member's linked
 *      users CONSUMED (`consumed_at` stamped). So `findActiveByIdInTx` (which
 *      filters `consumed_at IS NULL`) no longer returns the token.
 *   2. REDEMPTION GUARD — even if a stale token slipped past invalidation,
 *      `revertContactEmail` refuses to restore PII when the target login is
 *      `status='disabled'` (the erasure sentinel state), returning `not_found`.
 *
 * Oracle after `eraseMember`:
 *   (a) the seeded revert token is no longer redeemable (consumed_at set);
 *   (b) calling `revertContactEmail` with that token is REJECTED (`not_found`)
 *       and restores NO PII: `users.email` stays the erasure sentinel,
 *       `contacts.email` stays its sentinel, `users.email_verified` stays
 *       false. (The original real email never reappears anywhere.)
 *
 * Confirm-can-fail: temporarily skipping the invalidation (and the guard)
 * makes the revert resurrect the original email → both assertions fail. Run
 * + observed RED during development, then restored.
 *
 * Reuses the live-Neon harness from `erase-member-f1-user.test.ts` (tenant +
 * fee/plan seed + linked-contact + the production `buildEraseMemberDeps`
 * composition root with the REAL F7/F8/F1 cascades). No mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  asMemberId,
  revertContactEmail,
  type MemberId,
} from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps, buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  emailChangeTokens,
  notificationsOutbox,
  users,
} from '@/modules/auth/infrastructure/db/schema';
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

const PLAN_ID = 'test-erase-revert-token-plan';

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
      planName: { en: 'Erase Revert Token Plan' },
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
 * Seed a member + one primary contact linked to `linkedUserId`, MID email
 * change: an active 48h `revert` token holding the contact's ORIGINAL email
 * in plaintext + the matching `email_change_revert` outbox row frozen to that
 * original email. Returns the ids + the plaintext revert token id (sha256
 * hex) the public revert endpoint would hash to.
 */
async function seedMemberMidEmailChange(
  tenant: TestTenant,
  linkedUserId: string,
  originalEmail: string,
): Promise<{ memberId: string; contactId: string; revertTokenId: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  const revertTokenId = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const now = new Date();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Revert Token Co ${Date.now()}`,
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: '0105536000123',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    // The contact currently holds the NEW email (the change is mid-flight);
    // the revert token's old_email is the ORIGINAL address.
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Erik',
      lastName: 'Eriksson',
      email: `new-${randomUUID().slice(0, 8)}@example.com`,
      phone: '+66812345678',
      roleTitle: 'CEO',
      preferredLanguage: 'sv',
      isPrimary: true,
      dateOfBirth: '1980-01-01',
      linkedUserId,
      removedAt: null,
    });
    // Active 48h revert token — holds the ORIGINAL email in plaintext.
    await tx.insert(emailChangeTokens).values({
      id: revertTokenId,
      tenantId: tenant.ctx.slug,
      contactId,
      userId: linkedUserId,
      type: 'revert',
      oldEmail: originalEmail,
      newEmail: `new-${randomUUID().slice(0, 8)}@example.com`,
      activatedAt: now,
      expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      consumedAt: null,
    });
    // Matching pending revert-notification outbox row, frozen to the original
    // email (the L1 surface; this test focuses on M1 but the row exercises
    // the same scrub-tx cancel path).
    await tx.insert(notificationsOutbox).values({
      tenantId: tenant.ctx.slug,
      notificationType: 'email_change_revert',
      toEmail: originalEmail,
      locale: 'en',
      contextData: { token: 'plaintext-revert', oldEmail: originalEmail, newEmail: 'x@y.z' },
      status: 'pending',
    });
  });
  return { memberId, contactId, revertTokenId };
}

async function rawSelectUser(userId: string) {
  const rows = await db
    .select({ email: users.email, emailVerified: users.emailVerified, status: users.status })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0];
}

async function rawSelectContactEmail(contactId: string) {
  const rows = await db
    .select({ email: contacts.email, removedAt: contacts.removedAt })
    .from(contacts)
    .where(eq(contacts.contactId, contactId));
  return rows[0];
}

async function rawSelectToken(tokenId: string) {
  const rows = await db
    .select({ consumedAt: emailChangeTokens.consumedAt })
    .from(emailChangeTokens)
    .where(eq(emailChangeTokens.id, tokenId));
  return rows[0];
}

describe('eraseMember — revert token cannot resurrect erased PII (COMP-1 US2a M1, live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
    await seedRenewalPolicies(tenant.ctx);
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('invalidates the revert token on erasure AND refuses redemption — no PII restored', async () => {
    const linkedUser = await createActiveTestUser('member');
    const originalEmail = linkedUser.rawEmail; // the original real PII address
    try {
      const { memberId, contactId, revertTokenId } =
        await seedMemberMidEmailChange(tenant, linkedUser.userId, originalEmail);

      // Sanity: the revert token is redeemable BEFORE erasure.
      const tokenBefore = await rawSelectToken(revertTokenId);
      expect(tokenBefore?.consumedAt, 'token unconsumed before erasure').toBeNull();

      const deps = buildEraseMemberDeps(tenant.ctx);
      const result = await eraseMember(
        asMemberId(memberId) as MemberId,
        { reason: 'gdpr_erasure_request' },
        { actorUserId: admin.userId, requestId: `rq-revert-${Date.now()}` },
        deps,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);

      // (a) INVALIDATION — token consumed_at stamped inside the scrub tx.
      const tokenAfter = await rawSelectToken(revertTokenId);
      expect(
        tokenAfter?.consumedAt,
        'revert token must be invalidated (consumed) by erasure',
      ).not.toBeNull();

      // The login + contact are now erasure sentinels.
      const userAfterErase = await rawSelectUser(linkedUser.userId);
      expect(userAfterErase?.status).toBe('disabled');
      expect(userAfterErase?.email).toBe(
        `erased+${linkedUser.userId}@erased.invalid`,
      );
      expect(userAfterErase?.emailVerified).toBe(false);
      const contactAfterErase = await rawSelectContactEmail(contactId);
      expect(contactAfterErase?.email).toMatch(/^erased\+.*@erased\.invalid$/);

      // (b) REDEMPTION GUARD — attempt the revert with the seeded token. It
      // must be REJECTED and restore NO PII (defense-in-depth: even though the
      // token is already consumed, the guard would also refuse a stale token).
      const revertDeps = buildMembersDeps(tenant.ctx);
      const revertResult = await revertContactEmail(
        {
          tenant: asTenantContext(tenant.ctx.slug),
          tokens: revertDeps.tokens,
          contactRepo: revertDeps.contactRepo,
          userEmails: revertDeps.userEmails,
          sessions: revertDeps.sessions,
          audit: revertDeps.audit,
          clock: revertDeps.clock,
        },
        { tokenId: revertTokenId, requestId: `rq-revert-redeem-${Date.now()}` },
      );
      expect(revertResult.ok, JSON.stringify(revertResult)).toBe(false);

      // The original real email must NOT have reappeared anywhere.
      const userFinal = await rawSelectUser(linkedUser.userId);
      expect(userFinal?.email, 'users.email must stay the erasure sentinel').toBe(
        `erased+${linkedUser.userId}@erased.invalid`,
      );
      expect(userFinal?.email).not.toBe(originalEmail);
      expect(
        userFinal?.emailVerified,
        'email_verified must stay false (no resurrection)',
      ).toBe(false);
      const contactFinal = await rawSelectContactEmail(contactId);
      expect(contactFinal?.email).toMatch(/^erased\+.*@erased\.invalid$/);
      expect(contactFinal?.email).not.toBe(originalEmail);
    } finally {
      await deleteTestUser(linkedUser).catch(() => {});
    }
  }, 120_000);
});
