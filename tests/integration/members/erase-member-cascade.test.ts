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
import { noopBroadcastsContentScrubAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-content-scrub-adapter';
import { noopBroadcastsDeliveryTombstoneAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-delivery-tombstone-adapter';
import { authUserErasureAdapter } from '@/modules/members/infrastructure/adapters/auth-user-erasure-adapter';
import { emailChangeTokenAdapter } from '@/modules/members/infrastructure/adapters/email-change-token-adapter';
import { userEmailAdapter } from '@/modules/members/infrastructure/adapters/user-email-adapter';
import { outboxCancelAdapter } from '@/modules/members/infrastructure/adapters/outbox-cancel-adapter';
import { noopEventRegistrationErasureAdapter } from '@/modules/members/infrastructure/adapters/event-registration-erasure-adapter';
import { noopDirectoryErasureAdapter } from '@/modules/members/infrastructure/adapters/directory-erasure-adapter';
import { noopBroadcastsAudienceDerivationAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-audience-derivation-adapter';
import { noopSubprocessorErasureAdapter } from '@/modules/members/infrastructure/adapters/subprocessor-erasure-adapter';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  auditLog,
  invitations,
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

// ---- Test scaffold ---------------------------------------------------------

const PLAN_ID = 'test-erase-plan';

/** Build real EraseMemberDeps inline. Deliberately NOT the production
 *  `buildEraseMemberDeps` composition root (which wires the REAL F7/F8
 *  cascades) — this test injects the no-op F7/F8 cascade adapters so it
 *  exercises ONLY the in-tx member/contact scrub + the F1 session/invitation
 *  cascade (Bug I-1), without dragging F7 broadcast / F8 renewal state in. */
function buildEraseMemberDeps(tenant: TestTenant): EraseMemberDeps {
  return {
    tenant: tenant.ctx,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    invitations: drizzleInvitationCascadePort,
    sessions: authSessionRevocationPort,
    broadcastsCascade: noopBroadcastsCascadeAdapter,
    renewalsCascade: noopRenewalsCascadeAdapter,
    // US2b — no-op F7 content-scrub adapter (mirrors the no-op F7/F8 cancel
    // cascades above): this test exercises ONLY the in-tx scrub + F1 cascade,
    // not the F7 broadcast content/deliveries redaction (that has its own
    // live-Neon coverage in erase-member-f7-content.test.ts, Task 6).
    broadcastsContentScrub: noopBroadcastsContentScrubAdapter,
    // US2b — no-op F7 delivery-tombstone adapter. The real in-tx tombstone is
    // covered live in erase-member-f7-content.test.ts; here a no-op keeps the
    // scrub tx focused on the member/contact scrub + F1 cascade.
    broadcastsDeliveryTombstone: noopBroadcastsDeliveryTombstoneAdapter,
    // US2a — the real F1 user-erasure adapter. The post-commit F1 cascade
    // (Task 6) is now WIRED: every run drives this adapter against the seeded
    // linkedUser, anonymising its `users` row (the first it() asserts the
    // resulting sentinel email / NULL password_hash / 'disabled' status).
    userErasure: authUserErasureAdapter,
    // COMP-1 US2a (M1/L1) — real adapters. This test's member has no
    // email-change tokens / outbox rows, so these run as clean no-ops.
    tokens: emailChangeTokenAdapter,
    userEmails: userEmailAdapter,
    outboxCancel: outboxCancelAdapter,
    // US2c — no-op F6 registration fan-out adapter (mirrors the no-op F7/F8
    // cancel + content-scrub cascades above): this test exercises ONLY the
    // in-tx scrub + F1 cascade, not the F6 event-registration erasure (that has
    // its own live-Neon coverage in erase-member-f6-registrations.test.ts).
    eventRegistrationErasure: noopEventRegistrationErasureAdapter,
    // COMP-1 / F9 — no-op directory-erasure adapter (this test exercises ONLY
    // the in-tx scrub + F1 cascade; the real directory_listings + logo erase is
    // covered live in tests/integration/insights/directory-erasure.test.ts).
    directoryErasure: noopDirectoryErasureAdapter,
    // US3-C — no-op sub-processor cascade adapters (this test exercises ONLY the
    // in-tx scrub + F1 cascade; the real Resend audience-derivation + removal
    // are covered live in subprocessor-erasure.test.ts).
    broadcastsAudienceDerivation: noopBroadcastsAudienceDerivationAdapter,
    subprocessorErasure: noopSubprocessorErasureAdapter,
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

    // 4. The linked F1 login is ANONYMISED — the post-commit F1 cascade
    //    (real authUserErasureAdapter → eraseUser) ran against the seeded
    //    linkedUser. Its `users` row now carries the sentinel email, a NULL
    //    password_hash, and 'disabled' status so the erased member can no
    //    longer authenticate (Art.17 login-revoke). Without this assertion the
    //    now-exercised cascade would run silently unverified.
    const userRows = await db
      .select({
        email: users.email,
        passwordHash: users.passwordHash,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, linkedUser.userId));
    expect(userRows[0]?.email).toBe(
      `erased+${linkedUser.userId}@erased.invalid`,
    );
    expect(userRows[0]?.passwordHash).toBeNull();
    expect(userRows[0]?.status).toBe('disabled');
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

  /**
   * M1 accumulators — the `member_erased` completion-proof payload must report
   * the REAL cascade counts (`sessions_revoked_total`,
   * `invitations_revoked_count`), not 0/0. The use-case captures these inside
   * the scrub tx (the `+=` accumulators) and surfaces them to the post-commit
   * `member_erased` emit (DPO-log observability — Important #2 speckit-review).
   *
   * Seeds a member + linked user with BOTH an active session AND a pending
   * invitation, then asserts the persisted audit payload reflects ≥1 of each.
   * A regression that drops the `+=` (or reads counts after a reset) would
   * surface 0/0 here while every other assertion still passes — so this locks
   * the accumulators specifically. (No F7/F8 cascades run — the no-op adapters
   * keep this run "clean" so `member_erased` is emitted with the real counts.)
   */
  it('member_erased payload reports the real sessions_revoked_total + invitations_revoked_count', async () => {
    const { memberId } = await seedMemberWithLinkedContact(
      tenant,
      linkedUser.userId,
    );
    await seedActiveSession(linkedUser.userId);

    // Exactly one pending (unredeemed) invitation for the linked user.
    const PENDING_INVITE_COUNT = 1;
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

    const requestId = `rq-erase-counts-${Date.now()}`;
    const deps = buildEraseMemberDeps(tenant);
    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId },
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      // Cascades were no-ops → the run is clean → member_erased emitted.
      expect(result.value.cascadesComplete).toBe(true);
    }

    // Pull THIS run's member_erased row (scope by requestId so a concurrent
    // erase in the shared tenant can't bleed in) and assert the M1 counts.
    const erasedRows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'member_erased'),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(erasedRows, 'expected exactly one member_erased row for this run').toHaveLength(1);
    const payload = erasedRows[0]!.payload as {
      member_id?: string;
      sessions_revoked_total?: number;
      invitations_revoked_count?: number;
    };
    expect(payload.member_id).toBe(memberId);
    // Accumulators must reflect the real cascade work, not 0/0.
    expect(payload.sessions_revoked_total).toBeGreaterThanOrEqual(1);
    expect(payload.invitations_revoked_count).toBe(PENDING_INVITE_COUNT);
  }, 30_000);

  /**
   * H3 (code-review), part 1 — APPLICATION-LAYER invariant: if the
   * linked-user read throws, `eraseMember`'s atomic scrub tx rolls back.
   *
   * The linked-user read drives the Art.17/PDPA §33 cascade. A read failure
   * (statement timeout / connection blip) must FAIL LOUD: if it were
   * swallowed to `[]`, the cascade would silently no-op (no sessions
   * revoked, no invites consumed) while the scrub still committed and
   * `member_erased` was emitted as complete — leaving the erased member's
   * F1 login alive with the US2 reconciler (keyed on member_erased) never
   * re-driving it.
   *
   * This test injects a ContactRepo whose `listLinkedUserIdsForMemberInTx`
   * throws (a stand-in for a real read failure), then asserts the erasure
   * errors (`server_error`) AND the member/contact rows are untouched —
   * proving the throw rolls the whole runInTenant scrub tx back. Because the
   * injected stub REPLACES the adapter method, this part is independent of
   * the adapter's swallow/throw behaviour (the ADAPTER's own error path is
   * locked in by part 2 below).
   */
  it('rolls the scrub tx back (server_error, no scrub) when the linked-user read throws', async () => {
    const { memberId, contactId } = await seedMemberWithLinkedContact(
      tenant,
      linkedUser.userId,
    );

    // Override ONLY the linked-user read with a throwing stub — stand-in for
    // a statement timeout / connection blip on that SELECT inside the tx.
    const throwingContactRepo: EraseMemberDeps['contactRepo'] = {
      ...drizzleContactRepo,
      listLinkedUserIdsForMemberInTx: async () => {
        throw new Error('simulated statement timeout');
      },
    };
    const deps: EraseMemberDeps = {
      ...buildEraseMemberDeps(tenant),
      contactRepo: throwingContactRepo,
    };

    const result = await eraseMember(
      asMemberId(memberId) as MemberId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: admin.userId, requestId: `rq-erase-throw-${Date.now()}` },
      deps,
    );

    // 1. The erasure fails loud — no false "complete".
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
    }

    // 2. The member row is UNTOUCHED — the throw rolled the scrub tx back.
    //    (Against a swallow-to-[] adapter the scrub would have committed.)
    const memberRows = await db
      .select({ erasedAt: members.erasedAt, companyName: members.companyName })
      .from(members)
      .where(eq(members.memberId, memberId));
    expect(memberRows[0]?.erasedAt).toBeNull();
    expect(memberRows[0]?.companyName).not.toBe('[erased]');

    // 3. The contact row is likewise un-scrubbed (still PII, not removed).
    const contactRows = await db
      .select({ removedAt: contacts.removedAt, firstName: contacts.firstName })
      .from(contacts)
      .where(eq(contacts.contactId, contactId));
    expect(contactRows[0]?.removedAt).toBeNull();
    expect(contactRows[0]?.firstName).not.toBe('[erased]');
  }, 30_000);
});
