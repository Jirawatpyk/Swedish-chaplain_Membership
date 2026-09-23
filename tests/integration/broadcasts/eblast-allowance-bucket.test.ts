/**
 * F119 T075 — the allowance bucket after the change (US2-AS5, FR-020, SC-007;
 * data-model § 9), against LIVE Postgres (Neon `dev`).
 *
 * `IN_PROGRESS_BROADCAST_STATUSES` is the reserved set — ONE Domain constant
 * driving both the quota count (`countMemberQuotaBucketsOnTx`, read by the
 * pre-tx `countForMemberQuota` AND by the under-lock
 * `recheckMemberQuotaUnderLock`) and the erasure / cancel cascade
 * (`listInFlightOwnedByMember`). Before T080 both read the literal
 * `('submitted','approved')`, so an E-Blast being formatted, awaiting the
 * member, sent back or member-approved held NO place and a member could
 * over-subscribe their plan by starting rounds.
 *
 * The quota counter is the REAL `computeQuotaCounter` over the REAL Drizzle
 * repo; only the plan lookup is stubbed (the cap is the variable under test).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ok } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { IN_PROGRESS_BROADCAST_STATUSES } from '@/modules/broadcasts/domain/stage/in-progress-statuses';
import { cancelBroadcast } from '@/modules/broadcasts/application/use-cases/cancel-broadcast';
import { computeQuotaCounter, currentQuotaYear } from '@/modules/broadcasts/application/use-cases/compute-quota-counter';
import { rejectBroadcast } from '@/modules/broadcasts/application/use-cases/reject-broadcast';
import type { PlansBridgePort } from '@/modules/broadcasts/application/ports/plans-bridge-port';
import { makeCancelBroadcastDeps, makeRejectBroadcastDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { asMemberId } from '@/modules/members';
import { env } from '@/lib/env';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const CAP = IN_PROGRESS_BROADCAST_STATUSES.length; // 6 — one broadcast per in-progress stage
const MARKETER = randomUUID();

describe('F119 T075 — one allowance place per in-progress E-Blast, whatever the stage and however many rounds (live Neon)', () => {
  let tenant: TestTenant;
  const memberId = randomUUID();
  const ids = new Map<string, string>();

  const plans: PlansBridgePort = {
    getPlanForMember: async () => ok({ planCode: 'test', planId: 'plan-t075', eblastPerYear: CAP }),
  };
  const repo = () => makeDrizzleBroadcastsRepo(tenant.ctx.slug);
  const counter = async () => {
    const r = await computeQuotaCounter(
      { tenant: tenant.ctx, plansBridge: plans, broadcastsRepo: repo(), clock: { now: () => new Date() } },
      { memberId: asMemberId(memberId) },
    );
    if (!r.ok) throw new Error(`quota counter failed: ${r.error.kind}`);
    return r.value.counter;
  };
  const underLock = () =>
    repo().withTx((tx) =>
      repo().recheckMemberQuotaUnderLock!(tx, tenant.ctx.slug, asMemberId(memberId), currentQuotaYear(new Date(), env.tenant.timezone)),
    );
  const readRow = (id: string) =>
    runInTenant(tenant.ctx, async (tx) => (await tx.select().from(broadcasts).where(eq(broadcasts.broadcastId, id)))[0]!);

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    const rows: NewBroadcastRow[] = IN_PROGRESS_BROADCAST_STATUSES.map((status) => {
      const broadcastId = randomUUID();
      ids.set(status, broadcastId);
      return {
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: memberId,
        requestedByMemberPlanIdSnapshot: 'plan-t075',
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: `In ${status}`,
        bodyHtml: '<p>b</p>',
        bodySource: 'b',
        fromName: 'Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 10,
        status,
        submittedAt: new Date('2026-09-20T08:00:00.000Z'),
        proposedSendAt: new Date(Date.now() + 7 * 86_400_000),
        // Several rounds on the rows inside the round — rounds do not multiply the cost.
        currentRound: status === 'submitted' ? 0 : 3,
      };
    });
    await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(rows));
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
  });

  it('a broadcast in EACH in-progress stage holds exactly one place: reserved = 6 at a plan limit of 6, so the next submit is refused', async () => {
    const c = await counter();
    expect(c).toMatchObject({ reserved: CAP, used: 0, cap: CAP, remaining: 0 });
    // The under-lock recheck the submit tx runs reads the SAME set (bug #4).
    expect((await underLock()).submittedOrApproved).toBe(CAP);
  });

  it('the erasure / cancel cascade sees the same set — every in-progress row, and nothing else', async () => {
    const inFlight = await repo().listInFlightOwnedByMember(tenant.ctx.slug, asMemberId(memberId));
    expect(new Set(inFlight.map((b) => b.status))).toEqual(new Set(IN_PROGRESS_BROADCAST_STATUSES));
  });

  it('a rejection frees its place, with quota_year_consumed still NULL', async () => {
    const id = ids.get('awaiting_member_approval')!;
    const r = await rejectBroadcast(makeRejectBroadcastDeps(tenant.ctx.slug), {
      broadcastId: asBroadcastId(id),
      actorUserId: MARKETER,
      actorRole: 'marketing',
      rejectionReason: 'Not this time',
      requestId: null,
    });
    expect(r.ok ? r.value.broadcast.status : r.error).toBe('rejected');
    expect(await readRow(id)).toMatchObject({ status: 'rejected', quotaYearConsumed: null });
    expect(await counter()).toMatchObject({ reserved: CAP - 1, remaining: 1 });
  });

  it('a withdrawal (cancel) frees its place, with quota_year_consumed still NULL', async () => {
    const id = ids.get('member_approved')!;
    const r = await cancelBroadcast(makeCancelBroadcastDeps(tenant.ctx.slug, { listRecipients: async () => [] }), {
      broadcastId: asBroadcastId(id),
      actor: { kind: 'member', memberId, userId: randomUUID() },
      actorRole: 'member',
      cancellationReason: null,
      requestId: null,
    });
    expect(r.ok ? r.value.broadcast.status : r.error).toBe('cancelled');
    expect(await readRow(id)).toMatchObject({ status: 'cancelled', quotaYearConsumed: null });
    expect(await counter()).toMatchObject({ reserved: CAP - 2, remaining: 2 });
  });

  it.todo('expiry (`expired_no_member_response`) frees its place with quota_year_consumed still NULL — owner T126 / T130 (the day-30 lifecycle cron)');
});
