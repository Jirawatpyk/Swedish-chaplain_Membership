/**
 * Integration — invitePortal SAGA compensation + deleteInvitedUser (live Neon).
 *
 * Proves the go-live #12-13 orphan fix END-TO-END with REAL adapters:
 *
 *   1. ORPHAN ROLLBACK: when the contact-link step fails AFTER F1 `createUser`
 *      committed (the only branch that ever produced the orphan), invitePortal
 *      rolls the invite back via `deleteInvitedUser`:
 *        - the pending user row is GONE (deleted by exact id + status guard),
 *        - its invitation row is GONE (FK ON DELETE CASCADE),
 *        - its queued `notifications_outbox` invite row is GONE,
 *        - the contact stays UNLINKED (no half-write),
 *        - an `account_creation_compensated` audit row is appended ALONGSIDE the
 *          original `account_created` row (append-only Principle VIII — the undo
 *          is recorded, the create row is never erased),
 *        - the use case returns `link_failed` (NOT a silent ok()).
 *
 *   2. RACE NO-OP: `deleteInvitedUser` NEVER destroys a live account — given an
 *      ACTIVE user id (simulating a user who redeemed between createUser and the
 *      compensation), it deletes 0 rows and returns `compensated: false`, leaving
 *      the user intact. The id-only + `status='pending'` guard is what protects
 *      against deleting the wrong / a redeemed account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { err } from '@/lib/result';
import { invitePortal } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { deleteInvitedUser, asUserId } from '@/modules/auth';
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
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const PLAN_ID = 'test-orphan-fix-plan';
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
      planName: { en: 'Orphan Fix Plan' },
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

describe('F3 invitePortal orphan fix — integration (go-live #12-13, live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const sfx = randomUUID().slice(0, 8);
  const orphanEmail = `orphan-fix-${sfx}@swecham.test`;
  const requestId = `it-orphan-${sfx}`;
  let memberId: string;
  let contactId: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant.ctx.slug, admin.userId);
    memberId = randomUUID();
    contactId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: `OrphanFixCo ${memberId.slice(0, 6)}`,
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
        firstName: 'Orphan',
        lastName: 'Fix',
        email: orphanEmail,
        preferredLanguage: 'en',
        isPrimary: true,
        linkedUserId: null,
        removedAt: null,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await db.delete(notificationsOutbox).where(eq(notificationsOutbox.toEmail, orphanEmail.toLowerCase())).catch(() => {});
    await db.delete(auditLog).where(eq(auditLog.requestId, requestId)).catch(() => {});
    await db.delete(users).where(eq(users.email, orphanEmail.toLowerCase())).catch(() => {});
    const slug = tenant?.ctx.slug;
    if (slug) {
      await db.delete(contacts).where(eq(contacts.tenantId, slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
      await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug)).catch(() => {});
      await db.delete(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, slug)).catch(() => {});
    }
    await tenant?.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('ORPHAN ROLLBACK: link failure rolls back the invite — no orphan user/invitation/outbox; contact stays unlinked; compensated audit appended; returns link_failed', async () => {
    const realDeps = buildMembersDeps(tenant.ctx);
    // Force the contact-link step to fail AFTER createUser commits (the exact
    // branch that used to leave a permanent orphan). Everything else is REAL:
    // createUser actually writes a pending user + invitation + outbox row, then
    // deleteInvitedUser actually rolls it all back. The stub captures the exact
    // user id F1 minted so we can assert against it directly.
    let capturedUserId: string | undefined;
    const failingLinkDeps = {
      ...realDeps,
      contactRepo: {
        ...realDeps.contactRepo,
        linkUserInTx: async (_tx: unknown, _contactId: unknown, userId: string) => {
          capturedUserId = userId;
          return err({ code: 'repo.unexpected' as const });
        },
      },
    } as typeof realDeps;

    const result = await invitePortal(failingLinkDeps, {
      contactId: contactId as never,
      actorUserId: admin.userId,
      sourceIp: '203.0.113.9',
      requestId,
    });

    // 1. Typed failure — NOT a silent ok().
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('link_failed');

    // createUser must have run (and we captured the minted id) before the link
    // failed — otherwise the orphan branch was never exercised.
    expect(capturedUserId).toBeTruthy();
    const orphanUserId = capturedUserId!;

    // 2. No orphan user row survives (deleted by exact id + status guard).
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, orphanUserId));
    expect(userRows).toHaveLength(0);

    // 3. No orphan invitation row — FK ON DELETE CASCADE from the deleted user.
    const invRows = await db
      .select({ id: invitations.id })
      .from(invitations)
      .where(eq(invitations.userId, orphanUserId));
    expect(invRows).toHaveLength(0);

    // 4. No queued invite email survives (compensation dropped the outbox row).
    const outboxRows = await db
      .select({ id: notificationsOutbox.id })
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.toEmail, orphanEmail.toLowerCase()));
    expect(outboxRows).toHaveLength(0);

    // 5. The contact stays UNLINKED — no half-write.
    const [contactRow] = await db
      .select({ linkedUserId: contacts.linkedUserId })
      .from(contacts)
      .where(eq(contacts.contactId, contactId));
    expect(contactRow?.linkedUserId ?? null).toBeNull();

    // 6. BOTH audit rows present, targeting the (now-deleted) user id — the
    //    create is retained (append-only Principle VIII) AND the compensation is
    //    recorded. target_user_id has no FK, so the undo row survives the delete.
    const auditRows = await db
      .select({ eventType: auditLog.eventType, targetUserId: auditLog.targetUserId })
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    const created = auditRows.find((r) => r.eventType === 'account_created');
    const compensated = auditRows.find((r) => r.eventType === 'account_creation_compensated');
    expect(created).toBeDefined();
    expect(compensated).toBeDefined();
    expect(compensated?.targetUserId).toBe(orphanUserId);
  }, 60_000);

  it('RACE NO-OP: deleteInvitedUser never destroys an ACTIVE account → compensated:false', async () => {
    // An ACTIVE user simulates one who redeemed between createUser and the
    // compensation. The status='pending' guard must make the delete a no-op.
    const liveUser = await createActiveTestUser('member');
    try {
      const res = await deleteInvitedUser({
        userId: asUserId(liveUser.userId),
        outboxRowId: 'nonexistent-outbox-row',
        actorUserId: admin.userId,
        sourceIp: '203.0.113.9',
        requestId: `${requestId}-race`,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.compensated).toBe(false);

      // The live account is untouched.
      const rows = await db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.id, liveUser.userId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('active');

      // No compensation audit was written for a no-op.
      const auditRows = await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.requestId, `${requestId}-race`),
            eq(auditLog.eventType, 'account_creation_compensated'),
          ),
        );
      expect(auditRows).toHaveLength(0);
    } finally {
      await db.delete(auditLog).where(eq(auditLog.requestId, `${requestId}-race`)).catch(() => {});
      await deleteTestUser(liveUser).catch(() => {});
    }
  }, 60_000);
});
