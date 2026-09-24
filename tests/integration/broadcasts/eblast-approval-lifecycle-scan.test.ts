/**
 * F119 T130 / T166 R-L1 — the Drizzle `ApprovalLifecycleScanPort` against
 * LIVE Postgres (Neon `dev`): the predicate the in-memory fake mirrors.
 *
 *   - `awaiting_member_approval` only, `stage_entered_at` inside the window,
 *     OLDEST FIRST, at most `limit`;
 *   - R-L1: `reminderStageBelow` drops rows already served every step the
 *     window can give them (a day-23-warned row has no reminder left), so a
 *     backlog of warned rows cannot fill the batch and starve a row whose
 *     day-3 / day-7 reminder is due. The expiry scan passes no bound.
 *
 * A second describe drives the WHOLE tick (`expireStaleMemberApprovals` over
 * the real composition root, real repos, real outbox and audit adapter) for
 * the steps the suites above never write live: the day-3 reminder bumps
 * `member_reminder_stage` 0 → 1 with exactly one
 * `broadcast_approval_reminder_sent` row, a second tick the same day is a
 * no-op, and rows parked 400 days in `changes_requested` / `in_design` /
 * `approved` are never touched (FR-022a — the status filter).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInTenant } from '@/lib/db';
import { makeExpireStaleMemberApprovalsDeps } from '@/lib/broadcast-approval-deps';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { expireStaleMemberApprovals } from '@/modules/broadcasts/application/use-cases/approval/expire-stale-member-approvals';
import { drizzleApprovalLifecycleScan } from '@/modules/broadcasts/infrastructure/db/drizzle-approval-lifecycle-scan';
import { broadcasts, broadcastVersions, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { makeFakeMarketingDirectory } from '../../helpers/eblast-approval-fakes';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const DAY = 86_400_000;

describe('drizzleApprovalLifecycleScan — the reminder window on live Postgres (T166 R-L1)', () => {
  let tenant: TestTenant;
  const memberId = randomUUID();
  const now = new Date();
  const ids = { warnedOldest: randomUUID(), warned: randomUUID(), dueDay7: randomUUID(), approved: randomUUID() };

  const row = (broadcastId: string, status: NewBroadcastRow['status'], daysAgo: number, memberReminderStage: number): NewBroadcastRow => ({
    tenantId: tenant.ctx.slug,
    broadcastId,
    requestedByMemberId: memberId,
    requestedByMemberPlanIdSnapshot: 'plan-scan',
    submittedByUserId: randomUUID(),
    actorRole: 'member_self_service',
    subject: 'scan',
    bodyHtml: '<p>b</p>',
    bodySource: 'b',
    fromName: 'Chamber',
    replyToEmail: 'reply@example.com',
    segmentType: 'all_members',
    estimatedRecipientCount: 1,
    status,
    submittedAt: new Date(now.getTime() - (daysAgo + 1) * DAY),
    stageEnteredAt: new Date(now.getTime() - daysAgo * DAY),
    currentRound: 1,
    memberReminderStage,
  });

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values([
        row(ids.warnedOldest, 'awaiting_member_approval', 26, 3),
        row(ids.warned, 'awaiting_member_approval', 25, 3),
        row(ids.dueDay7, 'awaiting_member_approval', 8, 1),
        row(ids.approved, 'member_approved', 20, 0),
      ]),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
  }, 120_000);

  const scan = (query: Parameters<typeof drizzleApprovalLifecycleScan.listAwaitingMemberApprovalInTx>[2]) =>
    runInTenant(tenant.ctx, (tx) => drizzleApprovalLifecycleScan.listAwaitingMemberApprovalInTx(tx, tenant.ctx.slug, query));

  const window = { enteredAtOrBefore: new Date(now.getTime() - 3 * DAY), enteredAfter: new Date(now.getTime() - 30 * DAY) };

  it('without the bound, the oldest rows fill the batch — the warned ones, although nothing is left to send them', async () => {
    const found = await scan({ ...window, limit: 2 });
    expect(found.map((c) => c.broadcastId)).toEqual([ids.warnedOldest, ids.warned]);
  });

  it('with reminderStageBelow = 3, the warned rows are not candidates: the due day-7 row is found even at limit 1; other statuses never are', async () => {
    const found = await scan({ ...window, limit: 1, reminderStageBelow: 3 });
    expect(found.map((c) => c.broadcastId)).toEqual([ids.dueDay7]);
    const all = await scan({ ...window, limit: 10, reminderStageBelow: 3 });
    expect(all.map((c) => c.broadcastId)).toEqual([ids.dueDay7]);
  });
});

/**
 * The day-3 reminder written LIVE (T166 H3), and the status filter (M3).
 *
 * The member is real — an active `member` login linked to a live contact — so
 * the reminder has somebody to go to: `broadcast_approval_reminder_sent` is
 * written only when a row was actually enqueued. The marketing roster is an
 * injected empty list (disclosed: `users` is cross-tenant on the shared dev
 * branch, and day 3 does not address staff anyway).
 */
