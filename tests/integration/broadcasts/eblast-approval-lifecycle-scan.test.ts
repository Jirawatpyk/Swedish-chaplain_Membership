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
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { drizzleApprovalLifecycleScan } from '@/modules/broadcasts/infrastructure/db/drizzle-approval-lifecycle-scan';
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

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
