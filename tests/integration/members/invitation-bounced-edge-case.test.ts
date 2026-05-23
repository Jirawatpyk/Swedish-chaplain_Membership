/**
 * G4 — `invitation_bounced` edge case (spec § Edge Cases ~line 613–620).
 *
 * Spec quote:
 *   "Invitation email bounce: if the F1 invitation email for a new primary
 *   or colleague contact bounces (Resend event `email.bounced`), the
 *   invitation is marked `failed`, a warning badge appears on the member
 *   row, an audit event `invitation_bounced` is appended, and admin sees a
 *   'Re-send invite' action. Silent bounce = data integrity bug; this edge
 *   case MUST be covered by integration test."
 *
 * IMPLEMENTED (2026-05-22, retrospective-review closure): the `invitations`
 * table has no failure state of its own, so the bounce marker lives on
 * `contacts.invite_bounced_at` (migration 0180). The tenant-agnostic Resend
 * webhook calls `handleInvitationBounce(toEmail)`, which resolves the owner
 * tenant(s) holding a LIVE pending invitation to that address and runs the
 * tenant-scoped `markInvitationBounced` use-case (stamp + `invitation_bounced`
 * audit) inside each owner tenant's RLS scope.
 *
 * Live Neon Singapore, throwaway-tenant pattern (mirrors
 * find-pending-invitations.test.ts).
 *
 * The "Re-send invite" action (spec ~line 618) is additive presentation + an
 * invite re-issue route — deferred (it.todo below). The data-integrity core
 * the spec calls a "data integrity bug" is what these tests cover.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, handleInvitationBounce, type MemberId } from '@/modules/members';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { invitations, auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const PLAN_ID = 'test-inv-bounce-plan';

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

async function seedPlan(tenantSlug: string, userId: string): Promise<void> {
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
      planName: { en: 'Inv Bounce Plan' },
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
      createdBy: userId,
      updatedBy: userId,
    });
  });
}

async function seedMemberWithContact(
  tenant: TestTenant,
  opts: { linkedUserId: string; contactEmail: string },
): Promise<{ memberId: MemberId; contactId: string }> {
  const memberId = randomUUID();
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: `BounceCo ${Date.now()}-${memberId.slice(0, 6)}`,
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
      firstName: 'Bounce',
      lastName: 'Invitee',
      email: opts.contactEmail,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: true,
      dateOfBirth: null,
      linkedUserId: opts.linkedUserId,
      removedAt: null,
    });
  });
  return { memberId: asMemberId(memberId), contactId };
}

async function seedInvitation(
  userId: string,
  invitedByUserId: string,
  opts: { consumedAt?: Date | null } = {},
): Promise<void> {
  const now = new Date();
  await db.insert(invitations).values({
    id: `inv-${randomUUID().replace(/-/g, '')}`,
    userId,
    invitedByUserId,
    intendedRole: 'member',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 7 * 86_400_000),
    consumedAt: opts.consumedAt ?? null,
  });
}

async function readInviteBouncedAt(
  tenant: TestTenant,
  contactId: string,
): Promise<Date | null> {
  return runInTenant(tenant.ctx, async (tx) => {
    const rows = await tx
      .select({ inviteBouncedAt: contacts.inviteBouncedAt })
      .from(contacts)
      .where(eq(contacts.contactId, contactId))
      .limit(1);
    return rows[0]?.inviteBouncedAt ?? null;
  });
}

async function countBounceAudits(
  tenant: TestTenant,
  contactId: string,
): Promise<number> {
  return runInTenant(tenant.ctx, async (tx) => {
    const rows = await tx
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, 'invitation_bounced'),
          eq(auditLog.tenantId, tenant.ctx.slug),
        ),
      );
    return rows.filter(
      (r) =>
        (r.payload as { contact_id?: string } | null)?.contact_id === contactId,
    ).length;
  });
}

describe('G4 — invitation_bounced edge case (spec § Edge Cases)', () => {
  let adminUser: TestUser;

  beforeAll(async () => {
    adminUser = await createActiveTestUser('admin');
  }, 30_000);

  it('bounce flips contacts.invite_bounced_at + emits exactly one invitation_bounced audit (owner tenant)', async () => {
    const tenant = await createTestTenant('test');
    try {
      await seedPlan(tenant.ctx.slug, adminUser.userId);
      const invitedUser = await createActiveTestUser('member');
      const email = `bounce-${randomUUID().slice(0, 8)}@example.com`;
      const { contactId } = await seedMemberWithContact(tenant, {
        linkedUserId: invitedUser.userId,
        contactEmail: email,
      });
      await seedInvitation(invitedUser.userId, adminUser.userId);

      // Pre-condition: not yet bounced.
      expect(await readInviteBouncedAt(tenant, contactId)).toBeNull();

      const { marked } = await handleInvitationBounce(email, 'req-bounce-1');
      expect(marked).toBe(1);

      // invitation marked failed (invite_bounced_at stamped).
      expect(await readInviteBouncedAt(tenant, contactId)).toBeInstanceOf(Date);
      // exactly one invitation_bounced audit row for this contact.
      expect(await countBounceAudits(tenant, contactId)).toBe(1);

      // Idempotent: a re-delivered bounce does NOT mark again or duplicate audit.
      const second = await handleInvitationBounce(email, 'req-bounce-1-dup');
      expect(second.marked).toBe(0);
      expect(await countBounceAudits(tenant, contactId)).toBe(1);
    } finally {
      await tenant.cleanup().catch(() => {});
    }
  }, 30_000);

  it('cross-tenant: marks only the OWNER tenant with a LIVE pending invite (Principle I)', async () => {
    // Same email is a contact in BOTH tenants. Tenant A holds a LIVE pending
    // invitation; tenant B's invitation is already consumed. The bounce must
    // mark + audit ONLY tenant A — tenant B's contact + audit log untouched.
    const tenantA = await createTestTenant('test');
    const tenantB = await createTestTenant('test');
    try {
      await seedPlan(tenantA.ctx.slug, adminUser.userId);
      await seedPlan(tenantB.ctx.slug, adminUser.userId);
      const email = `shared-${randomUUID().slice(0, 8)}@example.com`;

      const userA = await createActiveTestUser('member');
      const { contactId: contactA } = await seedMemberWithContact(tenantA, {
        linkedUserId: userA.userId,
        contactEmail: email,
      });
      await seedInvitation(userA.userId, adminUser.userId); // pending

      const userB = await createActiveTestUser('member');
      const { contactId: contactB } = await seedMemberWithContact(tenantB, {
        linkedUserId: userB.userId,
        contactEmail: email,
      });
      await seedInvitation(userB.userId, adminUser.userId, {
        consumedAt: new Date(), // already accepted → NOT pending
      });

      const { marked } = await handleInvitationBounce(email, 'req-bounce-xt');
      expect(marked).toBe(1); // only tenant A

      expect(await readInviteBouncedAt(tenantA, contactA)).toBeInstanceOf(Date);
      expect(await countBounceAudits(tenantA, contactA)).toBe(1);

      // Tenant B (consumed invite) untouched — no mark, no audit.
      expect(await readInviteBouncedAt(tenantB, contactB)).toBeNull();
      expect(await countBounceAudits(tenantB, contactB)).toBe(0);
    } finally {
      await tenantA.cleanup().catch(() => {});
      await tenantB.cleanup().catch(() => {});
    }
  }, 40_000);

  /**
   * G4.resend — "Re-send invite" use case (spec § Edge Cases, 015-f3-hardening).
   *
   * Spec requirement: after an invitation bounces, the admin clicks "Re-send
   * invite". This should:
   *   (a) clear contacts.invite_bounced_at = NULL,
   *   (b) create a new invitation row for the existing pending user,
   *   (c) enqueue a new member_invitation outbox row,
   *   (d) emit member_portal_invite_queued audit event.
   *
   * Two-phase design (mirrors invitePortal): Phase 1 mints the invitation
   * row (tenant-agnostic `invitations`) + enqueues the outbox row inside
   * F1's OWNER-ROLE `db.transaction` (chamber_app has no INSERT grant on
   * `invitations` — migrations 0016/0017). Phase 2 clears
   * `contacts.invite_bounced_at` + emits the audit inside a separate short
   * chamber_app `runInTenant` tx. This test verifies the owner-role mint
   * succeeds WITHOUT any chamber_app INSERT grant on `invitations`.
   */
  it('resendBouncedInvite — clears flag + creates new invitation + enqueues + audits', async () => {
    const { resendBouncedInvite } = await import('@/modules/members/application/use-cases/resend-bounced-invite');
    const { reissueInvitationAdapter } = await import('@/modules/members/infrastructure/adapters/reissue-invitation-adapter');
    const { drizzleContactRepo } = await import('@/modules/members/infrastructure/db/drizzle-contact-repo');
    const { drizzleAuditAdapter } = await import('@/modules/members/infrastructure/audit/audit-adapter');
    const { userEmailAdapter } = await import('@/modules/members/infrastructure/adapters/user-email-adapter');

    const tenant = await createTestTenant('test');
    try {
      await seedPlan(tenant.ctx.slug, adminUser.userId);

      // Seed a fresh 'pending' user by inserting directly (status='pending',
      // no password — the pending state means the invitation has not yet been
      // redeemed). createActiveTestUser always seeds 'active', so we insert manually.
      const pendingUserId = randomUUID();
      const contactEmail = `resend-${randomUUID().slice(0, 8)}@example.com`;

      // Seed a pending user row directly (no password — status='pending'
      // means the invitation has not yet been redeemed).
      const { users } = await import('@/modules/auth/infrastructure/db/schema');
      await db.insert(users).values({
        id: pendingUserId,
        email: contactEmail,
        role: 'member',
        status: 'pending',
        // passwordHash is NULL for pending accounts (migration 0001 schema comment).
        emailVerified: false,
        requiresPasswordReset: false,
        failedSignInCount: 0,
        createdAt: new Date(),
      });

      const { memberId, contactId } = await seedMemberWithContact(tenant, {
        linkedUserId: pendingUserId,
        contactEmail,
      });

      // Stamp the bounce flag directly (simulates handleInvitationBounce having run).
      await runInTenant(tenant.ctx, async (tx) => {
        await tx
          .update(contacts)
          .set({ inviteBouncedAt: new Date(), updatedAt: new Date() })
          .where(eq(contacts.contactId, contactId));
      });

      // Seed a prior (bounced) invitation row.
      await seedInvitation(pendingUserId, adminUser.userId);

      // Pre-conditions.
      expect(await readInviteBouncedAt(tenant, contactId)).toBeInstanceOf(Date);

      // Count existing invitations before the resend.
      const invitationsBefore = await db
        .select({ id: invitations.id })
        .from(invitations)
        .where(eq(invitations.userId, pendingUserId));
      const invCountBefore = invitationsBefore.length;

      // Count outbox rows before.
      const { notificationsOutbox } = await import('@/modules/auth/infrastructure/db/schema');
      const outboxBefore = await db
        .select({ id: notificationsOutbox.id })
        .from(notificationsOutbox)
        .where(eq(notificationsOutbox.toEmail, contactEmail));
      const outboxCountBefore = outboxBefore.length;

      // Run the use-case.
      const result = await resendBouncedInvite(
        {
          tenant: tenant.ctx,
          contactRepo: drizzleContactRepo,
          userEmails: userEmailAdapter,
          reissueInvitation: reissueInvitationAdapter,
          audit: drizzleAuditAdapter,
          clock: { now: () => new Date() },
        },
        {
          contactId: contactId as Parameters<typeof resendBouncedInvite>[1]['contactId'],
          memberId: memberId as string,
          actorUserId: adminUser.userId,
          requestId: `req-resend-int-${randomUUID().slice(0, 8)}`,
          locale: 'en',
        },
      );

      // (a) Use-case returned ok.
      expect(result.ok).toBe(true);

      // (b) invite_bounced_at cleared.
      expect(await readInviteBouncedAt(tenant, contactId)).toBeNull();

      // (c) A new invitation row exists (one more than before).
      const invitationsAfter = await db
        .select({ id: invitations.id })
        .from(invitations)
        .where(eq(invitations.userId, pendingUserId));
      expect(invitationsAfter.length).toBe(invCountBefore + 1);

      // (d) A new outbox row enqueued.
      const outboxAfter = await db
        .select({ id: notificationsOutbox.id })
        .from(notificationsOutbox)
        .where(eq(notificationsOutbox.toEmail, contactEmail));
      expect(outboxAfter.length).toBe(outboxCountBefore + 1);

      // (e) member_portal_invite_queued audit emitted.
      const auditRows = await runInTenant(tenant.ctx, async (tx) => {
        return tx
          .select({ payload: auditLog.payload })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.eventType, 'member_portal_invite_queued'),
              eq(auditLog.tenantId, tenant.ctx.slug),
            ),
          );
      });
      const resendAudit = auditRows.find(
        (r) => (r.payload as { resend?: boolean } | null)?.resend === true,
      );
      expect(resendAudit).toBeDefined();
    } finally {
      await tenant.cleanup().catch(() => {});
    }
  }, 40_000);
});
