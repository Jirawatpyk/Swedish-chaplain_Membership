/**
 * COMP-1 US2a (Task 7, capstone) — end-to-end live-Neon proof that
 * `eraseMember` anonymises the linked F1 login so a GDPR-Art.17 / PDPA §33
 * erased member can NO LONGER authenticate.
 *
 * US1 left an erased member's F1 login email still resolving at sign-in: the
 * member/contact rows were scrubbed, the live session revoked inside the scrub
 * tx, but the cross-tenant `users` row — which the real sign-in lookup keys on
 * (`lower(email)`) — was untouched, so the original credential still resolved.
 * US2a (Tasks 2–6) adds the F1 user-erasure cascade: a post-commit, best-effort,
 * idempotent loop over the member's linked logins that drives the auth
 * `eraseUser` use-case (anonymise email → sentinel, NULL password, disable,
 * revoke sessions, emit `user_erased`).
 *
 * This test wires the WHOLE chain — the PRODUCTION composition root
 * `buildEraseMemberDeps(ctx.tenant)` (the REAL F7/F8 cascade adapters AND the
 * REAL `authUserErasureAdapter` → real `eraseUser` → real `anonymiseErasedInTx`
 * + session revoke + `user_erased` audit) — against live Neon, on a member with
 * a real linked F1 login + a live session and NO in-flight broadcasts/renewals
 * (so the F7/F8 cascades return clean-with-zero and the F1 cascade is the
 * subject under test). It then asserts the six-part oracle:
 *
 *   1. Member + contact scrubbed (US1 invariant — reused): member identity →
 *      sentinels/NULL, `erased_at` stamped; contact `removed_at` stamped, email
 *      → `erased+…@erased.invalid` sentinel.
 *   2. Linked `users` row anonymised (US2a addition): email =
 *      `erased+{userId}@erased.invalid`, password_hash NULL, display_name
 *      '[erased]', status 'disabled', email_verified false.
 *   3. The login can no longer authenticate: `userRepo.findByEmail(original)` →
 *      null. This is the EXACT lookup `signIn` performs at step 2
 *      (`deps.users.findByEmail(normalisedEmail)` over `lower(email)`), so a
 *      null here is the credential-closure proof — chosen over wiring the full
 *      `signIn` use-case (which pulls in an Upstash rate-limiter and its quota
 *      flakiness) per the plan's "findByEmail→null is the must-have" note.
 *   4. Sessions revoked: 0 session rows for the linked user.
 *   5. Audit completeness: a `member_erased` row (US1 completion proof, gated on
 *      `cascadesComplete`) AND a `user_erased` row targeting the linked user id
 *      (US2a). Neither summary/payload carries PII (no original email).
 *   6. `cascadesComplete === true` in the `eraseMember` result.
 *
 * A SECOND case seeds a member with TWO distinct linked logins and asserts BOTH
 * are anonymised — exercising the per-user cascade loop + the unfiltered-read
 * dedup end-to-end on live Neon.
 *
 * The use-case + cascade already exist (Tasks 3–6), so this capstone passes on
 * first green — correct for a verification oracle. A confirm-can-fail (weaken
 * assertion 2 to expect password_hash NOT null) was run and observed RED.
 *
 * Reuses the live-Neon harness shared by `erase-member-cascade.test.ts` (tenant
 * + fee/plan seed + linked-contact + session seed + BYPASSRLS raw select). The
 * `user_erased` audit is emitted by the auth `eraseUser` in its OWN owner-role
 * tx (the `users` table is cross-tenant — no tenant_id), so it is queried by
 * `target_user_id` (NOT by tenant); `member_erased` is the tenant-scoped members
 * row. No mocks — the production builder + real cascades are the point.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { buildEraseMemberDeps } from '@/modules/members/members-deps';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { asEmailAddress } from '@/modules/auth/domain/branded';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  auditLog,
  sessions,
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

// ---- Test scaffold ---------------------------------------------------------

const PLAN_ID = 'test-erase-f1-user-plan';

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
      planName: { en: 'Erase F1 User Plan' },
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
 * Seed a member (rich PII) + N primary/secondary contacts, each linked to a
 * real F1 user. NO in-flight F7 broadcast / F8 renewal cycle — so the real
 * F7/F8 cascades return clean-with-zero and the F1 user-erasure cascade is the
 * subject under test (cascadesComplete stays true on its own success).
 */
