/**
 * 108 PR-C T088 — the two recipient-count routes on live Neon through the
 * REAL gates (`requireMemberContext`, `requireApiPermission` over a real
 * session lookup), the real RLS-scoped bridge/repos and the real limiter.
 * Only `@/lib/auth-session` is mocked (the session is the caller's identity;
 * everything after it is production code) — the same shape as the PR-D route
 * proofs, and what the pre-push API-route gate looks for (a test importing
 * the literal `@/app/api/.../route` path).
 *
 * The suite runs with the cutover flag OFF (the test env), i.e. the
 * `primary_only` leg: the count is the number of OTHER eligible members with
 * a primary contact.
 *
 * Simulated addresses only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { isF71aUs1Enabled } from '@/modules/broadcasts/infrastructure/feature-flags';
import { DELIVERABLE_RECIPIENTS_PER_TICK } from '@/modules/broadcasts/domain/audience-ceiling';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const getCurrentSessionMock = vi.fn();
vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...a: unknown[]) => getCurrentSessionMock(...a),
  requireSession: (...a: unknown[]) => getCurrentSessionMock(...a),
}));

import { GET as memberCountGet } from '@/app/api/broadcasts/recipient-count/route';
import { GET as adminCountGet } from '@/app/api/admin/broadcasts/recipient-count/route';

let tenant: TestTenant;
let otherTenant: TestTenant | undefined;
let foreignMemberId: string;
let admin: TestUser;
let manager: TestUser;
let memberUser: TestUser;
let memberId: string;
let peerId: string;

function sessionAs(user: TestUser, role: 'admin' | 'manager' | 'member'): void {
  getCurrentSessionMock.mockResolvedValue({
    session: { id: `sess-${randomUUID()}` },
    user: { id: user.userId, role, email: user.rawEmail },
  });
}

const reqId = (): string => randomUUID();

function makeRequest(path: string, requestId: string): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, {
    method: 'GET',
    headers: { 'x-tenant': tenant.ctx.slug, 'x-request-id': requestId },
  });
}

async function auditRowsFor(requestId: string) {
  return db
    .select({ eventType: auditLog.eventType, payload: auditLog.payload })
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, requestId)));
}

beforeAll(async () => {
  admin = await createActiveTestUser('admin');
  manager = await createActiveTestUser('manager');
  memberUser = await createActiveTestUser('member');
  tenant = await createTestTenant('test-swecham');
  const planId = `cnt-${randomUUID().slice(0, 6)}`;
  await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
  const tag = randomUUID().slice(0, 8);
  const me = await seedPortalMemberWithContact(tenant, planId, {
    linkedUserId: memberUser.userId,
    contactEmail: `cnt-me-${tag}@example.test`,
  });
  memberId = me.memberId as string;
  const peer = await seedPortalMemberWithContact(tenant, planId, { contactEmail: `cnt-p2-${tag}@example.test` });
  peerId = peer.memberId as string;
  await seedPortalMemberWithContact(tenant, planId, { contactEmail: `cnt-p3-${tag}@example.test` });
  // Review 2026-09-07 round 2 (security test gap 1) — a REAL member of
  // another tenant, so the route-level probe is proven with the exact input
  // an attacker would use, not a random UUID.
  otherTenant = await createTestTenant('test-chamber');
  const otherPlanId = `cnt-o-${randomUUID().slice(0, 6)}`;
  await seedPortalPlan(otherTenant.ctx.slug, admin.userId, otherPlanId);
  const foreign = await seedPortalMemberWithContact(otherTenant, otherPlanId, {
    contactEmail: `cnt-foreign-${tag}@example.test`,
  });
  foreignMemberId = foreign.memberId as string;
}, 120_000);

afterAll(async () => {
  await tenant.cleanup().catch(() => {});
  await otherTenant?.cleanup().catch(() => {});
  await Promise.all([admin, manager, memberUser].map((u) => deleteTestUser(u).catch(() => {})));
}, 120_000);

describe('108 PR-C T088 — recipient-count routes (live Neon, real gates)', () => {
  it('member: all_members counts the OTHER eligible members (self excluded) — numbers only', async () => {
    sessionAs(memberUser, 'member');
    const res = await memberCountGet(makeRequest('/api/broadcasts/recipient-count?segment=all_members', reqId()));
    expect(res.status).toBe(200);
    const body = await res.json();
    // The ceiling restated from the FLAGS (FR-042 + review H-2: 50,000 only
    // when batching AND the 1:N flag are both on), never from
    // `currentAudienceCeiling()` itself — that comparison was a tautology
    // (review BLOCKER); the composition root's own unit test pins the matrix.
    //
    // T095 (2026-09-08) added the second half: what the flags CONFIGURE is
    // clamped to what one dispatch tick can actually push. Restated here the
    // same way — from the flags and the Domain constant, not from the function
    // under test — so this stays an independent statement of the rule rather
    // than an echo of it.
    const configured = isF71aUs1Enabled() && env.features.contactMarketingRecipients ? 50_000 : 5_000;
    const expectedCeiling = Math.min(configured, DELIVERABLE_RECIPIENTS_PER_TICK);
    // No `orphans` on the member body (review M-3): it is about OTHER members.
    //
    // And no `droppedByPreference` either, whenever the count is non-zero.
    // FIXED 2026-09-08: this expectation still listed it and had been RED on
    // `main` since PR-C (#346, `91505b8f2`) — that PR's `/code-review` finding
    // #4 made the route strip the field for exactly the same reason M-3
    // stripped `orphans` (it is a count of other members' contacts who
    // objected, pollable 30×/min and probeable tier by tier), but the
    // assertion was never updated. Nothing caught it: this file is not in the
    // per-PR integration gate. The field survives only at count 0, where the
    // "everyone objected" empty-state copy needs it.
    expect(body).toEqual({ count: 2, ceiling: expectedCeiling, exceeds: false });
    expect(body).not.toHaveProperty('droppedByPreference');
    expect(body).not.toHaveProperty('orphans');
    expect(JSON.stringify(body)).not.toMatch(/@|-4[0-9a-f]{3}-/);
  });

  it('member: the custom list is not counted server-side → 400 invalid_query', async () => {
    sessionAs(memberUser, 'member');
    const res = await memberCountGet(makeRequest('/api/broadcasts/recipient-count?segment=custom', reqId()));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_query');
  });

  it('admin: counts for the proxied member with THAT member self-excluded', async () => {
    sessionAs(admin, 'admin');
    const forMe = await adminCountGet(
      makeRequest(`/api/admin/broadcasts/recipient-count?member_id=${memberId}&segment=all_members`, reqId()),
    );
    expect(forMe.status).toBe(200);
    expect((await forMe.json()).count).toBe(2);
    const forPeer = await adminCountGet(
      makeRequest(`/api/admin/broadcasts/recipient-count?member_id=${peerId}&segment=all_members`, reqId()),
    );
    expect(forPeer.status).toBe(200);
    expect((await forPeer.json()).count).toBe(2);
  });

  it('admin: a REAL member of ANOTHER tenant → 404 + member_cross_tenant_probe, indistinguishable from unknown (Principle I.3 at the route)', async () => {
    sessionAs(admin, 'admin');
    const requestId = reqId();
    const res = await adminCountGet(
      makeRequest(`/api/admin/broadcasts/recipient-count?member_id=${foreignMemberId}&segment=all_members`, requestId),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('broadcast_member_not_found');
    const rows = await auditRowsFor(requestId);
    const probe = rows.find((r) => r.eventType === 'member_cross_tenant_probe');
    expect(probe).toBeDefined();
    expect(probe?.payload).toMatchObject({ attempted_member_id: foreignMemberId, surface: 'recipient_count' });
    // Numbers and ids only — never the foreign member's address or name.
    expect(JSON.stringify(probe?.payload)).not.toMatch(/@|foreign/i);
  });

  it('admin: an unknown member_id → 404 + member_cross_tenant_probe audit carrying ids only', async () => {
    sessionAs(admin, 'admin');
    const requestId = reqId();
    const unknown = randomUUID();
    const res = await adminCountGet(
      makeRequest(`/api/admin/broadcasts/recipient-count?member_id=${unknown}&segment=all_members`, requestId),
    );
    expect(res.status).toBe(404);
    const rows = await auditRowsFor(requestId);
    const probe = rows.find((r) => r.eventType === 'member_cross_tenant_probe');
    expect(probe).toBeDefined();
    expect(probe?.payload).toMatchObject({ attempted_member_id: unknown, surface: 'recipient_count' });
    expect(JSON.stringify(probe?.payload)).not.toMatch(/@/);
  });

  it('admin: manager lacks broadcasts.write → 403, no count', async () => {
    sessionAs(manager, 'manager');
    const res = await adminCountGet(
      makeRequest(`/api/admin/broadcasts/recipient-count?member_id=${memberId}&segment=all_members`, reqId()),
    );
    expect(res.status).toBe(403);
  });
});
