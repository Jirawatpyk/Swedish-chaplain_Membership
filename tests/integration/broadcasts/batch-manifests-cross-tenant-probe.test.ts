/**
 * RLS probes on `broadcast_batch_manifests` — restored in 108 Phase 9 review
 * round 1 (S24).
 *
 * `pagination-cross-tenant-probe.test.ts` was deleted in `ca51f59a1` because it
 * imported `retryFailedBatches`, which went with the batch path. That reasoning
 * covered ONE of its two halves. The other half — four CRUD probes proving RLS
 * isolates this table in both directions — imported nothing from the batch path
 * and asserted a Constitution Principle I property that is still live.
 *
 * The table is NOT inert, which is why the guard still matters. Three readers
 * remain: the `LEFT JOIN` in `referencedAudienceIdsForBroadcasts` (the check
 * that stops `reclaim-orphaned-audiences` deleting an in-use Resend audience),
 * `check:f71a-schema`, and — until this review removed it — a gauge. Its RLS
 * POLICIES were never touched; what the deletion removed was the only thing
 * that would notice if they stopped holding.
 *
 * Dropped from the original: the `broadcast_cross_tenant_probe` audit-emit case,
 * whose vector was `retryFailedBatches`. There is no longer a use case that
 * reaches this table, so there is no emit site to assert. That is a real
 * reduction in coverage and it is stated rather than hidden — the DB layer is
 * what is guarded here now.
 *
 * Sibling probes: `tenant-isolation.test.ts` (broadcasts, deliveries,
 * unsubscribes, segment definitions), `image-allowlist-cross-tenant-probe`,
 * `template-cross-tenant-probe`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import {
  broadcasts,
  broadcastBatchManifests,
  type NewBroadcastRow,
  type NewBroadcastBatchManifestRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('broadcast_batch_manifests cross-tenant RLS probe (Principle I clause 3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let aBroadcastId: string;
  let bBroadcastId: string;
  let aBatchManifestId: string;
  let bBatchManifestId: string;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Insert one broadcast + one batch manifest per tenant via the
    // schema-owner connection (`db`) which BYPASSES RLS — the test
    // helper needs cross-tenant write access to set up the fixtures.
    aBroadcastId = randomUUID();
    bBroadcastId = randomUUID();
    aBatchManifestId = randomUUID();
    bBatchManifestId = randomUUID();

    const baseBroadcast = (
      tenantId: string,
      broadcastId: string,
    ): NewBroadcastRow => ({
      tenantId,
      broadcastId,
      requestedByMemberId: randomUUID(),
      requestedByMemberPlanIdSnapshot: 'corporate',
      submittedByUserId: randomUUID(),
      actorRole: 'member_self_service',
      subject: 'isolation probe broadcast',
      bodyHtml: '<p>isolation probe</p>',
      bodySource: 'html',
      fromName: 'Test',
      replyToEmail: 'reply@example.com',
      segmentType: 'all_members',
      estimatedRecipientCount: 1,
      // Migration 0169 added 'partially_sent' + 'partial_delivery_accepted'
      // enum values 2026-05 — fixture switched 2026-05-21 (review finding
      // pr-test-analyzer #4) to `partially_sent` so the retry-trigger
      // probe at T127 exercises the SAME state the production retry path
      // sees. Previously the fixture used 'sending' which would let a
      // regression in `retryFailedBatches` that only manifests under
      // `partially_sent` slip past this probe.
      status: 'partially_sent' as const,
    });

    const baseBatchManifest = (
      tenantId: string,
      broadcastId: string,
      id: string,
    ): NewBroadcastBatchManifestRow => ({
      id,
      tenantId,
      broadcastId,
      batchIndex: 0,
      recipientCount: 1000,
      recipientRangeStart: 0,
      recipientRangeEnd: 999,
      status: 'pending',
      idempotencyKey: `broadcast-${broadcastId}-batch-0-attempt-0`,
    });

    await db.insert(broadcasts).values(baseBroadcast(tenantA.ctx.slug, aBroadcastId));
    await db.insert(broadcasts).values(baseBroadcast(tenantB.ctx.slug, bBroadcastId));
    await db
      .insert(broadcastBatchManifests)
      .values(baseBatchManifest(tenantA.ctx.slug, aBroadcastId, aBatchManifestId));
    await db
      .insert(broadcastBatchManifests)
      .values(baseBatchManifest(tenantB.ctx.slug, bBroadcastId, bBatchManifestId));
  });

  afterAll(async () => {
    // Cleanup via schema-owner BYPASS-RLS connection
    await db
      .delete(broadcastBatchManifests)
      .where(eq(broadcastBatchManifests.id, aBatchManifestId));
    await db
      .delete(broadcastBatchManifests)
      .where(eq(broadcastBatchManifests.id, bBatchManifestId));
    await db
      .delete(broadcasts)
      .where(
        and(
          eq(broadcasts.tenantId, tenantA.ctx.slug),
          eq(broadcasts.broadcastId, aBroadcastId),
        ),
      );
    await db
      .delete(broadcasts)
      .where(
        and(
          eq(broadcasts.tenantId, tenantB.ctx.slug),
          eq(broadcasts.broadcastId, bBroadcastId),
        ),
      );
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  describe('broadcast_batch_manifests', () => {
    it('tenant A cannot SELECT tenant B batch_manifest by id', async () => {
      const rows = await runInTenant(tenantA.ctx, async (tx) =>
        tx
          .select()
          .from(broadcastBatchManifests)
          .where(eq(broadcastBatchManifests.id, bBatchManifestId)),
      );
      expect(rows).toEqual([]);
    });

    it('tenant B cannot SELECT tenant A batch_manifest by id', async () => {
      const rows = await runInTenant(tenantB.ctx, async (tx) =>
        tx
          .select()
          .from(broadcastBatchManifests)
          .where(eq(broadcastBatchManifests.id, aBatchManifestId)),
      );
      expect(rows).toEqual([]);
    });

    it('tenant A SELECT batch_manifests sees ONLY tenant A rows', async () => {
      const rows = await runInTenant(tenantA.ctx, async (tx) =>
        tx.select().from(broadcastBatchManifests),
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.tenantId === tenantA.ctx.slug)).toBe(true);
    });

    it('tenant A UPDATE on tenant B batch_manifest → 0 rows affected (RLS hides target)', async () => {
      const updated = await runInTenant(tenantA.ctx, async (tx) =>
        tx
          .update(broadcastBatchManifests)
          .set({ status: 'failed', failureReason: 'cross-tenant probe — should not stick' })
          .where(eq(broadcastBatchManifests.id, bBatchManifestId))
          .returning(),
      );
      expect(updated).toEqual([]);

      // Verify B's row unchanged via schema-owner BYPASS-RLS check
      const bRows = await db
        .select()
        .from(broadcastBatchManifests)
        .where(eq(broadcastBatchManifests.id, bBatchManifestId));
      expect(bRows[0]?.status).toBe('pending');
      expect(bRows[0]?.failureReason).toBeNull();
    });

    it('tenant A DELETE on tenant B batch_manifest → 0 rows affected', async () => {
      const deleted = await runInTenant(tenantA.ctx, async (tx) =>
        tx
          .delete(broadcastBatchManifests)
          .where(eq(broadcastBatchManifests.id, bBatchManifestId))
          .returning(),
      );
      expect(deleted).toEqual([]);

      // B's row should still exist
      const bRows = await db
        .select()
        .from(broadcastBatchManifests)
        .where(eq(broadcastBatchManifests.id, bBatchManifestId));
      expect(bRows).toHaveLength(1);
    });

    it('tenant A INSERT with tenant B tenant_id → blocked by WITH CHECK clause', async () => {
      await expect(async () => {
        await runInTenant(tenantA.ctx, async (tx) =>
          tx.insert(broadcastBatchManifests).values({
            id: randomUUID(),
            tenantId: tenantB.ctx.slug, // ← cross-tenant attempt
            broadcastId: bBroadcastId,
            batchIndex: 99,
            recipientCount: 1,
            recipientRangeStart: 0,
            recipientRangeEnd: 0,
            status: 'pending',
            idempotencyKey: `cross-tenant-probe-${randomUUID()}`,
          }),
        );
      }).rejects.toThrow();
    });
  });
});
