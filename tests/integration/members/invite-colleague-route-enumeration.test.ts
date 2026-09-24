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
import { logger } from '@/lib/logger';
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
    [admin, inviter, otherMemberUser, foreignTenantUser, ownColleague].map((u) =>
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
      [otherMemberUser.rawEmail, foreignTenantUser.rawEmail, admin.rawEmail].map(async (email) => {
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
      await invitePost(inviteRequest(otherMemberUser.rawEmail));
      const call = warn.mock.calls.find(
        (c) => c[1] === 'portal.contacts.invite.unavailable',
      );
      expect(call).toBeDefined();
      const fields = call?.[0] as Record<string, unknown>;
      expect(fields.reason).toBe('email_registered_elsewhere');
      expect(typeof fields.emailHash).toBe('string');
      expect(JSON.stringify(call)).not.toContain(otherMemberUser.rawEmail);
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
});
