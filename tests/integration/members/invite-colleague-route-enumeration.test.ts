/**
 * Portal "Invite colleague" — account-enumeration leak (PDPA/GDPR oracle).
 *
 * `users.email` is unique across the WHOLE users table, so F1 `createUser`
 * answers `email-taken` for an address that belongs to anyone: another member
 * company, a staff user, another tenant. The route used to pass that straight
 * back to the member as `409 email_taken` / "Email already registered", which
 * let any portal primary contact test whether an arbitrary address has a
 * Chamber-OS account.
 *
 * The member-facing answer for an address they cannot already see must be
 * neutral and identical whatever the cause. The one allowed exception is an
 * address that already belongs to a live contact of the SAME member — that
 * contact list is already visible to them on /portal/profile.
 *
 * Drives the REAL route (`requireMemberContext`, `buildMembersDeps`, F1
 * `createUser`) against Postgres; only the session read is mocked, as in
 * `tests/integration/broadcasts/recipient-count-routes.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { sha256Hex } from '@/lib/crypto';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const getCurrentSessionMock = vi.fn();
vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...a: unknown[]) => getCurrentSessionMock(...a),
  requireSession: (...a: unknown[]) => getCurrentSessionMock(...a),
}));

import { POST as invitePost } from '@/app/api/portal/contacts/invite/route';

let tenant: TestTenant;
let otherTenant: TestTenant;
let admin: TestUser;
let inviter: TestUser;
/** Portal user of ANOTHER member company in the same tenant. */
let otherMemberUser: TestUser;
/** Portal user of a member in ANOTHER tenant. */
let foreignTenantUser: TestUser;
/** A colleague already on the inviter's own member (linked secondary contact). */
let ownColleague: TestUser;
/** Live contact of ANOTHER member that has NO F1 account (no user row). */
let otherMemberContactOnlyEmail: string;
/** Primary contact of a separate member, used only by the rate-limit test. */
let throttledInviter: TestUser;

function sessionAs(user: TestUser): void {
  getCurrentSessionMock.mockResolvedValue({
    session: { id: `sess-${randomUUID()}` },
    user: { id: user.userId, role: 'member', email: user.rawEmail },
  });
}

function inviteRequest(email: string): NextRequest {
  return new NextRequest('http://localhost:3100/api/portal/contacts/invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant': tenant.ctx.slug,
      'x-request-id': randomUUID(),
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ first_name: 'Probe', last_name: 'Target', email }),
  });
}

beforeAll(async () => {
  admin = await createActiveTestUser('admin');
  inviter = await createActiveTestUser('member');
  otherMemberUser = await createActiveTestUser('member');
  foreignTenantUser = await createActiveTestUser('member');
  ownColleague = await createActiveTestUser('member');
  throttledInviter = await createActiveTestUser('member');

  tenant = await createTestTenant('test-swecham');
  const planId = `enum-${randomUUID().slice(0, 6)}`;
  await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);

  const mine = await seedPortalMemberWithContact(tenant, planId, {
    linkedUserId: inviter.userId,
    contactEmail: inviter.rawEmail,
    isPrimary: true,
  });
  // A colleague already on MY member — visible to me on /portal/profile.
  const { runInTenant } = await import('@/lib/db');
  const { contacts } = await import('@/modules/members/infrastructure/db/schema-contacts');
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId: mine.memberId,
      firstName: 'Own',
      lastName: 'Colleague',
      email: ownColleague.rawEmail,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId: ownColleague.userId,
      removedAt: null,
    }),
  );

  // Another member company in the same tenant, with its own portal user.
  await seedPortalMemberWithContact(tenant, planId, {
    linkedUserId: otherMemberUser.userId,
    contactEmail: otherMemberUser.rawEmail,
  });

  // Another member whose primary contact has no portal account at all.
  otherMemberContactOnlyEmail = `enum-contact-only-${randomUUID().slice(0, 8)}@example.test`;
  await seedPortalMemberWithContact(tenant, planId, {
    linkedUserId: null,
    contactEmail: otherMemberContactOnlyEmail,
  });

  // A separate member for the rate-limit test, so its bucket starts empty.
  await seedPortalMemberWithContact(tenant, planId, {
    linkedUserId: throttledInviter.userId,
    contactEmail: throttledInviter.rawEmail,
    isPrimary: true,
  });

  // A member in another tenant (users are global; members/contacts are not).
  otherTenant = await createTestTenant('test-chamber');
  const otherPlanId = `enum-o-${randomUUID().slice(0, 6)}`;
  await seedPortalPlan(otherTenant.ctx.slug, admin.userId, otherPlanId);
  await seedPortalMemberWithContact(otherTenant, otherPlanId, {
    linkedUserId: foreignTenantUser.userId,
    contactEmail: foreignTenantUser.rawEmail,
  });
}, 120_000);

