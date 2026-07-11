/**
 * Bug #16 (code-review revision) — referencedAudienceIdsForBroadcasts must
 * return, for each live broadcast, the SET of EVERY audience id it references:
 * broadcasts.resend_audience_id UNION every
 * broadcast_batch_manifests.provider_audience_id. The per-batch join is
 * load-bearing: without it, reclaim-orphaned-audiences would delete a live
 * split broadcast's in-use per-batch audiences (they live only in the
 * manifests; broadcasts.resend_audience_id stays NULL on the split path).
 *
 * Live DB — validates the actual LEFT JOIN SQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { broadcastBatchManifests } from '@/modules/broadcasts/infrastructure/schema';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('referencedAudienceIdsForBroadcasts — bug #16 (row + batch-manifest audiences)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  });

  afterAll(async () => {
    if (tenant) {
      await db
        .delete(broadcastBatchManifests)
        .where(eq(broadcastBatchManifests.tenantId, tenant.ctx.slug));
      await tenant.cleanup();
    }
  });

  it('unions broadcasts.resend_audience_id with every batch manifest provider_audience_id', async () => {
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    const bid = asBroadcastId(randomUUID());

    // Create a draft broadcast, then attach a main (MVP) audience id.
    await repo.withTx((tx) =>
      repo.insertDraft(tx, {
        tenantId: tenant.ctx.slug,
        broadcastId: bid,
        requestedByMemberId: randomUUID(),
        requestedByMemberPlanIdSnapshot: 'plan-x',
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: 'ref-audiences',
        bodyHtml: '<p>b</p>',
        bodySource: 'b',
        fromName: 'X via T',
        replyToEmail: 'r@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 1,
        scheduledFor: null,
      }),
    );
    await repo.withTx((tx) =>
      repo.attachAudienceId(tx, tenant.ctx.slug, bid, 'aud-main'),
    );

    // Two per-batch audiences live ONLY in the manifests.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(broadcastBatchManifests).values([
        {
          tenantId: tenant.ctx.slug,
          broadcastId: bid,
          batchIndex: 0,
          recipientCount: 1,
          recipientRangeStart: 0,
          recipientRangeEnd: 0,
          idempotencyKey: `k0-${randomUUID()}`,
          providerAudienceId: 'aud-batch0',
        },
        {
          tenantId: tenant.ctx.slug,
          broadcastId: bid,
          batchIndex: 1,
          recipientCount: 1,
          recipientRangeStart: 1,
          recipientRangeEnd: 1,
          idempotencyKey: `k1-${randomUUID()}`,
          providerAudienceId: 'aud-batch1',
        },
      ]),
    );

    const refs = await repo.referencedAudienceIdsForBroadcasts!(
      tenant.ctx.slug,
      [bid],
    );
    const set = refs.get(bid);
    expect(set).toBeDefined();
    expect([...set!].sort()).toEqual(['aud-batch0', 'aud-batch1', 'aud-main']);

    // A broadcast id whose row does not exist is simply absent from the map.
    const missing = asBroadcastId(randomUUID());
    const refs2 = await repo.referencedAudienceIdsForBroadcasts!(
      tenant.ctx.slug,
      [missing],
    );
    expect(refs2.has(missing)).toBe(false);
  });

  it('a live broadcast with no audience anywhere maps to an EMPTY set (not absent)', async () => {
    const repo = makeDrizzleBroadcastsRepo(tenant.ctx.slug);
    const bid = asBroadcastId(randomUUID());
    await repo.withTx((tx) =>
      repo.insertDraft(tx, {
        tenantId: tenant.ctx.slug,
        broadcastId: bid,
        requestedByMemberId: randomUUID(),
        requestedByMemberPlanIdSnapshot: 'plan-x',
        submittedByUserId: randomUUID(),
        actorRole: 'member_self_service',
        subject: 'ref-audiences-empty',
        bodyHtml: '<p>b</p>',
        bodySource: 'b',
        fromName: 'X via T',
        replyToEmail: 'r@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 1,
        scheduledFor: null,
      }),
    );

    const refs = await repo.referencedAudienceIdsForBroadcasts!(
      tenant.ctx.slug,
      [bid],
    );
    expect(refs.has(bid)).toBe(true);
    expect(refs.get(bid)!.size).toBe(0);
  });
});
