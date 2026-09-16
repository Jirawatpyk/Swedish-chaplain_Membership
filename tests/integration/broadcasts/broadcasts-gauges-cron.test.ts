/**
 * 108 PR-D staff review P4.1 — the gauges cron against live Neon.
 *
 * Why this file exists: the pre-push route gate printed
 *
 *   [pre-push] no integration test imports
 *   src/app/api/internal/metrics/broadcasts-gauges/route.ts — skipping
 *
 * on the very push that added a FOURTH SQL query to that route (the
 * `broadcasts.suppression_list_size` gauge over `marketing_unsubscribes`). Its
 * only other coverage is `tests/contract/broadcasts/cron-broadcasts-gauges.contract.test.ts`,
 * which mocks `db.transaction` wholesale and hands back canned rows — so it
 * pins the WIRING (which gauge families are emitted, what the summary looks
 * like) and can say nothing about whether the SQL is valid. A wrong table or
 * column name would have 500'd this cron every five minutes in production with
 * every gate green: the `void-pdf-reconcile` shape, one more time.
 *
 * This drives the exported `GET` with a real Bearer token against the live
 * Neon `dev` branch. The assertion is deliberately about REACHING the summary,
 * not about the numbers — other tenants' rows are in that branch and the
 * counts are not this test's business.
 *
 * F114 PR-3 review (B4) — the SAME argument now covers the members half. T102
 * added a second transaction with two more statements over
 * `tenant_member_settings` and `member_change_requests`, and this file is the
 * route's API-route gate: a wrong column there would have failed every five
 * minutes with `membersGaugesOk: false` in a body nobody reads. One pending
 * request is seeded so the numbers cannot be vacuously zero.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { runInTenant } from '@/lib/db';
import { marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import { asContactId, asMemberId, type UserId } from '@/modules/members';
import type { ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { drizzleChangeRequestRepo } from '@/modules/members/infrastructure/db/drizzle-change-request-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

import { GET as gaugesGet } from '@/app/api/internal/metrics/broadcasts-gauges/route';

let tenant: TestTenant;
let memberUser: TestUser;
const originalSecret = process.env.CRON_SECRET;
const SECRET = `test-cron-secret-${randomUUID()}`;

/** The F1 `TestUser.userId` carries the AUTH brand; members brands the same uuid its own way. */
const mu = (id: string): UserId => id as unknown as UserId;

beforeAll(async () => {
  tenant = await createTestTenant('test-swecham');
  process.env.CRON_SECRET = SECRET;
  // One suppression row, so the new query has something of ours to count.
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(marketingUnsubscribes).values({
      tenantId: tenant.ctx.slug,
      emailLower: `gauge-${randomUUID().slice(0, 8)}@example.test`,
      reason: 'admin_added',
    }),
  );

  // F114 B4 — one PENDING change request, so the members half's
  // `COUNT(*)` / `MIN(submitted_at)` have a row of ours to find. Seeded the
  // way `tests/integration/members/change-requests-repo.test.ts` does: plan →
  // member → primary contact linked to a portal user, so every FK is
  // satisfied. `submittedAt` is well in the past so the age is > 0 whatever
  // the clock skew between this process and Neon.
  memberUser = await createActiveTestUser('member');
  const planId = `gauge-plan-${randomUUID().slice(0, 8)}`;
  await seedPortalPlan(tenant.ctx.slug, memberUser.userId, planId);
  const memberId = randomUUID();
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Gauge Co ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId,
      planYear: 2026,
      status: 'active',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Gauge',
      lastName: 'Tester',
      email: `gauge-${contactId.slice(0, 8)}@example.com`,
      phone: '+66812345678',
      preferredLanguage: 'en',
      isPrimary: true,
      linkedUserId: memberUser.userId,
    });
  });
  const submittedAt = new Date('2026-09-11T08:00:00Z');
  const inserted = await runInTenant(tenant.ctx, (tx) =>
    drizzleChangeRequestRepo.insertInTx(tx, {
      id: randomUUID() as ChangeRequestId,
      tenantId: tenant.ctx.slug as never,
      memberId: asMemberId(memberId),
      submittedByUserId: mu(memberUser.userId),
      submittedByContactId: asContactId(contactId),
      submitterRoleAtSubmission: 'primary',
      scope: 'own_contact',
      submittedAt,
      staffNotifiedAt: submittedAt,
      fields: [
        { key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false },
      ],
    }),
  );
  // a silent seed failure would make every members assertion below vacuous
  expect(inserted.ok).toBe(true);
}, 180_000);

afterAll(async () => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  // the tenant cleanup takes the member / contact / request rows with it
  await tenant?.cleanup().catch(() => {});
  if (memberUser) await deleteTestUser(memberUser).catch(() => {});
}, 120_000);

function req(token: string): NextRequest {
  return new NextRequest('http://localhost:3100/api/internal/metrics/broadcasts-gauges', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, 'x-tenant': tenant.ctx.slug },
  });
}

describe('108 PR-D — broadcasts-gauges cron on live Neon (staff review P4.1)', () => {
  it('all five gauge queries execute and the route returns its summary', async () => {
    const res = await gaugesGet(req(SECRET));
    // A 500 here means one of the five statements is invalid against the real
    // schema — which is the only thing this file exists to catch.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('error');
  });

  it('a wrong bearer is refused before any query runs', async () => {
    const res = await gaugesGet(req('not-the-secret'));
    expect(res.status).toBe(401);
  });

  // F114 PR-3 review (B4) — the members half's two statements against the real
  // schema, with one pending row of ours in the branch. The counts are floors,
  // not equalities: other tenants' rows live on `dev` too (the file's standing
  // rule), but ZERO would mean the scan found nothing at all.
  it('the members change-request gauges run against the real schema and count the seeded pending row', async () => {
    const res = await gaugesGet(req(SECRET));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      membersGaugesOk: boolean;
      membersGaugesSkipped: string | null;
      membersPendingTenantCount: number;
      membersPendingTotal: number;
      membersOldestAgeSecondsMax: number;
    };
    // false here = one of the two members statements is invalid against the
    // live schema, which is the only thing this assertion exists to catch
    expect(body.membersGaugesOk).toBe(true);
    // the platform flag must be ON for the pending scan to run at all; if it
    // is off the numbers below are meaningless rather than wrong (SEC-5)
    expect(body.membersGaugesSkipped).toBeNull();
    expect(body.membersPendingTenantCount).toBeGreaterThanOrEqual(1);
    expect(body.membersPendingTotal).toBeGreaterThanOrEqual(1);
    // `now() - MIN(submitted_at)` over a 2026-09-11 row: seconds, not zero
    expect(body.membersOldestAgeSecondsMax).toBeGreaterThan(0);
  });
});
