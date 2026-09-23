/**
 * F119 T059 / T060 + the `stage_entered_at` stamp — against LIVE Postgres
 * (Neon `dev`), through the REAL composition root
 * (`src/lib/broadcast-approval-deps.ts`): the Drizzle repos, the members +
 * auth barrels behind the portal-contact read, the image allow-list and the
 * real outbox INSERT. What the in-memory fakes cannot prove, this does:
 *
 *   - `applyTransition` stamps `stage_entered_at` on a transition whose
 *     caller passed none (the pre-F119 approve / reject / cancel / dispatch
 *     paths — T117's badge and T121's gauges read it);
 *   - the send stamps the version, and the version trigger then refuses an
 *     edit; the outbox row lands with ids-only `context_data` in the
 *     contact's language, in the same tx; a member with no ACTIVE portal
 *     login is refused;
 *   - the promotion copies the approved version onto `broadcasts`
 *     byte-for-byte through the trigger's E1 exemption, in ONE statement with
 *     the status flip — and a direct content UPDATE afterwards is still
 *     refused.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import { makeConfirmScheduleDeps, makeSendVersionToMemberDeps } from '@/lib/broadcast-approval-deps';
import { auditLog, notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { approveBroadcast } from '@/modules/broadcasts/application/use-cases/approve-broadcast';
import { sendVersionToMember } from '@/modules/broadcasts/application/use-cases/approval/send-version-to-member';
import { confirmSchedule } from '@/modules/broadcasts/application/use-cases/approval/confirm-schedule';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { broadcasts, broadcastVersions, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const SUBMITTED_AT = new Date('2026-09-20T08:00:00.000Z');
const LONG_AGO = new Date('2026-09-01T00:00:00.000Z');
const MARKETER = randomUUID();

describe('F119 send + promotion + the stage clock — real composition on live Postgres', () => {
  let tenant: TestTenant;
  let portalUser: TestUser;
  let memberId: string;
  const planId = `plan-f119-send-${randomUUID().slice(0, 8)}`;

  const seed = (patch: Partial<NewBroadcastRow>): NewBroadcastRow => ({
    tenantId: tenant.ctx.slug,
    broadcastId: randomUUID(),
    requestedByMemberId: memberId,
    requestedByMemberPlanIdSnapshot: planId,
    submittedByUserId: portalUser.userId,
    actorRole: 'member_self_service',
    subject: 'Member original subject',
    bodyHtml: '<p>Member original</p>',
    bodySource: 'original-source',
    fromName: 'Chamber',
    replyToEmail: 'reply@example.com',
    segmentType: 'all_members',
    estimatedRecipientCount: 10,
    status: 'submitted',
    submittedAt: SUBMITTED_AT,
    scheduledFor: new Date(Date.now() + 7 * 86_400_000),
    proposedSendAt: new Date(Date.now() + 7 * 86_400_000),
    stageEnteredAt: LONG_AGO,
    ...patch,
  });
  const readRow = (id: string) =>
    runInTenant(tenant.ctx, async (tx) => (await tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, id)))[0]!);
  const readOutbox = (broadcastId: string) =>
    db
      .select()
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.tenantId, tenant.ctx.slug))
      .then((rows) => rows.filter((r) => (r.contextData as { broadcastId?: string }).broadcastId === broadcastId));
  const seedVersions = (broadcastId: string, v1: { id: string; sentToMemberAt: Date | null; subject?: string; bodyHtml?: string; bodySource?: string }) =>
    runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcastVersions).values([
        { tenantId: tenant.ctx.slug, broadcastId, versionNo: 0, subject: 'orig', bodyHtml: '<p>o</p>', bodySource: 'o', authoredByUserId: portalUser.userId, authoredByRole: 'member_self_service', sentToMemberAt: SUBMITTED_AT },
        {
          tenantId: tenant.ctx.slug,
          id: v1.id,
          broadcastId,
          versionNo: 1,
          subject: v1.subject ?? 'Formatted by the chamber',
          bodyHtml: v1.bodyHtml ?? '<p>Formatted body</p>',
          bodySource: v1.bodySource ?? 'formatted-source',
          noteToMember: 'Please check the date.',
          authoredByUserId: MARKETER,
          authoredByRole: 'admin_proxy',
          sentToMemberAt: v1.sentToMemberAt,
        },
      ]),
    );

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    portalUser = await createActiveTestUser('member');
    await seedPortalPlan(tenant.ctx.slug, portalUser.userId, planId);
    ({ memberId } = await seedPortalMemberWithContact(tenant, planId, {
      linkedUserId: portalUser.userId,
      contactEmail: `approver-${randomUUID().slice(0, 8)}@example.com`,
    }));
    await runInTenant(tenant.ctx, (tx) => tx.update(contacts).set({ preferredLanguage: 'sv' }).where(eq(contacts.memberId, memberId)));
  });
  afterAll(async () => {
    if (tenant) await tenant.cleanup();
    if (portalUser) await deleteTestUser(portalUser);
  });

  it('an existing transition (approve as submitted: submitted → approved) moves stage_entered_at', async () => {
    const row = seed({});
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    const before = Date.now();

    const r = await approveBroadcast(
      { tenant: tenant.ctx, broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug), audit: f7AuditAdapter, clock: { now: () => new Date() } },
      {
        broadcastId: asBroadcastId(row.broadcastId!),
        actorUserId: MARKETER,
        decision: { mode: 'schedule', scheduledFor: new Date(Date.now() + 3_600_000) },
        requestId: null,
      },
    );
    expect(r.ok).toBe(true);
    const after = await readRow(row.broadcastId!);
    expect(after.status).toBe('approved');
    expect(after.stageEnteredAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });

  it('send: the version is stamped and frozen, the row is the member\'s turn, one ids-only outbox row in the contact\'s language', async () => {
    const row = seed({ status: 'in_design' });
    const v1Id = randomUUID();
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    await seedVersions(row.broadcastId!, { id: v1Id, sentToMemberAt: null });
    const requestId = `f119-send-${randomUUID()}`;

    const r = await sendVersionToMember(makeSendVersionToMemberDeps(tenant.ctx.slug), {
      broadcastId: asBroadcastId(row.broadcastId!),
      actorUserId: MARKETER,
      actorRole: 'marketing',
      requestId,
    });
    expect(r.ok ? r.value.round : r.error).toBe(1);

    const after = await readRow(row.broadcastId!);
    expect(after).toMatchObject({ status: 'awaiting_member_approval', currentRound: 1, memberReminderStage: 0, memberExpiryNotifiedAt: null });
    expect(after.stageEnteredAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());

    const edit = await runInTenant(tenant.ctx, (tx) =>
      tx.update(broadcastVersions).set({ subject: 'tampered' }).where(eq(broadcastVersions.id, v1Id)),
    ).then(() => 'ok', (e: unknown) => errorChainMessage(e));
    expect(edit).toContain('broadcast_version_immutable_after_send');

    const outbox = await readOutbox(row.broadcastId!);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ notificationType: 'eblast_version_sent_member', locale: 'sv', status: 'pending' });
    expect(outbox[0]!.contextData).toEqual({ tenantId: tenant.ctx.slug, broadcastId: row.broadcastId, versionId: v1Id, round: 1 });

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, requestId)));
    expect(audits.map((a) => a.eventType)).toEqual(['broadcast_version_sent_to_member']);
    expect(audits[0]!.payload).toEqual({
      related_member_id: memberId,
      broadcast_id: row.broadcastId,
      version_id: v1Id,
      round: 1,
      note_length: 'Please check the date.'.length,
      notified: true,
      actor_role: 'marketing',
    });
  });

  it('send: a member whose only contact has no ACTIVE portal login → no_portal_user, nothing written', async () => {
    const other = await seedPortalMemberWithContact(tenant, planId, { linkedUserId: null });
    const row = seed({ status: 'in_design', requestedByMemberId: other.memberId });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    await seedVersions(row.broadcastId!, { id: randomUUID(), sentToMemberAt: null });

    const r = await sendVersionToMember(makeSendVersionToMemberDeps(tenant.ctx.slug), {
      broadcastId: asBroadcastId(row.broadcastId!),
      actorUserId: MARKETER,
      actorRole: 'marketing',
      requestId: null,
    });
    expect(r.ok ? null : r.error.kind).toBe('no_portal_user');
    expect((await readRow(row.broadcastId!)).status).toBe('in_design');
    expect(await readOutbox(row.broadcastId!)).toHaveLength(0);
  });

  it('promotion: member_approved → approved copies the approved version byte-for-byte (E1); a later direct content UPDATE is still refused', async () => {
    const approved = { id: randomUUID(), sentToMemberAt: new Date('2026-09-21T08:00:00.000Z'), subject: 'Approved — ร่างที่อนุมัติ ✓', bodyHtml: '<p>Approved body <strong>exactly</strong></p>', bodySource: '{"doc":"approved"}' };
    const row = seed({ status: 'member_approved', currentRound: 1 });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    await seedVersions(row.broadcastId!, approved);
    await runInTenant(tenant.ctx, (tx) =>
      tx.update(broadcasts).set({ approvedVersionId: approved.id }).where(eq(broadcasts.broadcastId, row.broadcastId!)),
    );

    const r = await confirmSchedule(makeConfirmScheduleDeps(tenant.ctx.slug), {
      broadcastId: asBroadcastId(row.broadcastId!),
      actorUserId: MARKETER,
      actorRole: 'marketing',
      requestId: null,
      mode: { mode: 'send_now' },
    });
    expect(r.ok ? r.value.stage : r.error).toBe('approved');

    const after = await readRow(row.broadcastId!);
    expect([after.subject, after.bodyHtml, after.bodySource]).toEqual([approved.subject, approved.bodyHtml, approved.bodySource]);
    expect(after).toMatchObject({ status: 'approved', approvedVersionId: approved.id, proposedSendAt: row.proposedSendAt });

    const tamper = await runInTenant(tenant.ctx, (tx) =>
      tx.update(broadcasts).set({ subject: 'tampered after promotion' }).where(eq(broadcasts.broadcastId, row.broadcastId!)),
    ).then(() => 'ok', (e: unknown) => errorChainMessage(e));
    expect(tamper).toContain('broadcast_immutable_after_submit');

    const outbox = await readOutbox(row.broadcastId!);
    expect(outbox.map((o) => [o.notificationType, o.locale])).toEqual([['eblast_schedule_confirmed_member', 'sv']]);
    expect(outbox[0]!.contextData).toEqual({ tenantId: tenant.ctx.slug, broadcastId: row.broadcastId, versionId: approved.id });
  });

  it('re-time then cancel on an approved row: E2 admits approved → approved and approved → changes_requested; the cancel clears scheduled_for AND approved_version_id', async () => {
    const approved = { id: randomUUID(), sentToMemberAt: new Date('2026-09-21T08:00:00.000Z') };
    const row = seed({ status: 'approved', currentRound: 1 });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(row));
    await seedVersions(row.broadcastId!, approved);
    await runInTenant(tenant.ctx, (tx) =>
      tx.update(broadcasts).set({ approvedVersionId: approved.id }).where(eq(broadcasts.broadcastId, row.broadcastId!)),
    );
    const input = { broadcastId: asBroadcastId(row.broadcastId!), actorUserId: MARKETER, actorRole: 'marketing', requestId: null };

    // approved → approved: only the time moves, the stage clock does not.
    const later = new Date(Math.ceil((Date.now() + 2 * 3_600_000) / 1000) * 1000);
    const retime = await confirmSchedule(makeConfirmScheduleDeps(tenant.ctx.slug), { ...input, mode: { mode: 'schedule', scheduledFor: later } });
    expect(retime.ok ? retime.value.stage : retime.error).toBe('approved');
    const retimed = await readRow(row.broadcastId!);
    expect(retimed).toMatchObject({ status: 'approved', scheduledFor: later, approvedVersionId: approved.id, stageEnteredAt: LONG_AGO });

    // approved → changes_requested: off the dispatchable status, the approval out of force.
    const cancel = await confirmSchedule(makeConfirmScheduleDeps(tenant.ctx.slug), { ...input, mode: { mode: 'cancel' } });
    expect(cancel.ok ? cancel.value.stage : cancel.error).toBe('changes_requested');
    const after = await readRow(row.broadcastId!);
    expect(after).toMatchObject({ status: 'changes_requested', scheduledFor: null, approvedVersionId: null, proposedSendAt: row.proposedSendAt });
    expect(after.stageEnteredAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());

    // One member email for the re-time; none for the cancel.
    expect((await readOutbox(row.broadcastId!)).map((o) => o.notificationType)).toEqual(['eblast_schedule_confirmed_member']);
  });
});
