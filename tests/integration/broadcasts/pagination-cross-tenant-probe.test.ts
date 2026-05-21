/**
 * T036 — F7.1a US1 Pagination cross-tenant probe (REVIEW-GATE BLOCKER).
 *
 * Authored RED 2026-05-19 per Constitution II NON-NEG TDD. The DB
 * surface (table + RLS+FORCE policies) already exists from Phase 2
 * migrations 0163 + 0166 applied to live Neon Singapore — so the
 * DB-layer probes (SELECT / UPDATE / DELETE / INSERT) in this test
 * can run GREEN today. The audit-event emit assertion stays RED
 * until Phase 3 Cluster B lands the `enforce-tenant-context.ts` use
 * case extension that wires `broadcast_cross_tenant_probe` for the
 * new `broadcast_batch_manifests` table.
 *
 * Constitution v1.4.0 Principle I clause 3 — cross-tenant probes on
 * every CRUD operation against the new F7.1a `broadcast_batch_manifests`
 * table, from BOTH directions (A probing B, B probing A). Failure of
 * ANY assertion = ship blocker for F7.1a.
 *
 * Sibling files:
 *   - tests/integration/broadcasts/tenant-isolation.test.ts (F7 MVP,
 *     covers broadcasts + broadcast_deliveries +
 *     marketing_unsubscribes + broadcast_segment_definitions)
 *   - Future: tests/integration/broadcasts/image-allowlist-cross-tenant-probe.test.ts (T065, US2)
 *   - Future: tests/integration/broadcasts/template-cross-tenant-probe.test.ts (T093, US7)
 *
 * Why broadcast_batch_manifests specifically: each batch manifest
 * carries `(tenant_id, broadcast_id, batch_index, idempotency_key)`.
 * A cross-tenant leak would expose the dispatch metadata (recipient
 * range, audience ID, status) — PDPA §28 / GDPR Art. 6 violation.
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
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { retryFailedBatches } from '@/modules/broadcasts/application/use-cases/retry-failed-batches';
import { makeRetryFailedBatchesDeps } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('F7.1a Pagination cross-tenant probe — REVIEW-GATE BLOCKER (T036)', () => {
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

  describe('cross_tenant_probe audit emit (T127 — Phase 6 wiring verify)', () => {
    // T127 (F7.1a Phase 6) — un-skipped 2026-05-21. Phase 3F.1 fix F-01
    // wired the probe-emit into `retryFailedBatches.ts:115-144`: when
    // the broadcast lookup returns null under RLS (cross-tenant or
    // genuinely missing), the use-case emits `broadcast_cross_tenant_probe`
    // BEFORE returning BROADCAST_NOT_FOUND. This test drives that path
    // end-to-end against live Neon and verifies the audit row commits.
    //
    // Probe vector: tenant A actor calls retryFailedBatches targeting
    // tenant B's broadcastId → broadcasts.findById(tenantA, bBroadcastId)
    // returns null under RLS → use-case emits probe + returns err.
    //
    // Verification: query audit_log via schema-owner bypass-RLS read
    // (no tenant filter — we want to see the row from tenant A's emit).
    it('retryFailedBatches with cross-tenant broadcastId emits broadcast_cross_tenant_probe', async () => {
      const probeRequestId = `t127-probe-${randomUUID()}`;
      const actorUserId = randomUUID();

      const result = await retryFailedBatches(
        makeRetryFailedBatchesDeps(tenantA.ctx.slug),
        {
          // Phase 3F.11.6 TxToken brand — tenantA.ctx is a TenantContext
          tenantId: tenantA.ctx,
          // Cross-tenant probe target: B's broadcast under A's context
          broadcastId: bBroadcastId as never,
          actorUserId,
          requestId: probeRequestId,
        },
      );

      // Step 1: result is BROADCAST_NOT_FOUND (RLS hid B's broadcast)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('BROADCAST_NOT_FOUND');
      }

      // Step 2: audit row committed via schema-owner bypass-RLS read.
      // Filter by requestId (unique per probe) + tenantId — eventType
      // is asserted in JS to dodge Drizzle's narrow enum-inferred type
      // (the DB enum is correct; the .ts schema lags behind migrations).
      const probeRows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.requestId, probeRequestId),
            eq(auditLog.tenantId, tenantA.ctx.slug),
          ),
        );

      expect(probeRows).toHaveLength(1);
      const row = probeRows[0];
      expect(row?.eventType).toBe('broadcast_cross_tenant_probe');
      expect(row?.actorUserId).toBe(actorUserId);
      expect(row?.payload).toMatchObject({
        probedBroadcastId: bBroadcastId,
        expectedTenantId: tenantA.ctx.slug,
        useCase: 'retry-failed-batches',
      });
    });
  });
});