afterAll(async () => {
  await tenant.cleanup().catch(() => {});
  await otherTenant.cleanup().catch(() => {});
  await Promise.all(
    [admin, inviter, otherMemberUser, foreignTenantUser, ownColleague, throttledInviter].map((u) =>
      deleteTestUser(u).catch(() => {}),
    ),
  );
}, 120_000);

describe('POST /api/portal/contacts/invite — no account-existence oracle', () => {
  it('an address registered to a user of a DIFFERENT member gets the neutral response, not email_taken', async () => {
    sessionAs(inviter);
    const res = await invitePost(inviteRequest(otherMemberUser.rawEmail));
    const body = await res.json();

    expect(body.error?.code).not.toBe('email_taken');
    expect(JSON.stringify(body)).not.toMatch(/registered|exists|taken/i);
    expect(res.status).toBe(409);
    expect(body).toEqual({ error: { code: 'invite_unavailable' } });
  });

  it('staff, another tenant’s member and another member all get a byte-identical answer', async () => {
    sessionAs(inviter);
    const answers = await Promise.all(
      [
        otherMemberUser.rawEmail,
        foreignTenantUser.rawEmail,
        admin.rawEmail,
        // a contact of another member with NO account — used to be a distinct
        // 500 link_failed (contacts_tenant_email_uniq) after minting a user
        otherMemberContactOnlyEmail,
      ].map(async (email) => {
        const res = await invitePost(inviteRequest(email));
        return { status: res.status, text: await res.text() };
      }),
    );
    expect(new Set(answers.map((a) => `${a.status} ${a.text}`)).size).toBe(1);
  });

  it('the real cause is logged for staff with a hashed address, never the raw email', async () => {
    sessionAs(inviter);
    const warn = vi.spyOn(logger, 'warn');
    try {
      // A staff account: registered, but not a contact of any member.
      await invitePost(inviteRequest(admin.rawEmail));
      const call = warn.mock.calls.find(
        (c) => c[1] === 'portal.contacts.invite.unavailable',
      );
      expect(call).toBeDefined();
      const fields = call?.[0] as Record<string, unknown>;
      expect(fields.reason).toBe('email_registered_elsewhere');
      // docs/observability.md § 3 — `hashed:sha256(email)[0..8]`.
      expect(fields.emailHash).toBe(
        `hashed:${sha256Hex(admin.rawEmail.toLowerCase()).slice(0, 8)}`,
      );
      expect(JSON.stringify(call)).not.toContain(admin.rawEmail);
    } finally {
      warn.mockRestore();
    }
  });

  it('an address already on MY member keeps the specific email_taken (already visible to me)', async () => {
    sessionAs(inviter);
    const res = await invitePost(inviteRequest(ownColleague.rawEmail.toUpperCase()));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('email_taken');
  });

  it('a contact of another member with no account gets the neutral answer and mints no F1 user', async () => {
    sessionAs(inviter);
    const res = await invitePost(inviteRequest(otherMemberContactOnlyEmail));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'invite_unavailable' } });
    const minted = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, otherMemberContactOnlyEmail as never));
    expect(minted).toEqual([]);
  });

  it('attempts are capped per member (10/h), counted before any account is created', async () => {
    sessionAs(throttledInviter);
    for (let i = 0; i < 10; i += 1) {
      const res = await invitePost(inviteRequest(otherMemberUser.rawEmail));
      expect(res.status).toBe(409);
    }
    // 11th: throttled whether or not the address has an account …
    const registered = await invitePost(inviteRequest(otherMemberUser.rawEmail));
    const freshEmail = `enum-fresh-${randomUUID().slice(0, 8)}@example.test`;
    const fresh = await invitePost(inviteRequest(freshEmail));
    expect(registered.status).toBe(429);
    expect(fresh.status).toBe(429);
    // Same code for both (retry-after seconds are time-based, so not compared).
    const [a, b] = await Promise.all([registered.json(), fresh.json()]);
    expect(a.error.code).toBe('rate_limited');
    expect(b.error.code).toBe(a.error.code);
    // … and a throttled fresh address never reached createUser.
    const minted = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, freshEmail as never));
    expect(minted).toEqual([]);
    // 12 sequential requests; with Upstash unreachable (local / CI placeholder
    // creds) each limiter call waits for the in-memory fallback.
  }, 180_000);
});
