/**
 * T073 — Integration: FR-012b revert flow (dual-channel email change).
 *
 * Scenario: admin changes contact email → two tokens issued (48h revert
 * to OLD address, 24h verification to NEW address). The OLD-address
 * user clicks the revert link within the window; we verify:
 *
 *   1. contacts.email restored to original value
 *   2. users.email restored + `email_verified=true` + `requires_password_reset=true`
 *   3. audit_log gains `member_email_change_reverted` (high-severity)
 *   4. outstanding verification token is invalidated (consumed_at set)
 *   5. revert token itself marked consumed
 *   6. Changing + immediate revert leaves NO surviving active tokens
 *
 * Uses the same seed shape + helpers as T072.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  changeContactEmail,
  revertContactEmail,
  type ContactId,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  auditLog,
  emailChangeTokens,
  sessions,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import {
  membershipPlans,
  tenantFeeConfig,
} from '@/modules/plans/infrastructure/db/schema';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

async function seed(args: { tenant: TestTenant; adminUserId: string }) {
  const linkedUser = await createActiveTestUser('member');
  const memberId = randomUUID();
  const contactId = randomUUID() as ContactId;
  const rand = randomUUID().slice(0, 8);

  await runInTenant(args.tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: args.tenant.ctx.slug,
      memberId,
      companyName: `Revert Co ${rand}`,
      country: 'TH',
      planId: 'test-plan',
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: args.tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Bob',
      lastName: 'Revert',
      email: linkedUser.rawEmail,
      preferredLanguage: 'en',
      isPrimary: true,
      linkedUserId: linkedUser.userId,
    });
  });
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
    originalEmail: linkedUser.rawEmail,
  };
}

describe('email-change revert dual-channel flow (T073, FR-012b)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
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

  it('revert atomically rolls back email + flags requires_password_reset', async () => {
    const s = await seed({ tenant, adminUserId: admin.userId });
    const deps = buildMembersDeps(tenant.ctx);
    const newEmail = `new-${randomUUID().slice(0, 8)}@example.com`;

    // Step 1 — change the email. Verify both tokens issued.
    const changed = await changeContactEmail(
      { ...deps, tenant: tenant.ctx },
      {
        contactId: s.contactId,
        newEmailRaw: newEmail,
        actorUserId: admin.userId,
        requestId: `req-change-${randomUUID().slice(0, 8)}`,
        locale: 'en',
      },
    );
    expect(changed.ok, JSON.stringify(changed)).toBe(true);

    const issued = await db
      .select()
      .from(emailChangeTokens)
      .where(eq(emailChangeTokens.userId, s.linkedUser.userId));
    expect(issued).toHaveLength(2);
    const revertRow = issued.find((r) => r.type === 'revert')!;
    const verifyRow = issued.find((r) => r.type === 'verification')!;
    expect(revertRow).toBeDefined();
    expect(verifyRow).toBeDefined();

    // Step 2 — consume the revert token. Token IDs in the DB are the
    // sha256 hashes; the adapter's `findActiveByIdInTx` takes that
    // hash directly, so we pass `revertRow.id` to the use case.
    const reverted = await revertContactEmail(
      { ...deps, tenant: tenant.ctx },
      {
        tokenId: revertRow.id,
        requestId: `req-revert-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(reverted.ok, JSON.stringify(reverted)).toBe(true);

    // 1. contacts.email restored
    const [contactRow] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(eq(contacts.contactId, s.contactId))
        .limit(1),
    );
    expect(contactRow?.email).toBe(s.originalEmail);

    // 2. users.email restored + verified + requires_password_reset
    const [userRow] = await db
      .select({
        email: users.email,
        verified: users.emailVerified,
        reqReset: users.requiresPasswordReset,
      })
      .from(users)
      .where(eq(users.id, s.linkedUser.userId))
      .limit(1);
    expect(userRow?.email).toBe(s.originalEmail);
    expect(userRow?.verified).toBe(true);
    expect(userRow?.reqReset).toBe(true);

    // 3. high-severity audit row present
    const [auditRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_email_change_reverted'),
          eq(auditLog.targetUserId, s.linkedUser.userId),
        ),
      );
    expect(auditRow?.n).toBe(1);

    // 4. outstanding verification token invalidated
    const tokensAfter = await db
      .select()
      .from(emailChangeTokens)
      .where(eq(emailChangeTokens.userId, s.linkedUser.userId));
    expect(tokensAfter).toHaveLength(2);
    for (const t of tokensAfter) {
      expect(t.consumedAt).not.toBeNull();
    }

    // 5. Second revert attempt on the same token → not_found
    const secondRevert = await revertContactEmail(
      { ...deps, tenant: tenant.ctx },
      {
        tokenId: revertRow.id,
        requestId: `req-revert-2-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(secondRevert.ok).toBe(false);
    if (!secondRevert.ok) expect(secondRevert.error.code).toBe('not_found');

    // Cleanup residual test state — reset `requires_password_reset`
    // so the user can be deleted cleanly.
    await db
      .update(users)
      .set({ requiresPasswordReset: false })
      .where(eq(users.id, s.linkedUser.userId));
    await deleteTestUser(s.linkedUser);
  }, 45_000);

  it('revert with wrong-type token (verification) returns wrong_type', async () => {
    const s = await seed({ tenant, adminUserId: admin.userId });
    const deps = buildMembersDeps(tenant.ctx);
    const newEmail = `alt-${randomUUID().slice(0, 8)}@example.com`;

    const changed = await changeContactEmail(
      { ...deps, tenant: tenant.ctx },
      {
        contactId: s.contactId,
        newEmailRaw: newEmail,
        actorUserId: admin.userId,
        requestId: `req-wrong-${randomUUID().slice(0, 8)}`,
        locale: 'en',
      },
    );
    expect(changed.ok).toBe(true);

    const [verifyRow] = await db
      .select()
      .from(emailChangeTokens)
      .where(
        and(
          eq(emailChangeTokens.userId, s.linkedUser.userId),
          eq(emailChangeTokens.type, 'verification'),
        ),
      )
      .limit(1);
    expect(verifyRow).toBeDefined();

    const result = await revertContactEmail(
      { ...deps, tenant: tenant.ctx },
      {
        tokenId: verifyRow!.id,
        requestId: `req-wrong-${randomUUID().slice(0, 8)}`,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('wrong_type');

    // Cleanup
    await db
      .update(users)
      .set({ email: s.originalEmail, emailVerified: true })
      .where(eq(users.id, s.linkedUser.userId));
    await deleteTestUser(s.linkedUser);
  }, 45_000);
});
