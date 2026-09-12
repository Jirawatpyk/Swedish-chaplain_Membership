/**
 * F114 T033 — two-layer tenant isolation for the PR-1 change-request
 * surfaces, on live Neon (Constitution I.3, SC-009).
 *
 * Two tenants (A, B), one member + one linked person + one PENDING request
 * each. Every PR-1 use case is driven with the OTHER tenant's context against
 * this tenant's ids, in BOTH directions, through the REAL Drizzle repos (RLS
 * FORCE + `runInTenant`):
 *
 *   reads  — the gate (tenant setting) is the caller's own; the submitter's
 *            pending request, the staff queue, the review read and the
 *            per-member list from the other tenant see NOTHING / `not_found`;
 *   writes — decide, acknowledge and a submit that names the other tenant's
 *            member + contact are refused, leave the rows untouched and are
 *            audited as `member_cross_tenant_probe` in the PROBING tenant
 *            (decide / acknowledge / review — the unconditional-on-miss rule
 *            get-member.ts applies; a submit is refused by the own-contact
 *            IDOR guard before any request row is read).
 *
 * The route mappings (404 problem / `{ error: 'not_found' }`) are pinned in
 * the contract suites; this file proves the layer underneath them. US4–US6
 * surfaces (history routes, withdraw, the tenant setting write) extend it
 * when they land.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import {
  acknowledgeChangeRequest,
  asContactId,
  asMemberId,
  decideChangeRequest,
  drizzleChangeRequestRepo,
  drizzleContactRepo,
  drizzleMemberRepo,
  drizzleTenantMemberChangeSettingsRepo,
  f3DrizzleAuditAdapter,
  getChangeRequestReview,
  getPortalChangeRequest,
  listChangeRequestQueue,
  listMemberChangeRequests,
  listPortalChangeRequests,
  makeMemberChangeGateResolver,
  submitChangeRequest,
  withdrawChangeRequest,
  type ChangeRequestId,
  type UserId,
} from '@/modules/members';
import { resendEmailPort } from '@/modules/members/infrastructure/adapters/resend-email-port';
import { memberChangeRequests } from '@/modules/members/infrastructure/db/schema-change-requests';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const mu = (id: string): UserId => id as unknown as UserId;

interface Seeded {
  tenant: TestTenant;
  user: TestUser;
  reviewer: TestUser;
  memberId: string;
  contactId: string;
  requestId: ChangeRequestId;
}

const clock = { now: () => new Date() };

function submitDeps(t: TestTenant) {
  return {
    tenant: t.ctx,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    emails: resendEmailPort,
    reviewers: { listReviewers: async () => [] },
    clock,
    newRequestId: () => randomUUID() as ChangeRequestId,
  };
}

function decideDeps(t: TestTenant) {
  return {
    tenant: t.ctx,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    emails: resendEmailPort,
    clock,
  };
}

async function seedTenant(prefix: 'test-swecham' | 'test-chamber'): Promise<Seeded> {
  const tenant = await createTestTenant(prefix);
  const user = await createActiveTestUser('member');
  const reviewer = await createActiveTestUser('admin');
  const planId = `cr-iso-${randomUUID().slice(0, 8)}`;
  await seedPortalPlan(tenant.ctx.slug, user.userId, planId);
  const memberId = randomUUID();
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Iso Co ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId,
      planYear: 2026,
      status: 'active',
      addressLine1: '1 Main Rd',
      city: 'Bangkok',
      postalCode: '10110',
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Anna',
      lastName: 'Svensson',
      email: `iso-${contactId.slice(0, 8)}@example.com`,
      phone: '+66812345678',
      preferredLanguage: 'en',
      isPrimary: true,
      linkedUserId: user.userId,
    });
  });
  await runInTenant(tenant.ctx, (tx) => drizzleTenantMemberChangeSettingsRepo.setApprovalEnabledInTx(tx, tenant.ctx.slug, true));
  const submitted = await submitChangeRequest(submitDeps(tenant), {
    memberId: asMemberId(memberId),
    contactId: asContactId(contactId),
    rawBody: { contact: { phone: '+66899999999' } },
    actorUserId: mu(user.userId),
    actorRole: 'member',
    requestId: `req-seed-${prefix}`,
  });
  if (!submitted.ok || submitted.value.outcome !== 'submitted') throw new Error(`seed submit failed: ${JSON.stringify(submitted)}`);
  return { tenant, user, reviewer, memberId, contactId, requestId: submitted.value.request.id };
}

async function probeAudits(t: TestTenant, actorUserId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, t.ctx.slug), eq(auditLog.eventType, 'member_cross_tenant_probe'), eq(auditLog.actorUserId, actorUserId)));
}

async function requestRow(id: string) {
  const [row] = await db.select().from(memberChangeRequests).where(eq(memberChangeRequests.id, id));
  return row;
}

describe('change requests — two-layer tenant isolation on live Neon (T033)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    a = await seedTenant('test-swecham');
    b = await seedTenant('test-chamber');
  }, 120_000);

  afterAll(async () => {
    await a.tenant.cleanup().catch(() => {});
    await b.tenant.cleanup().catch(() => {});
    await Promise.all([a.user, a.reviewer, b.user, b.reviewer].map((u) => deleteTestUser(u).catch(() => {})));
  });

  const directions = (): Array<[string, () => Seeded, () => Seeded]> => [
    ['B → A', () => b, () => a],
    ['A → B', () => a, () => b],
  ];

  describe.each(directions())('%s', (_label, probe, target) => {
    it('reads: the other tenant sees nothing — pending lookup, queue, review, per-member list', async () => {
      const p = probe();
      const t = target();
      const pending = await runInTenant(p.tenant.ctx, (tx) => drizzleChangeRequestRepo.findPendingBySubmitterInTx(tx, mu(t.user.userId)));
      expect(pending).toEqual({ ok: true, value: null });

      const queue = await drizzleChangeRequestRepo.listQueue(p.tenant.ctx, { state: 'pending' }, { cursor: null, limit: 50 });
      expect(queue.ok && queue.value.items.map((r) => r.request.id)).not.toContain(t.requestId);
      expect(queue.ok && queue.value.items.every((r) => r.request.tenantId === p.tenant.ctx.slug)).toBe(true);

      const byMember = await drizzleChangeRequestRepo.listByMember(p.tenant.ctx, asMemberId(t.memberId), { cursor: null, limit: 50 });
      expect(byMember).toEqual({ ok: true, value: { items: [], nextCursor: null } });

      const review = await getChangeRequestReview(
        { tenant: p.tenant.ctx, changeRequestRepo: drizzleChangeRequestRepo, memberRepo: drizzleMemberRepo, contactRepo: drizzleContactRepo, audit: f3DrizzleAuditAdapter },
        { changeRequestId: t.requestId, canWrite: true, actor: { userId: mu(p.reviewer.userId), role: 'admin', requestId: 'req-iso-review' } },
      );
      expect(review).toEqual({ ok: false, error: { type: 'not_found' } });

      // the gate is per tenant: the probing tenant's own setting, never the target's
      const gate = makeMemberChangeGateResolver({
        flags: { memberChangeApproval: () => true },
        tenantMemberSettings: drizzleTenantMemberChangeSettingsRepo,
      });
      expect(await gate.resolve(p.tenant.ctx)).toBe('approval');
    }, 60_000);

    it('writes: decide / acknowledge / submit against the other tenant refuse, leave the rows untouched, and are audited as member_cross_tenant_probe', async () => {
      const p = probe();
      const t = target();
      const before = await requestRow(t.requestId);
      expect(before?.state).toBe('pending');

      const decided = await decideChangeRequest(decideDeps(p.tenant), {
        changeRequestId: t.requestId,
        decisions: [{ key: 'phone', outcome: 'approved' }],
        reason: null,
        note: null,
        actorUserId: mu(p.reviewer.userId),
        actorRole: 'admin',
        requestId: 'req-iso-decide',
      });
      expect(decided).toEqual({ ok: false, error: { type: 'not_found' } });

      const acknowledged = await acknowledgeChangeRequest(
        { tenant: p.tenant.ctx, changeRequestRepo: drizzleChangeRequestRepo, audit: f3DrizzleAuditAdapter, clock },
        { changeRequestId: t.requestId, actorUserId: mu(t.user.userId), actorRole: 'member', requestId: 'req-iso-ack' },
      );
      expect(acknowledged).toEqual({ ok: false, error: { type: 'not_found' } });

      // a submit naming the other tenant's member + contact: the own-contact
      // guard reads the contact under the probing tenant → not_found (RLS)
      const submitted = await submitChangeRequest(submitDeps(p.tenant), {
        memberId: asMemberId(t.memberId),
        contactId: asContactId(t.contactId),
        rawBody: { contact: { phone: '+66877777777' } },
        actorUserId: mu(t.user.userId),
        actorRole: 'member',
        requestId: 'req-iso-submit',
      });
      expect(submitted).toEqual({ ok: false, error: { type: 'not_found' } });

      const after = await requestRow(t.requestId);
      expect(after).toEqual(before);
      const [contact] = await db.select({ phone: contacts.phone }).from(contacts).where(eq(contacts.contactId, t.contactId));
      expect(contact?.phone).toBe('+66812345678');

      // the probes are audited in the PROBING tenant with the true actor
      const reviewerProbes = await probeAudits(p.tenant, p.reviewer.userId);
      expect(reviewerProbes.map((r) => (r.payload as { action?: string }).action).sort()).toEqual(['decide', 'review']);
      for (const row of reviewerProbes) {
        expect(row.payload).toMatchObject({ attempted_change_request_id: t.requestId, actor_tenant_id: p.tenant.ctx.slug, actor_role: 'admin' });
      }
      const memberProbes = await probeAudits(p.tenant, t.user.userId);
      expect(memberProbes.some((r) => (r.payload as { action?: string }).action === 'acknowledge')).toBe(true);
      // nothing was audited in the TARGET tenant by the probing actors
      expect(await probeAudits(t.tenant, p.reviewer.userId)).toHaveLength(0);
    }, 60_000);

    // PR-2 (US4 + US5): the history reads and the withdraw
    it('US4 / US5: the history reads see nothing; a withdraw from the other tenant finds no pending request and leaves the row pending', async () => {
      const p = probe();
      const t = target();
      const listDeps = { tenant: p.tenant.ctx, changeRequestRepo: drizzleChangeRequestRepo, clock };

      const portal = await listPortalChangeRequests(listDeps, { userId: mu(t.user.userId), memberId: asMemberId(t.memberId), cursor: null, limit: 20 });
      expect(portal).toEqual({ ok: true, value: { items: [], nextCursor: null } });
      const one = await getPortalChangeRequest(listDeps, { changeRequestId: t.requestId, userId: mu(t.user.userId), memberId: asMemberId(t.memberId) });
      expect(one).toEqual({ ok: false, error: { type: 'not_found' } });
      const history = await listMemberChangeRequests(listDeps, { memberId: asMemberId(t.memberId), cursor: null, limit: 20 });
      expect(history).toEqual({ ok: true, value: { items: [], nextCursor: null } });
      const queue = await listChangeRequestQueue(listDeps, { filter: { memberId: asMemberId(t.memberId) }, cursor: null, limit: 20 });
      expect(queue.ok && queue.value.items).toEqual([]);

      const before = await requestRow(t.requestId);
      const withdrawn = await withdrawChangeRequest(
        { tenant: p.tenant.ctx, changeRequestRepo: drizzleChangeRequestRepo, audit: f3DrizzleAuditAdapter, clock },
        { actorUserId: mu(t.user.userId), actorRole: 'member', requestId: 'req-iso-withdraw' },
      );
      expect(withdrawn).toEqual({ ok: false, error: { type: 'no_pending_request' } });
      expect(await requestRow(t.requestId)).toEqual(before);
      expect(before?.state).toBe('pending');
    }, 60_000);
  });
});
