/**
 * Spec 140 s2c — `makeDrizzleBroadcastOrphansRepo` on live Postgres (Neon
 * `dev`), as `chamber_app` under `runInTenant`.
 *
 *   - [A1] the drain and the cascade skip an id only while a NON-TERMINAL
 *     `broadcasts` row of the same tenant holds it, TYPE-MATCHED: a broadcast
 *     orphan against `resend_broadcast_id`, an audience orphan against
 *     `resend_audience_id`. A terminal holder does not block;
 *   - `listMemberOrphans` returns settled rows too [A6a], broadcast type only;
 *   - `listUnsettledAudienceOrphans` [P H-1] is tenant-wide;
 *   - `recordOrphanedResendId` keeps the first row per id; `settleOrphan` is a
 *     CAS on `settled_at IS NULL`;
 *   - cross-tenant: tenant B's rows (same broadcast uuid, same member uuid,
 *     same Resend id) are never listed, settled or pruned from tenant A.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { makeDrizzleBroadcastOrphansRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-orphans-repo';
import {
  broadcastOrphanedResendIds,
  broadcasts,
  type NewBroadcastRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const HOUR = 60 * 60 * 1000;
/** The cleanup route's 1 h `GRACE_MS`, as the drain passes it. */
const GRACE_CUTOFF = () => new Date(Date.now() - HOUR);