async function seedMemberWithLinkedUsers(
  tenant: TestTenant,
  linkedUserIds: readonly string[],
): Promise<{ memberId: string; contactIds: string[] }> {
  const memberId = randomUUID();
  const contactIds: string[] = [];
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `F1 Erase Co ${Date.now()}`,
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: '0105536000123',
      planId: PLAN_ID,
      planYear: 2026,
      status: 'active',
    });
    for (const [i, linkedUserId] of linkedUserIds.entries()) {
      const contactId = randomUUID();
      contactIds.push(contactId);
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId,
        memberId,
        firstName: 'Erik',
        lastName: 'Eriksson',
        email: `erik-f1-${randomUUID().slice(0, 8)}@example.com`,
        phone: '+66812345678',
        roleTitle: i === 0 ? 'CEO' : 'CFO',
        preferredLanguage: 'sv',
        isPrimary: i === 0,
        dateOfBirth: '1980-01-01',
        linkedUserId,
        removedAt: null,
      });
    }
  });
  return { memberId, contactIds };
}

/** Seed an ACTIVE session for a user (64-char hex id per schema). */
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

/** BYPASSRLS raw read of a users row (the cross-tenant login account). */
async function rawSelectUser(userId: string) {
  const rows = await db
    .select({
      email: users.email,
      passwordHash: users.passwordHash,
      displayName: users.displayName,
      status: users.status,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, userId));
  return rows[0];
}

/** All `user_erased` audit rows targeting a given user (owner-tx → no tenant). */
async function rawSelectUserErasedAuditsForTarget(userId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.targetUserId, userId));
  return rows.filter((r) => r.eventType === 'user_erased');
}

/** `member_erased` audit rows for this tenant whose payload.member_id matches. */
async function rawSelectMemberErasedAudits(tenantSlug: string, memberId: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantSlug));
  return rows.filter(
    (r) =>
      r.eventType === 'member_erased' &&
      (r.payload as { member_id?: string } | null)?.member_id === memberId,
  );
}

// ---- Test suite ------------------------------------------------------------

