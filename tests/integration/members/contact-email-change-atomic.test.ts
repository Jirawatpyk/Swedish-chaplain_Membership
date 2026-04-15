/**
 * T072 — Integration: FR-012a 6-step atomic contact-email change.
 *
 * Exercises `changeContactEmail` against live Neon with a seeded
 * tenant + member + contact + linked user. Verifies:
 *
 *   Happy path (all 6 side effects persisted in one tx):
 *     1. contacts.email updated
 *     2. users.email updated + email_verified flipped to FALSE
 *     3. sessions rows for the user deleted
 *     4. `email_change_tokens` now contains 1 verification + 1 revert row
 *     5. `notifications_outbox` now contains 1 email_verification +
 *        1 email_change_revert row
 *     6. `audit_log` has exactly one `member_contact_email_changed`
 *        entry for the tenant
 *
 *   Chaos sub-scenarios — verify FULL ROLLBACK (zero side effects):
 *     (a) outbox enqueue throws → rollback
 *     (b) session revocation throws → rollback
 *     (c) user email conflict (another user already holds the target
 *         email) → rollback
 *
 * Relies on the same live-Neon harness that `create-member.test.ts`
 * uses (`.env.local` → DATABASE_URL). No mocks — the whole point is
 * that the transaction semantics hold end-to-end.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { changeContactEmail, type ContactId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  membershipPlans,
  tenantFeeConfig,
} from '@/modules/plans/infrastructure/db/schema';
import {
  auditLog,
  emailChangeTokens,
  notificationsOutbox,
  sessions,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import { asUserId } from '@/modules/auth';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import type { EmailPort } from '@/modules/members/application/ports/email-port';
import type { SessionRevocationPort } from '@/modules/members/application/ports/session-revocation-port';
import { err } from '@/lib/result';

// ---- Test scaffold ---------------------------------------------------------

async function seedMemberWithLinkedContact(args: {
  tenant: TestTenant;
  adminUserId: string;
}): Promise<{
  memberId: string;
  contactId: ContactId;
  linkedUser: TestUser;
  linkedUserOldEmail: string;
}> {
  const { tenant, adminUserId } = args;

  // A real user to act as the contact's `linked_user_id`. Gives the
  // 6-step txn something to update/revoke against.
  const linkedUser = await createActiveTestUser('member');

  const memberId = randomUUID();
  const contactId = randomUUID() as ContactId;
  const rand = randomUUID().slice(0, 8);

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: `Atomic Co ${rand}`,
      country: 'TH',
      planId: 'test-plan',
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Alice',
      lastName: 'Atomic',
      email: linkedUser.rawEmail,
      preferredLanguage: 'en',
      isPrimary: true,
      linkedUserId: linkedUser.userId,
    });
    // Stub audit row so the seed doesn't interfere with the assertion.
    await tx.insert(auditLog).values({
      eventType: 'account_created',
      actorUserId: adminUserId,
      targetUserId: linkedUser.userId,
      summary: 'test seed',
      requestId: `seed-${rand}`,
      tenantId: tenant.ctx.slug,
    });
  });

  // Seed a live session as the owner role (chamber_app has only
  // SELECT+DELETE on sessions — no INSERT). Step (iii) of the atomic
  // tx must then DELETE it.
  await db.insert(sessions).values({
    id: `sess-${randomUUID().replace(/-/g, '')}`,
    userId: linkedUser.userId,
    sourceIp: '127.0.0.1',
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
  });

  return {
    memberId,
    contactId,
    linkedUser,
    linkedUserOldEmail: linkedUser.rawEmail,
  };
}

async function countTenantRows(slug: string) {
  const outboxCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notificationsOutbox)
    .where(eq(notificationsOutbox.tenantId, slug));
  const tokenCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailChangeTokens)
    .where(eq(emailChangeTokens.tenantId, slug));
  const auditCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, slug),
        eq(auditLog.eventType, 'member_contact_email_changed'),
      ),
    );
  return {
    outbox: outboxCount[0]?.n ?? 0,
    tokens: tokenCount[0]?.n ?? 0,
    audit: auditCount[0]?.n ?? 0,
  };
}

// ---- Test suite ------------------------------------------------------------

describe('change-contact-email atomic tx (T072, FR-012a)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // Seed fee config + plan so the members FK `(tenant_id, plan_id,
    // plan_year) → membership_plans` is satisfied.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantFeeConfig).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeMinorUnits: 100000,
        updatedBy: admin.userId,
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'test-plan',
        planYear: 2026,
        planName: { en: 'Test Plan' },
        description: { en: '' },
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
  });

  afterAll(async () => {
    await tenant.cleanup();
    await deleteTestUser(admin);
  });

  it('happy path commits all 6 side effects in a single tx', async () => {
    const seed = await seedMemberWithLinkedContact({
      tenant,
      adminUserId: admin.userId,
    });
    const before = await countTenantRows(tenant.ctx.slug);
    const newEmail = `new-${randomUUID().slice(0, 8)}@example.com`;
    const deps = buildMembersDeps(tenant.ctx);

    const result = await changeContactEmail(
      { ...deps, tenant: tenant.ctx },
      {
        contactId: seed.contactId,
        newEmailRaw: newEmail,
        actorUserId: admin.userId,
        requestId: `req-happy-${randomUUID().slice(0, 8)}`,
        locale: 'en',
      },
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);

    // 1. contacts.email updated
    const [contactRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(eq(contacts.contactId, seed.contactId))
        .limit(1),
    );
    expect(contactRow?.email).toBe(newEmail);

    // 2. users.email + email_verified
    const [userRow] = await db
      .select({ email: users.email, verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, seed.linkedUser.userId))
      .limit(1);
    expect(userRow?.email).toBe(newEmail);
    expect(userRow?.verified).toBe(false);

    // 3. sessions for this user deleted
    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, seed.linkedUser.userId));
    expect(sessRows).toHaveLength(0);

    // 4. 2 token rows for this user
    const tokenRows = await db
      .select()
      .from(emailChangeTokens)
      .where(eq(emailChangeTokens.userId, seed.linkedUser.userId));
    expect(tokenRows).toHaveLength(2);
    const types = tokenRows.map((r) => r.type).sort();
    expect(types).toEqual(['revert', 'verification']);

    // 5. 2 outbox rows for this tenant (new since `before`)
    const after = await countTenantRows(tenant.ctx.slug);
    expect(after.outbox).toBe(before.outbox + 2);

    // 6. exactly one audit row added
    expect(after.audit).toBe(before.audit + 1);

    // Restore email_verified so cleanup doesn't leak state across tests.
    await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, seed.linkedUser.userId));
    await deleteTestUser(seed.linkedUser);
  }, 30_000);

  it('chaos (a): outbox enqueue throws → full rollback', async () => {
    const seed = await seedMemberWithLinkedContact({
      tenant,
      adminUserId: admin.userId,
    });
    const before = await countTenantRows(tenant.ctx.slug);
    const newEmail = `chaos-a-${randomUUID().slice(0, 8)}@example.com`;
    const deps = buildMembersDeps(tenant.ctx);

    const throwingEmails: EmailPort = {
      enqueue: async () => err({ code: 'repo.unexpected', cause: 'forced' }),
      enqueueInTx: async () => {
        throw new Error('CHAOS_OUTBOX_FAILURE');
      },
    };

    const result = await changeContactEmail(
      { ...deps, emails: throwingEmails, tenant: tenant.ctx },
      {
        contactId: seed.contactId,
        newEmailRaw: newEmail,
        actorUserId: admin.userId,
        requestId: `req-chaos-a-${randomUUID().slice(0, 8)}`,
        locale: 'en',
      },
    );
    expect(result.ok).toBe(false);

    // Zero side effects: no outbox rows, no tokens, no audit, email
    // unchanged, session still alive.
    const after = await countTenantRows(tenant.ctx.slug);
    expect(after.outbox).toBe(before.outbox);
    expect(after.tokens).toBe(before.tokens);
    expect(after.audit).toBe(before.audit);

    const [contactRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(eq(contacts.contactId, seed.contactId))
        .limit(1),
    );
    expect(contactRow?.email).toBe(seed.linkedUserOldEmail);

    const [userRow] = await db
      .select({ email: users.email, verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, seed.linkedUser.userId))
      .limit(1);
    expect(userRow?.email).toBe(seed.linkedUserOldEmail);
    expect(userRow?.verified).toBe(true);

    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, seed.linkedUser.userId));
    expect(sessRows.length).toBeGreaterThan(0);

    await deleteTestUser(seed.linkedUser);
  }, 30_000);

  it('chaos (b): session revocation throws → full rollback', async () => {
    const seed = await seedMemberWithLinkedContact({
      tenant,
      adminUserId: admin.userId,
    });
    const before = await countTenantRows(tenant.ctx.slug);
    const newEmail = `chaos-b-${randomUUID().slice(0, 8)}@example.com`;
    const deps = buildMembersDeps(tenant.ctx);

    const throwingSessions: SessionRevocationPort = {
      revokeAllFor: async () =>
        err({ code: 'repo.unexpected', cause: 'forced' }),
      revokeAllForInTx: async () => {
        throw new Error('CHAOS_SESSION_REVOCATION_FAILURE');
      },
    };

    const result = await changeContactEmail(
      { ...deps, sessions: throwingSessions, tenant: tenant.ctx },
      {
        contactId: seed.contactId,
        newEmailRaw: newEmail,
        actorUserId: admin.userId,
        requestId: `req-chaos-b-${randomUUID().slice(0, 8)}`,
        locale: 'en',
      },
    );
    expect(result.ok).toBe(false);

    const after = await countTenantRows(tenant.ctx.slug);
    expect(after.outbox).toBe(before.outbox);
    expect(after.tokens).toBe(before.tokens);
    expect(after.audit).toBe(before.audit);

    const [userRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, seed.linkedUser.userId))
      .limit(1);
    expect(userRow?.email).toBe(seed.linkedUserOldEmail);

    await deleteTestUser(seed.linkedUser);
  }, 30_000);

  it('chaos (c): user-email conflict → full rollback', async () => {
    const seed = await seedMemberWithLinkedContact({
      tenant,
      adminUserId: admin.userId,
    });
    const before = await countTenantRows(tenant.ctx.slug);
    const deps = buildMembersDeps(tenant.ctx);

    // Seed another user owning the target email so the UPDATE collides
    // on `users_email_lower_unique`.
    const conflicting = await createActiveTestUser('member');
    const conflictEmail = conflicting.rawEmail;

    const result = await changeContactEmail(
      { ...deps, tenant: tenant.ctx },
      {
        contactId: seed.contactId,
        newEmailRaw: conflictEmail,
        actorUserId: admin.userId,
        requestId: `req-chaos-c-${randomUUID().slice(0, 8)}`,
        locale: 'en',
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
    }

    const after = await countTenantRows(tenant.ctx.slug);
    expect(after.outbox).toBe(before.outbox);
    expect(after.tokens).toBe(before.tokens);
    expect(after.audit).toBe(before.audit);

    const [contactRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(eq(contacts.contactId, seed.contactId))
        .limit(1),
    );
    expect(contactRow?.email).toBe(seed.linkedUserOldEmail);

    await deleteTestUser(conflicting);
    await deleteTestUser(seed.linkedUser);
  }, 30_000);
});

// Silence unused import if asUserId isn't used — kept for future assertions.
void asUserId;
