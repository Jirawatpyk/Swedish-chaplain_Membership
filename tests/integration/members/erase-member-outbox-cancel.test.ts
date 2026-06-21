/**
 * COMP-1 US2a — L1: post-erasure email via pending outbox (live Neon).
 *
 * GAP L1 (CONFIRMED): erasure soft-consumes invitations but never cancels the
 * linked users' pending `notifications_outbox` rows. The `to_email` was frozen
 * at enqueue = the real address, and the retry ladder keeps a once-failed row
 * `pending` for up to 12h — so the dispatcher could still email the erased
 * subject AFTER erasure.
 *
 * L1 closes it by DELETING the erased member's pending outbox rows INSIDE the
 * same atomic scrub tx, mirroring `delete-invited-user.ts` (which deletes the
 * queued invite outbox row "so no dead invite email is dispatched"). The cancel
 * keys on the member's real email addresses (contact emails + linked-user
 * emails + active email-change-token old/new emails) captured BEFORE the scrub
 * sentinel-izes them. Only `pending` rows are removed — already-sent /
 * permanently_failed rows are an immutable record and are left untouched.
 *
 * Oracle after `eraseMember`:
 *   - the seeded pending outbox row for the linked user is GONE (0 rows) — no
 *     longer dispatchable;
 *   - a `sent` outbox row for the SAME email is PRESERVED (we only cancel
 *     pending, not the historical send record).
 *
 * Reuses the live-Neon harness from `erase-member-f1-user.test.ts`. No mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
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

const PLAN_ID = 'test-erase-outbox-cancel-plan';

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
      planName: { en: 'Erase Outbox Cancel Plan' },
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
 * Seed a member + primary contact linked to `linkedUserId`, with the contact's
 * email = `contactEmail`. Then enqueue (a) a PENDING member_invitation outbox
 * row frozen to that contact email, and (b) a SENT outbox row to the same
 * email (the historical record that must survive). Returns the member + contact
 * ids and the two outbox row ids.
 */
async function seedMemberWithOutbox(
  tenant: TestTenant,
  linkedUserId: string,
  contactEmail: string,
): Promise<{
  memberId: string;
  contactId: string;
  pendingRowId: string;
  sentRowId: string;
}> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  let pendingRowId = '';
  let sentRowId = '';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Outbox Cancel Co ${Date.now()}`,
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
      linkedUserId,
      removedAt: null,
    });
    const [pending] = await tx
      .insert(notificationsOutbox)
      .values({
        tenantId: tenant.ctx.slug,
        notificationType: 'member_invitation',
        toEmail: contactEmail,
        locale: 'en',
        contextData: { token: 'plaintext-invite', role: 'member' },
        status: 'pending',
        // Simulate a once-failed row still pending in the retry ladder.
        attempts: 1,
      })
      .returning({ id: notificationsOutbox.id });
    pendingRowId = pending!.id;
    const [sent] = await tx
      .insert(notificationsOutbox)
      .values({
        tenantId: tenant.ctx.slug,
        notificationType: 'member_invitation',
        toEmail: contactEmail,
        locale: 'en',
        contextData: { token: 'already-sent', role: 'member' },
        status: 'sent',
        sentMessageId: 'msg-historical',
      })
      .returning({ id: notificationsOutbox.id });
    sentRowId = sent!.id;
  });
  return { memberId, contactId, pendingRowId, sentRowId };
}

/**
 * Seed member A: a REMOVED primary contact whose email = `removedContactEmail`
 * (so the partial `contacts_tenant_email_uniq` index permits a LIVE contact of
 * a DIFFERENT member to share the same email in the same tenant), linked to
 * `linkedUserId`. Enqueue one PENDING outbox row frozen to A's LOGIN email
 * (`loginEmail`, unambiguous) — A's legitimate mail that the erasure MUST still
 * cancel. Returns A's member id + the pending row id.
 */
async function seedMemberWithRemovedContact(
  tenant: TestTenant,
  linkedUserId: string,
  removedContactEmail: string,
  loginEmail: string,
): Promise<{ memberId: string; ownPendingRowId: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  let ownPendingRowId = '';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Removed Contact Co ${Date.now()}`,
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: '0105536000999',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Anna',
      lastName: 'Andersson',
      email: removedContactEmail,
      phone: '+66898765432',
      roleTitle: 'CFO',
      preferredLanguage: 'sv',
      // REMOVED contact: is_primary MUST be FALSE while removed_at is set
      // (contacts_primary_not_removed CHECK + the one-primary partial index).
      isPrimary: false,
      dateOfBirth: '1979-02-02',
      linkedUserId,
      removedAt: new Date(),
    });
    // A's OWN legitimate pending row, frozen to A's real LOGIN email (the
    // linked user's users.email — globally unique, unambiguously A's). The
    // erasure must still cancel this via the linked-login-email component.
    const [ownPending] = await tx
      .insert(notificationsOutbox)
      .values({
        tenantId: tenant.ctx.slug,
        notificationType: 'member_invitation',
        toEmail: loginEmail,
        locale: 'en',
        contextData: { token: 'plaintext-invite-a', role: 'member' },
        status: 'pending',
        attempts: 1,
      })
      .returning({ id: notificationsOutbox.id });
    ownPendingRowId = ownPending!.id;
  });
  return { memberId, ownPendingRowId };
}