describe('eraseMember — anonymises the linked F1 login end-to-end (COMP-1 US2a, live Neon, production deps)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPlan(tenant, admin.userId);
    // The production builder wires the REAL F8 cascade (makeRenewalsDeps) — seed
    // the renewal policies/settings fixture so that composition root is
    // well-formed even though no in-flight cycle exists for these members.
    await seedRenewalPolicies(tenant.ctx);
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('scrubs member+contact, anonymises the linked login (no resolvable email, sessions revoked), emits user_erased + member_erased, completes', async () => {
    const linkedUser = await createActiveTestUser('member');
    const originalEmail = linkedUser.email; // normalised EmailAddress (lowercased)
    try {
      const { memberId, contactIds } = await seedMemberWithLinkedUsers(tenant, [
        linkedUser.userId,
      ]);
      const contactId = contactIds[0]!;
      await seedActiveSession(linkedUser.userId);

      // Sanity: BEFORE erasure the login resolves by its original email + a
      // session is live.
      const beforeLookup = await userRepo.findByEmail(originalEmail);
      expect(beforeLookup, 'login should resolve before erasure').not.toBeNull();
      const beforeSessions = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, linkedUser.userId));
      expect(beforeSessions.length).toBeGreaterThanOrEqual(1);

      // PRODUCTION composition root — REAL F7/F8 + REAL F1 user-erasure cascade.
      const requestId = `rq-erase-f1-${Date.now()}`;
      const deps = buildEraseMemberDeps(tenant.ctx);
      const result = await eraseMember(
        asMemberId(memberId) as MemberId,
        { reason: 'gdpr_erasure_request' },
        { actorUserId: admin.userId, requestId },
        deps,
      );

      // 6. cascadesComplete — every cascade clean (no in-flight F7/F8 → ok-zero;
      //    F1 user-erasure succeeded) → member_erased emitted.
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.cascadesComplete).toBe(true);

      // 1. Member + contact scrubbed (US1 invariant, reused).
      const memberRows = await db
        .select({
          companyName: members.companyName,
          taxId: members.taxId,
          erasedAt: members.erasedAt,
        })
        .from(members)
        .where(eq(members.memberId, memberId));
      expect(memberRows[0]?.companyName).toBe('[erased]');
      expect(memberRows[0]?.taxId).toBeNull();
      expect(memberRows[0]?.erasedAt).not.toBeNull();

      const contactRows = await db
        .select({
          firstName: contacts.firstName,
          email: contacts.email,
          removedAt: contacts.removedAt,
        })
        .from(contacts)
        .where(eq(contacts.contactId, contactId));
      expect(contactRows[0]?.firstName).toBe('[erased]');
      expect(contactRows[0]?.email).toMatch(/^erased\+.*@erased\.invalid$/);
      expect(contactRows[0]?.removedAt).not.toBeNull();

      // 2. Linked users row anonymised (US2a addition).
      const userRow = await rawSelectUser(linkedUser.userId);
      expect(userRow?.email).toBe(`erased+${linkedUser.userId}@erased.invalid`);
      expect(userRow?.passwordHash).toBeNull();
      expect(userRow?.displayName).toBe('[erased]');
      expect(userRow?.status).toBe('disabled');
      expect(userRow?.emailVerified).toBe(false);

      // 3. Credential closure — the original email no longer resolves at the
      //    EXACT lookup sign-in performs (findByEmail over lower(email)).
      const afterLookup = await userRepo.findByEmail(originalEmail);
      expect(
        afterLookup,
        'erased login must not resolve by its original email',
      ).toBeNull();

      // 4. Sessions revoked — 0 rows for the linked user.
      const remainingSessions = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, linkedUser.userId));
      expect(remainingSessions).toHaveLength(0);

      // 5. Audit completeness — user_erased (US2a) + member_erased (US1), no PII.
      const userErasedAudits = await rawSelectUserErasedAuditsForTarget(
        linkedUser.userId,
      );
      expect(
        userErasedAudits.length,
        'expected a user_erased audit targeting the linked login',
      ).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(userErasedAudits)).not.toContain(
        linkedUser.rawEmail,
      );

      const memberErasedAudits = await rawSelectMemberErasedAudits(
        tenant.ctx.slug,
        memberId,
      );
      expect(
        memberErasedAudits.length,
        'expected the member_erased completion-proof audit',
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await deleteTestUser(linkedUser).catch(() => {});
    }
  }, 120_000);

  it('anonymises BOTH linked logins when a member has two (per-user loop + dedup end-to-end)', async () => {
    const linkedUserA = await createActiveTestUser('member');
    const linkedUserB = await createActiveTestUser('member');
    try {
      const { memberId } = await seedMemberWithLinkedUsers(tenant, [
        linkedUserA.userId,
        linkedUserB.userId,
      ]);
      await seedActiveSession(linkedUserA.userId);
      await seedActiveSession(linkedUserB.userId);

      const deps = buildEraseMemberDeps(tenant.ctx);
      const result = await eraseMember(
        asMemberId(memberId) as MemberId,
        { reason: 'gdpr_erasure_request' },
        { actorUserId: admin.userId, requestId: `rq-erase-f1-two-${Date.now()}` },
        deps,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.cascadesComplete).toBe(true);

      // BOTH logins anonymised + neither resolves by its original email.
      for (const u of [linkedUserA, linkedUserB]) {
        const row = await rawSelectUser(u.userId);
        expect(row?.email, `user ${u.userId} email`).toBe(
          `erased+${u.userId}@erased.invalid`,
        );
        expect(row?.passwordHash, `user ${u.userId} hash`).toBeNull();
        expect(row?.status, `user ${u.userId} status`).toBe('disabled');

        const lookup = await userRepo.findByEmail(asEmailAddress(u.rawEmail));
        expect(lookup, `user ${u.userId} must not resolve`).toBeNull();

        const erasedAudits = await rawSelectUserErasedAuditsForTarget(u.userId);
        expect(
          erasedAudits.length,
          `user_erased audit for ${u.userId}`,
        ).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await deleteTestUser(linkedUserA).catch(() => {});
      await deleteTestUser(linkedUserB).catch(() => {});
    }
  }, 120_000);
});
