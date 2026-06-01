/**
 * Integration — invite orphan-window SAGA compensation for the TWO remaining
 * invite paths (go-live #12-13 follow-up, live Neon).
 *
 * `invitePortal` (the admin single/bulk contact invite) was fixed in #12-13.
 * `inviteUserForMember` (admin invite + member link) and `inviteColleague`
 * (member self-service colleague invite) share the IDENTICAL orphan window:
 * F1 `createUser` commits the pending user + invitation + queued email in its
 * own tx, then a SECOND tx adds/links the contact. If that second tx fails AFTER
 * createUser committed, the pre-fix code left a PERMANENT orphan (active user,
 * no/unlinked contact → broken member-portal resolution; redeem-invite never
 * links a contact).
 *
 * Each test forces the link step to fail (capturing the exact F1 user id F1
 * minted) while createUser + deleteInvitedUser run for real, then proves:
 *   - the orphan user row is GONE (compensated by exact id + pending guard),
 *   - its invitation row is GONE (FK ON DELETE CASCADE),
 *   - its queued invite outbox row is GONE,
 *   - an `account_creation_compensated` audit row is appended alongside the
 *     original `account_created` row,
 *   - the use case returns a typed `server_error` (no silent ok()).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { err } from '@/lib/result';
import { inviteUserForMember, inviteColleague } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
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

const PLAN_ID = 'test-orphan-followup-plan';
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
      planName: { en: 'Orphan Followup Plan' },
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

async function assertOrphanRolledBack(opts: {
  capturedUserId: string | undefined;
  inviteeEmail: string;
  requestId: string;
}): Promise<void> {
  expect(opts.capturedUserId).toBeTruthy();
  const orphanUserId = opts.capturedUserId!;

  const userRows = await db.select({ id: users.id }).from(users).where(eq(users.id, orphanUserId));
  expect(userRows).toHaveLength(0);

  const invRows = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(eq(invitations.userId, orphanUserId));
  expect(invRows).toHaveLength(0);

  const outboxRows = await db
    .select({ id: notificationsOutbox.id })
    .from(notificationsOutbox)
    .where(eq(notificationsOutbox.toEmail, opts.inviteeEmail.toLowerCase()));
  expect(outboxRows).toHaveLength(0);

  const auditRows = await db
    .select({ eventType: auditLog.eventType, targetUserId: auditLog.targetUserId })
    .from(auditLog)
    .where(eq(auditLog.requestId, opts.requestId));
  const types = auditRows.map((r) => r.eventType);
  expect(types).toContain('account_created');
  expect(types).toContain('account_creation_compensated');
  const compensated = auditRows.find((r) => r.eventType === 'account_creation_compensated');
  expect(compensated?.targetUserId).toBe(orphanUserId);
}

describe('invite orphan-window follow-up — integration (go-live #12-13, live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let actorUser: TestUser;
  const sfx = randomUUID().slice(0, 8);
  let memberId: string;
  let actorContactId: string;
  const cleanupEmails: string[] = [];

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    actorUser = await createActiveTestUser('member');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant.ctx.slug, admin.userId);
    memberId = randomUUID();
    actorContactId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: `OrphanFollowupCo ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
        status: 'active',
        archivedAt: null,
      });
      // Primary contact = the actor for inviteColleague (must be primary + own member).
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: actorContactId,
        memberId,
        firstName: 'Actor',
        lastName: 'Primary',
        email: `orphan-actor-${sfx}@swecham.test`,
        preferredLanguage: 'en',
        isPrimary: true,
        linkedUserId: actorUser.userId,
        removedAt: null,
      });
    });
  }, 180_000);

  afterAll(async () => {
    for (const email of cleanupEmails) {
      await db.delete(notificationsOutbox).where(eq(notificationsOutbox.toEmail, email.toLowerCase())).catch(() => {});
      await db.delete(users).where(eq(users.email, email.toLowerCase())).catch(() => {});
    }
    const slug = tenant?.ctx.slug;
    if (slug) {
      await db.delete(contacts).where(eq(contacts.tenantId, slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, slug)).catch(() => {});
      await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, slug)).catch(() => {});
      await db.delete(tenantInvoiceSettings).where(eq(tenantInvoiceSettings.tenantId, slug)).catch(() => {});
    }
    await tenant?.cleanup().catch(() => {});
    await deleteTestUser(actorUser).catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('inviteUserForMember: link failure rolls back the orphaned F1 user', async () => {
    const realDeps = buildMembersDeps(tenant.ctx);
    const inviteeEmail = `orphan-ifm-${sfx}@swecham.test`;
    cleanupEmails.push(inviteeEmail);
    const requestId = `it-orphan-ifm-${sfx}`;

    let capturedUserId: string | undefined;
    const deps = {
      ...realDeps,
      contactRepo: {
        ...realDeps.contactRepo,
        // addInTx runs for real; linkUserInTx captures the minted id then fails,
        // throwing UseCaseAbort → the whole contact tx rolls back, leaving the
        // F1 user orphaned (which the catch then compensates).
        linkUserInTx: async (_tx: unknown, _contactId: unknown, userId: string) => {
          capturedUserId = userId;
          return err({ code: 'repo.unexpected' as const });
        },
      },
    } as typeof realDeps;

    const result = await inviteUserForMember(deps, {
      memberId: memberId as never,
      email: inviteeEmail,
      displayName: 'Orphan IFM',
      actorUserId: admin.userId,
      sourceIp: '203.0.113.9',
      requestId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('link_failed');
    await assertOrphanRolledBack({ capturedUserId, inviteeEmail, requestId });
  }, 60_000);

  it('inviteUserForMember link_existing: rolls back the orphan WITHOUT corrupting the pre-existing contact', async () => {
    // The subtle path the code comment flags: admin invites an email that ALREADY
    // exists as an unlinked secondary contact on the member → decision=link_existing.
    // A fresh F1 user is still minted; if the link tx fails, compensation must
    // delete that user while leaving the pre-existing contact intact + UNLINKED.
    const realDeps = buildMembersDeps(tenant.ctx);
    const inviteeEmail = `orphan-ifm-link-${sfx}@swecham.test`;
    cleanupEmails.push(inviteeEmail);
    const requestId = `it-orphan-ifm-link-${sfx}`;
    const preExistingContactId = randomUUID();

    // Seed an UNLINKED secondary contact on the member with the invitee email.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: preExistingContactId,
        memberId,
        firstName: 'PreExisting',
        lastName: 'Unlinked',
        email: inviteeEmail,
        preferredLanguage: 'en',
        isPrimary: false,
        linkedUserId: null,
        removedAt: null,
      });
    });

    let capturedUserId: string | undefined;
    const deps = {
      ...realDeps,
      contactRepo: {
        ...realDeps.contactRepo,
        linkUserInTx: async (_tx: unknown, _contactId: unknown, userId: string) => {
          capturedUserId = userId;
          return err({ code: 'repo.unexpected' as const });
        },
      },
    } as typeof realDeps;

    const result = await inviteUserForMember(deps, {
      memberId: memberId as never,
      email: inviteeEmail,
      displayName: 'Orphan IFM Link',
      actorUserId: admin.userId,
      sourceIp: '203.0.113.9',
      requestId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('link_failed');
    await assertOrphanRolledBack({ capturedUserId, inviteeEmail, requestId });

    // The pre-existing contact MUST survive untouched, still UNLINKED (its link
    // tx rolled back; the SET-NULL FK never had to fire because the user delete
    // happened after the rollback).
    const [survivor] = await db
      .select({ contactId: contacts.contactId, linkedUserId: contacts.linkedUserId })
      .from(contacts)
      .where(eq(contacts.contactId, preExistingContactId));
    expect(survivor?.contactId).toBe(preExistingContactId);
    expect(survivor?.linkedUserId ?? null).toBeNull();
  }, 60_000);

  it('inviteColleague: link failure rolls back the orphaned F1 user', async () => {
    const realDeps = buildMembersDeps(tenant.ctx);
    const inviteeEmail = `orphan-ic-${sfx}@swecham.test`;
    cleanupEmails.push(inviteeEmail);
    const requestId = `it-orphan-ic-${sfx}`;

    let capturedUserId: string | undefined;
    const deps = {
      ...realDeps,
      contactRepo: {
        ...realDeps.contactRepo,
        linkUserInTx: async (_tx: unknown, _contactId: unknown, userId: string) => {
          capturedUserId = userId;
          return err({ code: 'repo.unexpected' as const });
        },
      },
    } as typeof realDeps;

    const result = await inviteColleague(deps, {
      memberId: memberId as never,
      actorUserId: actorUser.userId,
      actorContactId: actorContactId as never,
      sourceIp: '203.0.113.9',
      requestId,
      body: {
        first_name: 'Orphan',
        last_name: 'Colleague',
        email: inviteeEmail,
        preferred_language: 'en',
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('link_failed');
    await assertOrphanRolledBack({ capturedUserId, inviteeEmail, requestId });
  }, 60_000);
});
