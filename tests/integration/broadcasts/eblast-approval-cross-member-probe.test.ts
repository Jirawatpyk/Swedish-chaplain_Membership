/**
 * F119 T073 — owning-member and tenant scope on the member decision, against
 * LIVE Postgres (Neon `dev`) through the REAL composition root
 * (`makeRecordMemberDecisionDeps`): the Drizzle repos under `runInTenant`
 * (RLS + FORCE), and the real `f7AuditAdapter` writing `audit_log`.
 *
 *   - member B of the SAME tenant cannot decide member A's E-Blast, nor read
 *     it: 404 (`not_found`) + `broadcast_cross_member_probe`, nothing written;
 *   - a member of ANOTHER tenant cannot even see the row (RLS): `not_found` +
 *     `broadcast_cross_tenant_probe`;
 *   - positive control: member A's own decision on the same row succeeds.
 *
 * The staff-session arm ("a staff session → 403 on POST …/decision") is the
 * route's, and is asserted directly in
 * `tests/contract/broadcasts/portal-eblast-decision.test.ts`.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFakeMarketingDirectory } from '../../helpers/eblast-approval-fakes';
import { db, runInTenant } from '@/lib/db';
import { makeRecordMemberDecisionDeps } from '@/lib/broadcast-approval-deps';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asBroadcastId, asBroadcastVersionId } from '@/modules/broadcasts/domain/broadcast';
import { recordMemberDecision } from '@/modules/broadcasts/application/use-cases/approval/record-member-decision';
import { getMemberBroadcast } from '@/modules/broadcasts/application/use-cases/get-member-broadcast';
import { makeGetMemberBroadcastDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import {
  broadcastMemberDecisions,
  broadcasts,
  broadcastVersions,
  type NewBroadcastRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { asMemberId } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const MARKETER = { userId: randomUUID(), email: 'marketing-probe@example.com', locale: 'en' as const };

describe('F119 T073 — member B cannot read or decide member A\'s E-Blast (live Neon)', () => {
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let userA: TestUser;
  let userB: TestUser;
  let userC: TestUser;
  let memberA: string;
  let contactA: string;
  let memberB: string;
  let contactB: string;
  let memberC: string;
  let contactC: string;
  const broadcastId = randomUUID();
  const v1Id = randomUUID();
  const planId = `plan-f119-probe-${randomUUID().slice(0, 8)}`;

  const deps = (slug: string) => ({
    ...makeRecordMemberDecisionDeps(slug),
    // The live roster is cross-tenant and shared on the dev branch; one
    // recipient keeps the enqueue count exact. The outbox INSERT is real.
    marketingDirectory: makeFakeMarketingDirectory([MARKETER]),
  });
  const decideAs = (slug: string, who: { userId: string; memberId: string; contactId: string }, requestId: string) =>
    recordMemberDecision(deps(slug), {
      broadcastId: asBroadcastId(broadcastId),
      memberId: asMemberId(who.memberId),
      actorUserId: who.userId,
      actorRole: 'member',
      contactId: who.contactId,
      versionId: asBroadcastVersionId(v1Id),
      decision: 'approved',
      reason: null,
      requestId,
    });
  const readRow = () =>
    runInTenant(tenant.ctx, async (tx) => (await tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, broadcastId)))[0]!);
  const auditsFor = (slug: string, requestId: string) =>
    db.select().from(auditLog).where(and(eq(auditLog.tenantId, slug), eq(auditLog.requestId, requestId)));

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    otherTenant = await createTestTenant('test-swecham');
    userA = await createActiveTestUser('member');
    userB = await createActiveTestUser('member');
    userC = await createActiveTestUser('member');
    await seedPortalPlan(tenant.ctx.slug, userA.userId, planId);
    await seedPortalPlan(otherTenant.ctx.slug, userC.userId, planId);
    ({ memberId: memberA, contactId: contactA } = await seedPortalMemberWithContact(tenant, planId, { linkedUserId: userA.userId }));
    ({ memberId: memberB, contactId: contactB } = await seedPortalMemberWithContact(tenant, planId, { linkedUserId: userB.userId }));
    ({ memberId: memberC, contactId: contactC } = await seedPortalMemberWithContact(otherTenant, planId, { linkedUserId: userC.userId }));

    const row: NewBroadcastRow = {
      tenantId: tenant.ctx.slug,
      broadcastId,
      requestedByMemberId: memberA,
      requestedByMemberPlanIdSnapshot: planId,
      submittedByUserId: userA.userId,
      actorRole: 'member_self_service',
      subject: 'Member A original',
      bodyHtml: '<p>A</p>',
      bodySource: 'a',
      fromName: 'Chamber',
      replyToEmail: 'reply@example.com',
      segmentType: 'all_members',
      estimatedRecipientCount: 10,
      status: 'awaiting_member_approval',
      submittedAt: new Date('2026-09-20T08:00:00.000Z'),
      proposedSendAt: new Date(Date.now() + 7 * 86_400_000),
      currentRound: 1,
    };
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values(row);
      await tx.insert(broadcastVersions).values([
        { tenantId: tenant.ctx.slug, broadcastId, versionNo: 0, subject: 'orig', bodyHtml: '<p>o</p>', bodySource: 'o', authoredByUserId: userA.userId, authoredByRole: 'member_self_service', sentToMemberAt: new Date('2026-09-20T08:00:00.000Z') },
        { tenantId: tenant.ctx.slug, id: v1Id, broadcastId, versionNo: 1, subject: 'Formatted', bodyHtml: '<p>F</p>', bodySource: 'f', authoredByUserId: MARKETER.userId, authoredByRole: 'admin_proxy', sentToMemberAt: new Date('2026-09-21T08:00:00.000Z') },
      ]);
    });
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
    await otherTenant?.cleanup().catch(() => {});
    for (const u of [userA, userB, userC]) if (u) await deleteTestUser(u).catch(() => {});
  });

  it('member B (same tenant) deciding → not_found + broadcast_cross_member_probe; no decision row, the stage unchanged', async () => {
    const requestId = `f119-probe-b-${randomUUID()}`;
    const r = await decideAs(tenant.ctx.slug, { userId: userB.userId, memberId: memberB, contactId: contactB }, requestId);
    expect(r.ok ? 'ok' : r.error.kind).toBe('not_found');

    const audits = await auditsFor(tenant.ctx.slug, requestId);
    expect(audits.map((a) => a.eventType)).toEqual(['broadcast_cross_member_probe']);
    expect(audits[0]!.payload).toEqual({ probedMemberId: memberB, probedBroadcastId: broadcastId, operation: 'member_decision' });

    expect((await readRow()).status).toBe('awaiting_member_approval');
    const decisions = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(broadcastMemberDecisions).where(eq(broadcastMemberDecisions.broadcastId, broadcastId)),
    );
    expect(decisions).toHaveLength(0);
  });

  it('member B (same tenant) reading → not_found + broadcast_cross_member_probe', async () => {
    const requestId = `f119-probe-read-${randomUUID()}`;
    const r = await getMemberBroadcast(makeGetMemberBroadcastDeps(tenant.ctx.slug), {
      memberId: asMemberId(memberB),
      broadcastId: asBroadcastId(broadcastId),
      actorUserId: userB.userId,
      requestId,
    });
    expect(r.ok ? 'ok' : r.error.kind).toBe('broadcast.not_found');
    expect((await auditsFor(tenant.ctx.slug, requestId)).map((a) => a.eventType)).toEqual(['broadcast_cross_member_probe']);
  });

  it('a member of ANOTHER tenant cannot see the row at all (RLS) → not_found + broadcast_cross_tenant_probe', async () => {
    const requestId = `f119-probe-c-${randomUUID()}`;
    const r = await decideAs(otherTenant.ctx.slug, { userId: userC.userId, memberId: memberC, contactId: contactC }, requestId);
    expect(r.ok ? 'ok' : r.error.kind).toBe('not_found');
    expect((await auditsFor(otherTenant.ctx.slug, requestId)).map((a) => a.eventType)).toEqual(['broadcast_cross_tenant_probe']);
    expect((await readRow()).status).toBe('awaiting_member_approval');
  });

  it('positive control: member A decides the same row → member_approved, one decision row, the audit carries snake_case member_id', async () => {
    const requestId = `f119-probe-a-${randomUUID()}`;
    const r = await decideAs(tenant.ctx.slug, { userId: userA.userId, memberId: memberA, contactId: contactA }, requestId);
    expect(r.ok ? r.value.status : r.error).toBe('member_approved');
    expect(await readRow()).toMatchObject({ status: 'member_approved', approvedVersionId: v1Id });
    const audits = await auditsFor(tenant.ctx.slug, requestId);
    expect(audits.map((a) => a.eventType)).toEqual(['broadcast_member_approved']);
    expect(audits[0]!.payload).toMatchObject({ member_id: memberA, broadcast_id: broadcastId, version_id: v1Id, round: 1, note_length: 0, actor_role: 'member' });
  });
});