describe('expireStaleMemberApprovals — one live tick writes the day-3 reminder once, and touches no other status (T166 H3 / M3)', () => {
  let tenant: TestTenant;
  let portalUser: TestUser;
  let memberId: string;
  const planId = `plan-f119-remind-${randomUUID().slice(0, 8)}`;
  const MARKETER = randomUUID();
  const REMINDER_AUDIT = [
    'broadcast_approval_reminder_sent',
    'broadcast_approval_expiry_warned',
    'broadcast_approval_expired',
  ] as const;
  const now = Date.now();
  const due = { id: randomUUID(), enteredAt: new Date(now - 4 * DAY) };
  const PARKED_AT = new Date(now - 400 * DAY);
  const parked = {
    changes_requested: randomUUID(),
    in_design: randomUUID(),
    approved: randomUUID(),
  } as const;
  const parkedIds = Object.values(parked);

  const row = (broadcastId: string, status: NewBroadcastRow['status'], enteredAt: Date): NewBroadcastRow => ({
    tenantId: tenant.ctx.slug,
    broadcastId,
    requestedByMemberId: memberId,
    requestedByMemberPlanIdSnapshot: planId,
    submittedByUserId: portalUser.userId,
    actorRole: 'member_self_service',
    subject: `lifecycle ${status}`,
    bodyHtml: '<p>b</p>',
    bodySource: 'b',
    fromName: 'Chamber',
    replyToEmail: 'reply@example.com',
    segmentType: 'all_members',
    estimatedRecipientCount: 1,
    status,
    submittedAt: new Date(enteredAt.getTime() - DAY),
    stageEnteredAt: enteredAt,
    currentRound: 1,
    ...(status === 'approved'
      ? { approvedAt: enteredAt, approvedByUserId: MARKETER, scheduledFor: new Date(now + 30 * DAY) }
      : {}),
  });

  const readRows = async () => {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(broadcasts).where(eq(broadcasts.tenantId, tenant.ctx.slug)),
    );
    return new Map(rows.map((r) => [r.broadcastId, r]));
  };
  const lifecycleAudit = () =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.ctx.slug), inArray(auditLog.eventType, [...REMINDER_AUDIT])));
  const lifecycleOutbox = async () =>
    (await db.execute(sql`
      SELECT context_data->>'broadcastId' AS broadcast_id, context_data->>'kind' AS kind
      FROM notifications_outbox
      WHERE tenant_id = ${tenant.ctx.slug} AND notification_type = 'eblast_approval_lifecycle'
    `)) as unknown as Array<{ broadcast_id: string; kind: string }>;
  const tick = (requestId: string) =>
    expireStaleMemberApprovals(
      { ...makeExpireStaleMemberApprovalsDeps(tenant.ctx.slug), marketingDirectory: makeFakeMarketingDirectory([]) },
      { requestId },
    );

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    portalUser = await createActiveTestUser('member');
    await seedPortalPlan(tenant.ctx.slug, portalUser.userId, planId);
    ({ memberId } = await seedPortalMemberWithContact(tenant, planId, {
      linkedUserId: portalUser.userId,
      companyName: 'Reminder Co',
    }));
    const seeded: Array<readonly [string, NewBroadcastRow['status'], Date]> = [
      [due.id, 'awaiting_member_approval', due.enteredAt],
      [parked.changes_requested, 'changes_requested', PARKED_AT],
      [parked.in_design, 'in_design', PARKED_AT],
      [parked.approved, 'approved', PARKED_AT],
    ];
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(broadcasts).values(seeded.map(([id, status, at]) => row(id, status, at)));
      // Every row carries a SENT version for its round, so a row the scan
      // wrongly picked would be processed (and audited), not thrown out.
      await tx.insert(broadcastVersions).values(
        seeded.map(([broadcastId, , at]) => ({
          tenantId: tenant.ctx.slug,
          broadcastId,
          versionNo: 1,
          subject: 'Formatted',
          bodyHtml: '<p>f</p>',
          bodySource: 'f',
          authoredByUserId: MARKETER,
          authoredByRole: 'admin_proxy' as const,
          sentToMemberAt: at,
        })),
      );
    });
  }, 120_000);

  afterAll(async () => {
    const slug = tenant?.ctx.slug;
    if (slug !== undefined) await db.execute(sql`DELETE FROM notifications_outbox WHERE tenant_id = ${slug}`).catch(() => {});
    await tenant?.cleanup().catch(() => {});
    if (portalUser) await deleteTestUser(portalUser).catch(() => {});
  }, 120_000);

  it('day 3: stage 0 → 1, exactly one reminder_sent row and one outbox row; a second tick the same day changes nothing; the 400-day-old parked rows are never touched', async () => {
    const before = await readRows();
    expect(before.get(due.id)?.memberReminderStage).toBe(0);
    expect(await lifecycleAudit()).toEqual([]);

    // Tick 1 — only the awaiting row is a candidate (the parked ones are
    // older than the expiry cutoff, so a missing status filter would EXPIRE
    // them here, not just remind them).
    const first = await tick('h3-tick-1');
    expect(first.ok ? first.value : first.error).toEqual({
      scanned: 1,
      remindersSent: 1,
      warningsSent: 0,
      expired: 0,
      rowsFailed: 0,
    });
    const afterFirst = await readRows();
    expect(afterFirst.get(due.id)).toMatchObject({ status: 'awaiting_member_approval', memberReminderStage: 1 });
    const audit1 = await lifecycleAudit();
    expect(
      audit1.map((a) => {
        const p = a.payload as { broadcast_id: string; reminder: string; related_member_id: string; actor_role: string };
        return [a.eventType, p.broadcast_id, p.reminder, p.related_member_id, p.actor_role];
      }),
    ).toEqual([['broadcast_approval_reminder_sent', due.id, 'day3', memberId, 'system']]);
    expect(await lifecycleOutbox()).toEqual([{ broadcast_id: due.id, kind: 'reminder_day3' }]);

    // Tick 2, same day — the row is still scanned (stage 1 < 3) but nothing is due.
    const second = await tick('h3-tick-2');
    expect(second.ok ? second.value : second.error).toEqual({
      scanned: 1,
      remindersSent: 0,
      warningsSent: 0,
      expired: 0,
      rowsFailed: 0,
    });
    const afterSecond = await readRows();
    expect(afterSecond.get(due.id)?.memberReminderStage).toBe(1);
    expect((await lifecycleAudit()).length).toBe(1);
    expect((await lifecycleOutbox()).length).toBe(1);

    // M3 — the parked rows: no stage change, no counter, no expiry stamp.
    for (const id of parkedIds) {
      const was = before.get(id)!;
      expect(afterSecond.get(id), id).toMatchObject({
        status: was.status,
        stageEnteredAt: was.stageEnteredAt,
        memberReminderStage: 0,
        memberExpiryNotifiedAt: null,
        updatedAt: was.updatedAt,
      });
    }
  });
});