describe('spec 140 s2c — the orphan repo (live Neon, chamber_app)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const t = await createTwoTestTenants();
    tenantA = t.a;
    tenantB = t.b;
  });

  afterAll(async () => {
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
  });

  async function seedRow(tenant: TestTenant, patch: Partial<NewBroadcastRow>): Promise<string> {
    const broadcastId = patch.broadcastId ?? randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcasts).values({
        tenantId: tenant.ctx.slug,
        broadcastId,
        requestedByMemberId: randomUUID(),
        requestedByMemberPlanIdSnapshot: 'plan-test',
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: 's2c orphan',
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
    return broadcastId;
  }

  it('[A1] a non-terminal holder hides the id, a terminal holder does not, and the match is type-matched', async () => {
    const repo = makeDrizzleBroadcastOrphansRepo(tenantA.ctx.slug);
    const member = randomUUID();
    const heldByApproved = `rb-${randomUUID()}`;
    const heldByTerminal = `rb-${randomUUID()}`;
    const audHeldByApproved = `aud-${randomUUID()}`;
    // An id that a non-terminal row holds as its AUDIENCE: a broadcast orphan
    // with the same text is not blocked by it (type-matched).
    const crossTyped = `x-${randomUUID()}`;
    await seedRow(tenantA, { status: 'approved', resendBroadcastId: heldByApproved, resendAudienceId: audHeldByApproved });
    await seedRow(tenantA, { status: 'failed_to_dispatch', resendBroadcastId: heldByTerminal });
    await seedRow(tenantA, { status: 'approved', resendAudienceId: crossTyped });
    const bid = randomUUID();
    for (const [resourceType, resourceId] of [
      ['broadcast', heldByApproved],
      ['broadcast', heldByTerminal],
      ['audience', audHeldByApproved],
      ['broadcast', crossTyped],
    ] as const) {
      await repo.recordOrphanedResendId({ broadcastId: bid, requestedByMemberId: member, resourceType, resourceId, reason: 'attach_lost' });
    }

    const drainable = (await repo.listDrainableOrphans(50, GRACE_CUTOFF())).map((o) => `${o.resourceType}:${o.resourceId}`);
    expect(drainable).toContain(`broadcast:${heldByTerminal}`);
    expect(drainable).toContain(`broadcast:${crossTyped}`);
    expect(drainable).not.toContain(`broadcast:${heldByApproved}`);
    expect(drainable).not.toContain(`audience:${audHeldByApproved}`);

    const mine = (await repo.listMemberOrphans(member)).map((o) => o.resourceId).sort();
    expect(mine).toEqual([crossTyped, heldByTerminal].sort());
    const audiences = (await repo.listUnsettledAudienceOrphans(50, GRACE_CUTOFF())).map((o) => o.resourceId);
    expect(audiences).not.toContain(audHeldByApproved);
  });

  it('records once per id, lists settled rows for the member, settles by CAS and never lists create_unconfirmed', async () => {
    const repo = makeDrizzleBroadcastOrphansRepo(tenantA.ctx.slug);
    const member = randomUUID();
    const id = `rb-${randomUUID()}`;
    const bid = randomUUID();
    await repo.recordOrphanedResendId({ broadcastId: bid, requestedByMemberId: member, resourceType: 'broadcast', resourceId: id, reason: 'persist_failed' });
    await repo.recordOrphanedResendId({ broadcastId: bid, requestedByMemberId: member, resourceType: 'broadcast', resourceId: id, reason: 'attach_lost' });
    await repo.recordOrphanedResendId({ broadcastId: bid, requestedByMemberId: member, resourceType: 'broadcast', resourceId: null, reason: 'create_unconfirmed' });
    const aud = `aud-${randomUUID()}`;
    await repo.recordOrphanedResendId({ broadcastId: bid, requestedByMemberId: randomUUID(), resourceType: 'audience', resourceId: aud, reason: 'audience_leaked' });

    const listed = await repo.listMemberOrphans(member);
    expect(listed.map((o) => [o.resourceId, o.reason, o.outcome])).toEqual([[id, 'persist_failed', null]]);
    expect(listed[0]?.broadcastId).toBe(bid);
    expect(listed[0]?.requestedByMemberId).toBe(member);

    expect(await repo.settleOrphan(listed[0]!.orphanId, 'deleted')).toBe(true);
    expect(await repo.settleOrphan(listed[0]!.orphanId, 'absent')).toBe(false);
    const again = await repo.listMemberOrphans(member);
    expect(again.map((o) => o.outcome)).toEqual(['deleted']);
    expect((await repo.listDrainableOrphans(500, GRACE_CUTOFF())).map((o) => o.resourceId)).not.toContain(id);
    expect((await repo.listUnsettledAudienceOrphans(500, GRACE_CUTOFF())).map((o) => o.resourceId)).toContain(aud);
    for (const o of await repo.listDrainableOrphans(500, GRACE_CUTOFF())) expect(o.reason).not.toBe('create_unconfirmed');
  });

  it('cross-tenant: tenant B rows with the same uuids and Resend id are never listed, settled or pruned from A', async () => {
    const repoA = makeDrizzleBroadcastOrphansRepo(tenantA.ctx.slug);
    const repoB = makeDrizzleBroadcastOrphansRepo(tenantB.ctx.slug);
    const member = randomUUID();
    const bid = randomUUID();
    const id = `rb-${randomUUID()}`;
    const aud = `aud-${randomUUID()}`;
    await repoB.recordOrphanedResendId({ broadcastId: bid, requestedByMemberId: member, resourceType: 'broadcast', resourceId: id, reason: 'attach_lost' });
    await repoB.recordOrphanedResendId({ broadcastId: bid, requestedByMemberId: member, resourceType: 'audience', resourceId: aud, reason: 'audience_leaked' });

    expect(await repoA.listMemberOrphans(member)).toEqual([]);
    expect((await repoA.listDrainableOrphans(500, GRACE_CUTOFF())).map((o) => o.resourceId)).not.toContain(id);
    expect((await repoA.listUnsettledAudienceOrphans(500, GRACE_CUTOFF())).map((o) => o.resourceId)).not.toContain(aud);
    const bRows = await repoB.listMemberOrphans(member);
    expect(bRows).toHaveLength(1);
    expect(await repoA.settleOrphan(bRows[0]!.orphanId, 'deleted')).toBe(false);
    const stillUnsettled = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select({ outcome: broadcastOrphanedResendIds.outcome })
        .from(broadcastOrphanedResendIds)
        .where(and(eq(broadcastOrphanedResendIds.tenantId, tenantB.ctx.slug), eq(broadcastOrphanedResendIds.orphanId, bRows[0]!.orphanId))),
    );
    expect(stillUnsettled).toEqual([{ outcome: null }]);
    // B's non-terminal row holding an id does not hide A's orphan of that id:
    // the NOT EXISTS is fenced on the orphan's own tenant.
    const shared = `rb-${randomUUID()}`;
    await seedRow(tenantB, { status: 'approved', resendBroadcastId: shared });
    await repoA.recordOrphanedResendId({ broadcastId: bid, requestedByMemberId: member, resourceType: 'broadcast', resourceId: shared, reason: 'attach_lost' });
    expect((await repoA.listDrainableOrphans(500, GRACE_CUTOFF())).map((o) => o.resourceId)).toContain(shared);
    // The prune touches only A (B's rows are unsettled and young either way).
    expect(await repoA.pruneOrphans(new Date(Date.now() - 100 * 86_400_000))).toBe(0);
    expect(await repoB.listMemberOrphans(member)).toHaveLength(1);
  });

  /**
   * Spec 140 s2c review round 1:
   *   - the attempt counter (code-review #2): an undecided settle increments
   *     `attempts` by CAS, and the lists read `ORDER BY attempts, created_at`,
   *     so 20 permanently undecided rows cannot starve a 21st;
   *   - an audience a row JUST went terminal with is still the existing
   *     audience loop's for `GRACE_MS` (code-review #3): the terminal holder
   *     counts as live until its `updated_at` is past the grace.
   */
  it('20 undecided rows do not starve a 21st (attempts order the drain)', async () => {
    const solo = await createTestTenant('test-swecham');
    try {
      const repo = makeDrizzleBroadcastOrphansRepo(solo.ctx.slug);
      const member = randomUUID();
      for (let i = 0; i < 21; i += 1) {
        await repo.recordOrphanedResendId({ broadcastId: randomUUID(), requestedByMemberId: member, resourceType: 'broadcast', resourceId: `rb-${i}-${randomUUID()}`, reason: 'attach_lost' });
      }
      const first = await repo.listDrainableOrphans(20, GRACE_CUTOFF());
      expect(first).toHaveLength(20);
      for (const o of first) expect(await repo.markOrphanAttempted(o.orphanId)).toBe(true);
      const all = await repo.listDrainableOrphans(50, GRACE_CUTOFF());
      const fresh = all.filter((o) => o.attempts === 0);
      expect(fresh).toHaveLength(1);
      const next = await repo.listDrainableOrphans(20, GRACE_CUTOFF());
      expect(next[0]?.orphanId).toBe(fresh[0]?.orphanId);
      // A settled row is not attempted again (the CAS is on settled_at IS NULL).
      expect(await repo.settleOrphan(first[0]!.orphanId, 'absent')).toBe(true);
      expect(await repo.markOrphanAttempted(first[0]!.orphanId)).toBe(false);
    } finally {
      await solo.cleanup().catch(() => {});
    }
  });

  it('an audience a row just went terminal with is not drained until GRACE_MS has passed', async () => {
    const repo = makeDrizzleBroadcastOrphansRepo(tenantA.ctx.slug);
    const fresh = `aud-fresh-${randomUUID()}`;
    const stale = `aud-stale-${randomUUID()}`;
    await seedRow(tenantA, { status: 'failed_to_dispatch', resendAudienceId: fresh, updatedAt: new Date() });
    await seedRow(tenantA, { status: 'failed_to_dispatch', resendAudienceId: stale, updatedAt: new Date(Date.now() - 2 * HOUR) });
    for (const id of [fresh, stale]) {
      await repo.recordOrphanedResendId({ broadcastId: randomUUID(), requestedByMemberId: randomUUID(), resourceType: 'audience', resourceId: id, reason: 'audience_leaked' });
    }
    const drainable = (await repo.listDrainableOrphans(500, GRACE_CUTOFF())).map((o) => o.resourceId);
    expect(drainable).toContain(stale);
    expect(drainable).not.toContain(fresh);
    const erasureList = (await repo.listUnsettledAudienceOrphans(500, GRACE_CUTOFF())).map((o) => o.resourceId);
    expect(erasureList).toContain(stale);
    expect(erasureList).not.toContain(fresh);
  });

  /**
   * Spec 140 s2c review round 2:
   *   - code-review #2: a broadcast orphan whose id a row that SENT holds is
   *     flagged `heldBySentRow`, so the settlers record `superseded` with no
   *     Resend call (an ordinary delivery, not erasure evidence);
   *   - code-review #3: past-grace rows sort first, so 20 in-grace rows cannot
   *     hide an older drainable one;
   *   - spec N4: the erasure's audience list orders by attempts, then age.
   */
  it('[code-review #2] an orphan whose id a sent row holds is superseded, not handed: the repo flags heldBySentRow', async () => {
    const repo = makeDrizzleBroadcastOrphansRepo(tenantA.ctx.slug);
    const member = randomUUID();
    const sentId = `rb-sent-${randomUUID()}`;
    const freeId = `rb-free-${randomUUID()}`;
    await seedRow(tenantA, { status: 'sent', resendBroadcastId: sentId, quotaYearConsumed: new Date().getFullYear(), quotaConsumedAt: new Date(), sentAt: new Date() });
    for (const id of [sentId, freeId]) {
      await repo.recordOrphanedResendId({ broadcastId: randomUUID(), requestedByMemberId: member, resourceType: 'broadcast', resourceId: id, reason: 'attach_lost' });
    }
    const mine = await repo.listMemberOrphans(member);
    expect(Object.fromEntries(mine.map((o) => [o.resourceId, o.heldBySentRow]))).toEqual({ [sentId]: true, [freeId]: false });
    const drainable = await repo.listDrainableOrphans(500, GRACE_CUTOFF());
    expect(drainable.find((o) => o.resourceId === sentId)?.heldBySentRow).toBe(true);
  });

  it('[code-review #3] 20 in-grace rows do not hide an older drainable row, even one tried more often', async () => {
    const solo = await createTestTenant('test-swecham');
    try {
      const repo = makeDrizzleBroadcastOrphansRepo(solo.ctx.slug);
      const member = randomUUID();
      const oldId = `rb-old-${randomUUID()}`;
      await runInTenant(solo.ctx, (tx) =>
        tx.execute(sql`
          INSERT INTO broadcast_orphaned_resend_ids (tenant_id, broadcast_id, requested_by_member_id, resource_type, resource_id, reason, created_at, attempts)
          VALUES (${solo.ctx.slug}, ${randomUUID()}::uuid, ${member}::uuid, 'broadcast', ${oldId}, 'attach_lost', ${new Date(Date.now() - 3 * HOUR).toISOString()}::timestamptz, 3)`),
      );
      for (let i = 0; i < 20; i += 1) {
        await repo.recordOrphanedResendId({ broadcastId: randomUUID(), requestedByMemberId: member, resourceType: 'broadcast', resourceId: `rb-young-${i}-${randomUUID()}`, reason: 'attach_lost' });
      }
      const listed = await repo.listDrainableOrphans(20, GRACE_CUTOFF());
      expect(listed[0]?.resourceId).toBe(oldId);
    } finally {
      await solo.cleanup().catch(() => {});
    }
  });

  it('[spec N4] the erasure audience list orders by attempts, then age', async () => {
    const solo = await createTestTenant('test-swecham');
    try {
      const repo = makeDrizzleBroadcastOrphansRepo(solo.ctx.slug);
      const ids = [`aud-1-${randomUUID()}`, `aud-2-${randomUUID()}`, `aud-3-${randomUUID()}`];
      for (const id of ids) {
        await repo.recordOrphanedResendId({ broadcastId: randomUUID(), requestedByMemberId: randomUUID(), resourceType: 'audience', resourceId: id, reason: 'audience_leaked' });
      }
      const first = await repo.listUnsettledAudienceOrphans(10, GRACE_CUTOFF());
      expect(await repo.markOrphanAttempted(first.find((o) => o.resourceId === ids[0])!.orphanId)).toBe(true);
      const again = (await repo.listUnsettledAudienceOrphans(10, GRACE_CUTOFF())).map((o) => o.resourceId);
      expect(again).toEqual([ids[1], ids[2], ids[0]]);
    } finally {
      await solo.cleanup().catch(() => {});
    }
  });
});
