/**
 * Spec 140 s2c (DL6) — the `cleanup-audiences` orphan drain end to end on
 * live Postgres (Neon `dev`): the real broadcasts and orphan repos as
 * `chamber_app`, with Resend and the members bridge as fakes.
 *
 *   - [A1] an id a NON-TERMINAL row holds is not touched; the same id held by a
 *     TERMINAL row is drained; the hold is type-matched (an audience orphan is
 *     not hidden by a row holding that text as its broadcast id);
 *   - `create_unconfirmed` is never drained (there is no id to call);
 *   - [P H-2] inside the grace, only an erased requester's row is drained;
 *   - the settle is durable: a second run lists nothing it already settled.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { cleanupOrphanedAudiences, makeCleanupOrphanedAudiencesDeps } from '@/modules/broadcasts';
import { makeDrizzleBroadcastOrphansRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-orphans-repo';
import { broadcasts, type NewBroadcastRow } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const HOUR = 60 * 60 * 1000;

describe('spec 140 s2c — the orphan drain (DL6, live Neon)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
  });

  async function seedRow(patch: Partial<NewBroadcastRow>): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId: randomUUID(),
        requestedByMemberId: randomUUID(),
        requestedByMemberPlanIdSnapshot: 'plan-test',
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: 's2c drain',
        bodyHtml: '<p>x</p>',
        bodySource: 'plain',
        fromName: 'Test Chamber',
        replyToEmail: 'reply@example.com',
        segmentType: 'all_members',
        estimatedRecipientCount: 1,
        status: 'failed_to_dispatch',
        submittedAt: new Date(Date.now() - 86_400_000),
        ...patch,
      }),
    );
  }

  it('drains terminal-held and unheld ids, never a live-held id or create_unconfirmed; the grace yields only to an erased requester', async () => {
    const orphans = makeDrizzleBroadcastOrphansRepo(tenant.ctx.slug);
    const live = randomUUID();
    const erased = randomUUID();
    const ids = {
      liveHeld: `rb-${randomUUID()}`,
      terminalHeld: `rb-${randomUUID()}`,
      crossTyped: `x-${randomUUID()}`,
      youngLive: `rb-${randomUUID()}`,
      youngErased: `rb-${randomUUID()}`,
    };
    await seedRow({ status: 'approved', resendBroadcastId: ids.liveHeld });
    await seedRow({ status: 'failed_to_dispatch', resendBroadcastId: ids.terminalHeld });
    await seedRow({ status: 'approved', resendBroadcastId: ids.crossTyped });
    const bid = randomUUID();
    const rec = (requestedByMemberId: string, resourceType: 'broadcast' | 'audience', resourceId: string | null, reason: 'attach_lost' | 'audience_leaked' | 'create_unconfirmed') =>
      orphans.recordOrphanedResendId({ broadcastId: bid, requestedByMemberId, resourceType, resourceId, reason });
    await rec(live, 'broadcast', ids.liveHeld, 'attach_lost');
    await rec(live, 'broadcast', ids.terminalHeld, 'attach_lost');
    await rec(live, 'audience', ids.crossTyped, 'audience_leaked');
    await rec(live, 'broadcast', null, 'create_unconfirmed');
    await rec(live, 'broadcast', ids.youngLive, 'attach_lost');
    await rec(erased, 'broadcast', ids.youngErased, 'attach_lost');

    const deleted: string[] = [];
    const gateway = {
      async deleteBroadcastOnce(id: string) {
        deleted.push(id);
        return { kind: 'deleted' as const };
      },
      async retrieveBroadcastOnce() {
        return { kind: 'not_found' as const };
      },
      async deleteAudience(id: string) {
        deleted.push(id);
      },
    };
    const membersBridge = {
      async getMemberErasedAt(_t: unknown, memberId: string) {
        return { erasedAt: memberId === erased ? new Date() : null };
      },
    };
    // Every row was just written: a 1 h grace keeps them all inside it, so
    // only the erased requester's row can drain. Below, a NEGATIVE grace (a
    // cutoff an hour ahead) ends the grace for every row whatever the skew
    // between this workstation's clock and Neon's `now()`.
    const deps = { ...makeCleanupOrphanedAudiencesDeps(tenant.ctx.slug), broadcastsGateway: gateway as never, membersBridge };
    const first = await cleanupOrphanedAudiences(deps, { graceMs: HOUR, limit: 50 });
    expect(first.ok).toBe(true);
    expect(deleted).toEqual([ids.youngErased]);

    deleted.length = 0;
    const second = await cleanupOrphanedAudiences(deps, { graceMs: -HOUR, limit: 50 });
    expect(second.ok ? second.value.orphans : null).toMatchObject({ listed: 3, settled: 3, undecided: 0 });
    expect([...deleted].sort()).toEqual([ids.terminalHeld, ids.crossTyped, ids.youngLive].sort());
    expect(deleted).not.toContain(ids.liveHeld);

    deleted.length = 0;
    const third = await cleanupOrphanedAudiences(deps, { graceMs: -HOUR, limit: 50 });
    expect(third.ok ? third.value.orphans : null).toMatchObject({ listed: 0 });
    expect(deleted).toEqual([]);
    const settled = (await orphans.listMemberOrphans(live)).filter((o) => o.outcome !== null).map((o) => o.resourceId).sort();
    expect(settled).toEqual([ids.terminalHeld, ids.youngLive].sort());
  });
});