/**
 * COMP-1 FIX-4 — seed a member with a LIVE contact linked to `linkedUserId`,
 * whose CONTACT email is DISTINCT from `loginEmail` (the linked user's
 * users.email), plus a PENDING outbox row frozen to `loginEmail`. This is the
 * realistic "shared login" case the naive contact-email guard misses: the
 * pending mail is keyed to the LOGIN address, which is not any contact's email.
 * Returns the member id + the pending row id.
 */
async function seedMemberLinkedWithPendingToLogin(
  tenant: TestTenant,
  linkedUserId: string,
  loginEmail: string,
): Promise<{ memberId: string; pendingToLoginRowId: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  // DISTINCT from loginEmail — the contact-email guard must NOT be what saves
  // this row; only the linked-login guard can.
  const contactEmail = `contact-${randomUUID().slice(0, 8)}@example.com`;
  let pendingToLoginRowId = '';
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Shared Login Co ${Date.now()}`,
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: '0105536000777',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Bea',
      lastName: 'Berg',
      email: contactEmail,
      phone: '+66811112222',
      roleTitle: 'COO',
      preferredLanguage: 'sv',
      isPrimary: true,
      dateOfBirth: '1981-03-03',
      linkedUserId,
      removedAt: null,
    });
    const [pending] = await tx
      .insert(notificationsOutbox)
      .values({
        tenantId: tenant.ctx.slug,
        notificationType: 'member_invitation',
        // Frozen to the SHARED LOGIN email (not any contact's email).
        toEmail: loginEmail,
        locale: 'en',
        contextData: { token: 'plaintext-invite-b', role: 'member' },
        status: 'pending',
        attempts: 1,
      })
      .returning({ id: notificationsOutbox.id });
    pendingToLoginRowId = pending!.id;
  });
  return { memberId, pendingToLoginRowId };
}

async function rawSelectOutbox(rowId: string) {
  const rows = await db
    .select({ id: notificationsOutbox.id, status: notificationsOutbox.status })
    .from(notificationsOutbox)
    .where(eq(notificationsOutbox.id, rowId));
  return rows[0];
}

describe('eraseMember — cancels pending outbox rows for the erased subject (COMP-1 US2a L1, live Neon)', () => {
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

  it('deletes the pending outbox row for the erased member but preserves a sent row', async () => {
    const linkedUser = await createActiveTestUser('member');
    // The contact email is a real address frozen onto the outbox to_email.
    const contactEmail = `outbox-${randomUUID().slice(0, 8)}@example.com`;
    try {
      const { memberId, pendingRowId, sentRowId } = await seedMemberWithOutbox(
        tenant,
        linkedUser.userId,
        contactEmail,
      );

      // Sanity: both rows exist before erasure.
      expect((await rawSelectOutbox(pendingRowId))?.status).toBe('pending');
      expect((await rawSelectOutbox(sentRowId))?.status).toBe('sent');

      const deps = buildEraseMemberDeps(tenant.ctx);
      const result = await eraseMember(
        asMemberId(memberId) as MemberId,
        { reason: 'gdpr_erasure_request' },
        { actorUserId: admin.userId, requestId: `rq-outbox-${Date.now()}` },
        deps,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);

      // The PENDING row is gone — no longer dispatchable to the erased subject.
      expect(
        await rawSelectOutbox(pendingRowId),
        'pending outbox row for erased subject must be cancelled (deleted)',
      ).toBeUndefined();

      // The SENT row survives — the historical send record is immutable.
      expect(
        (await rawSelectOutbox(sentRowId))?.status,
        'a sent outbox row must NOT be cancelled by erasure',
      ).toBe('sent');
    } finally {
      await deleteTestUser(linkedUser).catch(() => {});
    }
  }, 120_000);

  /**
   * MEDIUM (security review) — the outbox cancel-set must NOT over-delete a
   * DIFFERENT member's legitimate pending mail that happens to share an email.
   *
   * The `contacts_tenant_email_uniq` index is PARTIAL (`WHERE removed_at IS
   * NULL`), so a REMOVED contact of member A and a LIVE contact of member B
   * (same tenant) can share email X. The original L1 fix built the cancel-set
   * from the UNFILTERED `listEmailsForMemberInTx`, which includes A's removed
   * contact's email X — so erasing A ran `DELETE … WHERE to_email='X' AND
   * status='pending'` and silently deleted member B's legitimate pending mail.
   *
   * The fix sources the CONTACT-email component of the cancel-set from LIVE
   * contacts only (`removed_at IS NULL` at the pre-scrub read): a removed
   * contact's email is ambiguously owned (may be B's live contact) so it is
   * excluded. A's OWN legitimate pending mail (keyed to A's unambiguous login
   * email) is still cancelled via the linked-login-email component.
   *
   * Oracle after erasing A:
   *   (a) member B's pending row to the shared email X SURVIVES (not deleted);
   *   (b) member A's own pending row (to A's login email) IS deleted.
   *
   * With the UNFILTERED code this is RED: B's row to X is wrongly deleted.
   */
  it('does not over-delete a shared-email peer member\'s pending mail', async () => {
    const linkedUserA = await createActiveTestUser('member');
    const linkedUserB = await createActiveTestUser('member');
    // X — shared between A's REMOVED contact and B's LIVE contact.
    const sharedEmail = `shared-${randomUUID().slice(0, 8)}@example.com`;
    try {
      // Member B: LIVE contact with email X + a PENDING outbox row to X.
      const b = await seedMemberWithOutbox(tenant, linkedUserB.userId, sharedEmail);

      // Member A: REMOVED contact with the SAME email X (permitted by the
      // partial unique index) + a PENDING row to A's own login email.
      const a = await seedMemberWithRemovedContact(
        tenant,
        linkedUserA.userId,
        sharedEmail,
        linkedUserA.rawEmail,
      );

      // Sanity: all three rows exist before erasure.
      expect((await rawSelectOutbox(b.pendingRowId))?.status).toBe('pending');
      expect((await rawSelectOutbox(a.ownPendingRowId))?.status).toBe('pending');

      const deps = buildEraseMemberDeps(tenant.ctx);
      const result = await eraseMember(
        asMemberId(a.memberId) as MemberId,
        { reason: 'gdpr_erasure_request' },
        { actorUserId: admin.userId, requestId: `rq-overdelete-${Date.now()}` },
        deps,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);

      // (a) Member B's pending row to the shared email X SURVIVES — erasing A
      //     must not touch B's legitimate mail. (RED with the unfiltered code.)
      expect(
        (await rawSelectOutbox(b.pendingRowId))?.status,
        'peer member B pending mail to shared email must NOT be cancelled by erasing A',
      ).toBe('pending');

      // (b) Member A's OWN pending row (to A's login email) IS deleted — the
      //     fix still cancels A's legitimate mail via the linked-login email.
      expect(
        await rawSelectOutbox(a.ownPendingRowId),
        'erased member A own pending mail (to A login email) must be cancelled',
      ).toBeUndefined();
    } finally {
      await deleteTestUser(linkedUserA).catch(() => {});
      await deleteTestUser(linkedUserB).catch(() => {});
    }
  }, 120_000);

  /**
   * COMP-1 FIX-4 (security review) — the outbox cancel-set must NOT over-delete
   * a peer member's pending mail to a SHARED LOGIN email via the linked-login /
   * token arms (which have NO cross-member guard).
   *
   * `contacts.linked_user_id` has no unique constraint, so two members can link
   * the SAME login user U. The cancel-set unions the erased member's contact
   * emails (live, guarded by FIX-3's live-only read) WITH the linked-login
   * emails (U.email) and the invalidated-token emails — and the login/token
   * arms are unguarded. The naive "NOT EXISTS a live contact at to_email" guard
   * does NOT close it: a login email need not equal any contact's email (B's
   * contact email is DISTINCT from U.email here).
   *
   * The CORRECTED fix adds a two-pronged cross-member ownership guard in the
   * outbox DELETE, parameterised by the erased member id:
   *   guard 1 — protect a peer member's CONTACT-addressed mail;
   *   guard 2 — protect a peer member's LOGIN-addressed mail (a login U shared
   *             via contacts on a DIFFERENT live member).
   *
   * ORACLE after erasing A:
   *   (a) member B's pending row to the SHARED LOGIN U.email SURVIVES (guard 2);
   *   (b) member A's OWN pending row (to A's own contact email, not shared) IS
   *       deleted (the fix still cancels A's legitimate mail).
   *
   * RED on HEAD: A's linked-login arm puts U.email in emailsToCancel and the
   * unguarded DELETE removes B's row. GREEN after the two-pronged guard.
   */
  it('does not over-delete a peer member\'s pending mail to a SHARED LOGIN email', async () => {
    // The SHARED login user U — linked by BOTH A and B.
    const sharedLogin = await createActiveTestUser('member');
    try {
      // Member B: LIVE contact linked to U (B's contact email DISTINCT from
      // U.email) + a PENDING outbox row frozen to U.email (B's legit mail).
      const b = await seedMemberLinkedWithPendingToLogin(
        tenant,
        sharedLogin.userId,
        sharedLogin.rawEmail,
      );

      // Member A (to be erased): LIVE contact also linked to U + a PENDING
      // outbox row to A's OWN contact email (A's legit mail that MUST be
      // cancelled). `seedMemberWithOutbox` links the contact to U and freezes
      // the pending/sent rows onto A's own contact email.
      const aContactEmail = `a-own-${randomUUID().slice(0, 8)}@example.com`;
      const a = await seedMemberWithOutbox(
        tenant,
        sharedLogin.userId,
        aContactEmail,
      );

      // Sanity: both pending rows exist before erasure.
      expect((await rawSelectOutbox(b.pendingToLoginRowId))?.status).toBe(
        'pending',
      );
      expect((await rawSelectOutbox(a.pendingRowId))?.status).toBe('pending');

      const deps = buildEraseMemberDeps(tenant.ctx);
      const result = await eraseMember(
        asMemberId(a.memberId) as MemberId,
        { reason: 'gdpr_erasure_request' },
        {
          actorUserId: admin.userId,
          requestId: `rq-shared-login-${Date.now()}`,
        },
        deps,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);

      // (a) Member B's pending row to the SHARED LOGIN email SURVIVES — erasing
      //     A must not cancel B's mail to the shared login. (RED on HEAD: A's
      //     linked-login arm reads U.email and the unguarded DELETE removes it.)
      expect(
        (await rawSelectOutbox(b.pendingToLoginRowId))?.status,
        'peer member B pending mail to the shared login email must NOT be cancelled by erasing A',
      ).toBe('pending');

      // (b) Member A's OWN pending row (to A's own contact email) IS deleted —
      //     the fix still cancels A's legitimate mail.
      expect(
        await rawSelectOutbox(a.pendingRowId),
        'erased member A own pending mail (to A own contact email) must be cancelled',
      ).toBeUndefined();
    } finally {
      await deleteTestUser(sharedLogin).catch(() => {});
    }
  }, 120_000);
});
