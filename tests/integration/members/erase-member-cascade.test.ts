/**
 * COMP-1 US1 (Member Erasure, Task 5) — Integration: erasure session/invitation
 * cascade ordering (Bug I-1 regression net).
 *
 * The Art.17/PDPA §33 cascade revokes the F1 login + kills pending invites of
 * every user LINKED to the member at erasure time. `eraseMember` reads those
 * linked users via `ContactRepo.listLinkedUserIdsForMemberInTx`, which filters
 * `removed_at IS NULL` — and the contacts scrub (`scrubPiiForMemberInTx`) sets
 * `removed_at` on EVERY contact. So the read MUST happen BEFORE the scrub;
 * otherwise the read returns `[]` and the cascade silently no-ops (the exact
 * gap the cascade exists to close).
 *
 * Unit tests can't catch this: they mock `runInTenant` and the port stubs are
 * independent, so `listLinkedUserIdsForMemberInTx` returns its canned value
 * regardless of whether the scrub ran first. Only a live-Neon run — where the
 * scrub's `removed_at` UPDATE actually shadows the linked-user SELECT in the
 * same tx snapshot — exercises the ordering. This test FAILS against the buggy
 * order (read-after-scrub → 0 revocations / 0 audit rows) and PASSES once the
 * read is hoisted above the scrubs.
 *
 * Reuses the live-Neon harness shared by `contact-scrub.test.ts` /
 * `member-scrub.test.ts` (tenant + fee/plan seed + BYPASSRLS raw select) and
 * the session-seeding pattern from `archive-cascade.test.ts`. No mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import {
  eraseMember,
  type EraseMemberDeps,
} from '@/modules/members/application/use-cases/erase-member';
import { drizzleMemberRepo } from '@/modules/members/infrastructure/db/drizzle-member-repo';
import { drizzleContactRepo } from '@/modules/members/infrastructure/db/drizzle-contact-repo';
import { drizzleAuditAdapter } from '@/modules/members/infrastructure/audit/audit-adapter';
import { authSessionRevocationPort } from '@/modules/members/infrastructure/adapters/auth-session-revocation-port';
import { drizzleInvitationCascadePort } from '@/modules/members/infrastructure/adapters/invitation-cascade-adapter';
import { noopBroadcastsCascadeAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-cascade-adapter';
import { noopRenewalsCascadeAdapter } from '@/modules/members/infrastructure/adapters/renewals-cascade-adapter';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  auditLog,
  invitations,
  sessions,
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

// ---- Test scaffold ---------------------------------------------------------

const PLAN_ID = 'test-erase-plan';

/** Build real EraseMemberDeps inline (the Task-8 composition root isn't wired
 *  yet). No-op F7/F8 cascade adapters so this test exercises ONLY the in-tx
 *  member/contact scrub + the F1 session/invitation cascade. */
function buildEraseMemberDeps(tenant: TestTenant): EraseMemberDeps {
  return {
    tenant: tenant.ctx,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    invitations: drizzleInvitationCascadePort,
    sessions: authSessionRevocationPort,
    broadcastsCascade: noopBroadcastsCascadeAdapter,
    renewalsCascade: noopRenewalsCascadeAdapter,
    audit: drizzleAuditAdapter,
    clock: { now: () => new Date() },
  };
}

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
      planName: { en: 'Erase Test Plan' },
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
      companyName: `Erase Co ${Date.now()}`,
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
      email: `erik-${randomUUID().slice(0, 8)}@example.com`,
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

/** Seed an ACTIVE session for the linked user (32-byte hex id per schema). */
async function seedActiveSession(userId: string): Promise<string> {
  const sessionId =
    randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    createdAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    sourceIp: '127.0.0.1',
  });
  return sessionId;
}

// ---- Test suite ------------------------------------------------------------

describe('eraseMember — Art.17 session/invitation cascade (Bug I-1)', () => {
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

  it('revokes the linked user session + emits user_sessions_revoked, and scrubs member+contacts', async () => {
    const { memberId, contactId } = await seedMemberWithLinkedContact(
      tenant,
      linkedUser.userId,
    );
    const sessionId = await seedActiveSession(linkedUser.userId);

    // Sanity: the session is active before erasure.
    const before = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(before).toHaveLength(1);

    const deps = buildEraseMemberDeps(tenant);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-erase-${Date.now()}` },
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);

    // 1. The linked user's session is GONE (revoked in the scrub tx).
    //    Against the buggy read-after-scrub order this list is non-empty
    //    because the revocation loop never ran.
    const remaining = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, linkedUser.userId));
    expect(remaining).toHaveLength(0);

    // 2. A user_sessions_revoked audit row exists for this user + member.
    //    Buggy order → 0 rows (cascade skipped); fixed order → ≥1.
    const revokedAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'user_sessions_revoked'),
        ),
      );
    const match = revokedAudits.find((r) => {
      const p = r.payload as { member_id?: string; user_id?: string };
      return p.member_id === memberId && p.user_id === linkedUser.userId;
    });
    expect(match, 'expected a user_sessions_revoked audit for the linked user').toBeDefined();
    expect((match!.payload as { reason?: string }).reason).toBe(
      'admin_force_erase',
    );

    // 3. Member + contacts are scrubbed (erasure still happened).
    const memberRows = await db
      .select({ erasedAt: members.erasedAt, companyName: members.companyName })
      .from(members)
      .where(eq(members.memberId, memberId));
    expect(memberRows[0]?.erasedAt).not.toBeNull();
    expect(memberRows[0]?.companyName).toBe('[erased]');

    const contactRows = await db
      .select({ removedAt: contacts.removedAt, firstName: contacts.firstName })
      .from(contacts)
      .where(eq(contacts.contactId, contactId));
    expect(contactRows[0]?.removedAt).not.toBeNull();
    expect(contactRows[0]?.firstName).toBe('[erased]');
  }, 30_000);

  it('soft-consumes a pending invitation for the linked user', async () => {
    const { memberId } = await seedMemberWithLinkedContact(
      tenant,
      linkedUser.userId,
    );

    // Seed a pending (unredeemed) invitation for the linked user.
    const invitationId = `inv-${randomUUID().replace(/-/g, '')}`;
    await db.insert(invitations).values({
      id: invitationId,
      userId: linkedUser.userId,
      invitedByUserId: admin.userId,
      intendedRole: 'member',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      consumedAt: null,
    });

    const deps = buildEraseMemberDeps(tenant);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'pdpa_deletion_request' },
      { actorUserId: admin.userId, requestId: `rq-erase-inv-${Date.now()}` },
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);

    // Against the buggy order the linked-user list is empty → the invite is
    // NEVER soft-consumed. Fixed order → consumedAt is stamped.
    const rows = await db
      .select({ consumedAt: invitations.consumedAt })
      .from(invitations)
      .where(eq(invitations.id, invitationId));
    expect(rows[0]?.consumedAt).not.toBeNull();
  }, 30_000);
});
