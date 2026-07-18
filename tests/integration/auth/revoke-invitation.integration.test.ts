/**
 * Integration — `revokeInvitation` use case (Staff Invitation Lifecycle,
 * Task 3, live Neon).
 *
 * Proves, with REAL adapters (no mocks):
 *
 *   1. F3-SAFE + OUTBOX CLEANUP: revoking a `pending`, member-linked invited
 *      user (a) deletes the `users` row, (b) leaves the `contacts` row
 *      INTACT with `linked_user_id IS NULL` (FK `ON DELETE SET NULL` —
 *      member data preserved), (c) appends an `invitation_revoked` audit
 *      row, (d) drops the queued PENDING `member_invitation` outbox row(s)
 *      for that email, while (e) a non-`member_invitation` outbox row on the
 *      same email SURVIVES (RA-2 notification-type scoping) and (f) an
 *      already-`sent` `member_invitation` row on the same email SURVIVES
 *      (RA-2 status scoping — only undispatched rows are cleaned).
 *      (g) a seeded `invitations` row for the pending user is gone after
 *      revoke too — proves the `invitations.user_id` FK's
 *      `ON DELETE CASCADE` DIRECTLY (not just transitively via (a), which
 *      only proves the `users` row itself is gone).
 *
 *   2. RA-3 CROSS-TENANT ISOLATION: the SAME email has a pending
 *      `member_invitation` outbox row in tenant A AND tenant B (plausible —
 *      one person invited to two different chambers). Revoking the tenant-A
 *      user deletes ONLY tenant A's outbox row; tenant B's row SURVIVES —
 *      the owner-role tx (BYPASSRLS on FORCE-RLS `notifications_outbox`)
 *      cannot leak across the `tenant_id` filter (Principle I).
 *
 * Mirrors the seeding pattern in
 * tests/integration/members/invite-portal-orphan-fix.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { revokeInvitation, asUserId } from '@/modules/auth';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  notificationsOutbox,
  users,
  auditLog,
  invitations,
} from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, createTwoTestTenants } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const PLAN_ID = 'test-revoke-invitation-plan';
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

async function seedPlan(slug: string, userId: string): Promise<void> {
  await runInTenant({ slug } as never, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: slug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Revoke Invitation Plan' },
      description: { en: 'Test' },
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

async function seedPendingUser(email: string): Promise<string> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email,
    role: 'member',
    status: 'pending',
    emailVerified: false,
    requiresPasswordReset: false,
    failedSignInCount: 0,
    createdAt: new Date(),
  });
  return userId;
}

async function seedOutboxRow(opts: {
  tenantId: string;
  toEmail: string;
  notificationType:
    | 'member_invitation'
    | 'email_verification'
    | 'email_change_revert'
    | 'email_verification_resent';
  status?: 'pending' | 'sent' | 'permanently_failed';
}): Promise<string> {
  const rows = await db
    .insert(notificationsOutbox)
    .values({
      tenantId: opts.tenantId,
      notificationType: opts.notificationType,
      toEmail: opts.toEmail.toLowerCase(),
      locale: 'en',
      contextData: { token: 'irrelevant-test-token', role: 'member' },
      status: opts.status ?? 'pending',
    })
    .returning({ id: notificationsOutbox.id });
  const row = rows[0];
  if (!row) throw new Error('seedOutboxRow: insert returned no row');
  return row.id;
}

async function countPendingMemberInvitationOutbox(
  tenantId: string,
  toEmail: string,
): Promise<number> {
  const rows = await db
    .select({ id: notificationsOutbox.id })
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.tenantId, tenantId),
        eq(notificationsOutbox.toEmail, toEmail.toLowerCase()),
        eq(notificationsOutbox.notificationType, 'member_invitation'),
        eq(notificationsOutbox.status, 'pending'),
      ),
    );
  return rows.length;
}

describe('revokeInvitation — integration (Staff Invitation Lifecycle Task 3, live Neon)', () => {
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
  }, 60_000);

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, admin.userId)).catch(() => {});
  }, 30_000);

  it('F3-SAFE + OUTBOX CLEANUP: deletes the user, unlinks (not deletes) the contact, audits invitation_revoked, drops the pending member_invitation outbox row(s) for that email, leaves other notification types + already-sent rows untouched', async () => {
    const tenant = await createTestTenant('test-swecham');
    const sfx = randomUUID().slice(0, 8);
    const email = `revoke-${sfx}@swecham.test`;
    const requestId = `it-revoke-${sfx}`;
    let pendingUserId: string | undefined;
    let invitationId: string | undefined;

    try {
      await seedPlan(tenant.ctx.slug, admin.userId);
      pendingUserId = await seedPendingUser(email);

      // (g) target: a live invitation row for the pending user — must be
      // gone (via ON DELETE CASCADE on invitations.user_id) once the
      // users row is deleted by revokeInvitation.
      invitationId = randomUUID();
      await db.insert(invitations).values({
        id: invitationId,
        userId: pendingUserId,
        invitedByUserId: admin.userId,
        intendedRole: 'member',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      const memberId = randomUUID();
      const contactId = randomUUID();
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: `RevokeCo ${memberId.slice(0, 6)}`,
          country: 'TH',
          planId: PLAN_ID,
          planYear: 2026,
          status: 'active',
          archivedAt: null,
        });
        await tx.insert(contacts).values({
          tenantId: tenant.ctx.slug,
          contactId,
          memberId,
          firstName: 'Revoke',
          lastName: 'Invitee',
          email,
          preferredLanguage: 'en',
          isPrimary: true,
          linkedUserId: pendingUserId,
          removedAt: null,
        });
      });

      // (d) target: the pending member_invitation row to be dropped.
      await seedOutboxRow({
        tenantId: tenant.ctx.slug,
        toEmail: email,
        notificationType: 'member_invitation',
        status: 'pending',
      });
      // (e) different notification type, same email — must SURVIVE.
      await seedOutboxRow({
        tenantId: tenant.ctx.slug,
        toEmail: email,
        notificationType: 'email_verification',
        status: 'pending',
      });
      // (f) already-dispatched member_invitation, same email — must SURVIVE
      //     (status scoping — only undispatched rows are cleaned).
      await seedOutboxRow({
        tenantId: tenant.ctx.slug,
        toEmail: email,
        notificationType: 'member_invitation',
        status: 'sent',
      });

      const result = await revokeInvitation({
        userId: asUserId(pendingUserId),
        actorUserId: admin.userId,
        tenantId: tenant.ctx.slug,
        sourceIp: '203.0.113.20',
        requestId,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({ deleted: true });

      // (a) the users row is gone.
      const userRows = await db.select({ id: users.id }).from(users).where(eq(users.id, pendingUserId));
      expect(userRows).toHaveLength(0);

      // (g) the seeded invitations row is gone too — proves
      // invitations.user_id ON DELETE CASCADE directly, not just
      // transitively through (a).
      const invitationRows = await db
        .select({ id: invitations.id })
        .from(invitations)
        .where(eq(invitations.id, invitationId));
      expect(invitationRows).toHaveLength(0);

      // (b) the contact stays — unlinked, not deleted (F3-safe SET NULL).
      const contactRows = await db
        .select({ linkedUserId: contacts.linkedUserId, removedAt: contacts.removedAt })
        .from(contacts)
        .where(eq(contacts.contactId, contactId));
      expect(contactRows).toHaveLength(1);
      expect(contactRows[0]?.linkedUserId).toBeNull();
      expect(contactRows[0]?.removedAt).toBeNull();

      // (c) invitation_revoked audit row appended.
      const auditRows = await db
        .select({ eventType: auditLog.eventType, targetUserId: auditLog.targetUserId })
        .from(auditLog)
        .where(eq(auditLog.requestId, requestId));
      const revoked = auditRows.find((r) => r.eventType === 'invitation_revoked');
      expect(revoked).toBeDefined();
      expect(revoked?.targetUserId).toBe(pendingUserId);

      // (d) the pending member_invitation outbox row is gone.
      expect(await countPendingMemberInvitationOutbox(tenant.ctx.slug, email)).toBe(0);

      // (e) the non-member_invitation outbox row survives.
      const survivingVerification = await db
        .select({ id: notificationsOutbox.id })
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.tenantId, tenant.ctx.slug),
            eq(notificationsOutbox.toEmail, email.toLowerCase()),
            eq(notificationsOutbox.notificationType, 'email_verification'),
          ),
        );
      expect(survivingVerification).toHaveLength(1);

      // (f) the already-sent member_invitation row survives.
      const survivingSent = await db
        .select({ id: notificationsOutbox.id })
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.tenantId, tenant.ctx.slug),
            eq(notificationsOutbox.toEmail, email.toLowerCase()),
            eq(notificationsOutbox.notificationType, 'member_invitation'),
            eq(notificationsOutbox.status, 'sent'),
          ),
        );
      expect(survivingSent).toHaveLength(1);
    } finally {
      await db.delete(notificationsOutbox).where(eq(notificationsOutbox.toEmail, email.toLowerCase())).catch(() => {});
      await db.delete(auditLog).where(eq(auditLog.requestId, requestId)).catch(() => {});
      if (invitationId) {
        // Normally already gone via ON DELETE CASCADE once the users row is
        // deleted — this is a defence-in-depth no-op on the happy path,
        // only doing real work if revoke failed before reaching that point.
        await db.delete(invitations).where(eq(invitations.id, invitationId)).catch(() => {});
      }
      if (pendingUserId) {
        await db.delete(users).where(eq(users.id, pendingUserId)).catch(() => {});
      }
      const slug = tenant.ctx.slug;
      await db.delete(contacts).where(eq(contacts.tenantId, slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
      await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug)).catch(() => {});
      await db.delete(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, slug)).catch(() => {});
      await tenant.cleanup().catch(() => {});
    }
  }, 60_000);

  it('RA-3 cross-tenant isolation: revoking the tenant-A user deletes ONLY tenant A\'s pending outbox row; tenant B\'s survives', async () => {
    const { a: tenantA, b: tenantB } = await createTwoTestTenants();
    const sfx = randomUUID().slice(0, 8);
    // Same email queued as a pending member_invitation in BOTH tenants —
    // plausible (one person invited to two different chambers).
    const sharedEmail = `revoke-xt-${sfx}@swecham.test`;
    const requestId = `it-revoke-xt-${sfx}`;
    let pendingUserId: string | undefined;

    try {
      pendingUserId = await seedPendingUser(sharedEmail);

      await seedOutboxRow({
        tenantId: tenantA.ctx.slug,
        toEmail: sharedEmail,
        notificationType: 'member_invitation',
        status: 'pending',
      });
      await seedOutboxRow({
        tenantId: tenantB.ctx.slug,
        toEmail: sharedEmail,
        notificationType: 'member_invitation',
        status: 'pending',
      });

      const result = await revokeInvitation({
        userId: asUserId(pendingUserId),
        actorUserId: admin.userId,
        tenantId: tenantA.ctx.slug,
        sourceIp: '203.0.113.21',
        requestId,
      });

      expect(result.ok).toBe(true);

      // Tenant A's queued invite is gone.
      expect(await countPendingMemberInvitationOutbox(tenantA.ctx.slug, sharedEmail)).toBe(0);
      // Tenant B's queued invite for the SAME email SURVIVES.
      expect(await countPendingMemberInvitationOutbox(tenantB.ctx.slug, sharedEmail)).toBe(1);
    } finally {
      await db
        .delete(notificationsOutbox)
        .where(eq(notificationsOutbox.toEmail, sharedEmail.toLowerCase()))
        .catch(() => {});
      await db.delete(auditLog).where(eq(auditLog.requestId, requestId)).catch(() => {});
      if (pendingUserId) {
        await db.delete(users).where(eq(users.id, pendingUserId)).catch(() => {});
      }
      await tenantA.cleanup().catch(() => {});
      await tenantB.cleanup().catch(() => {});
    }
  }, 60_000);
});
