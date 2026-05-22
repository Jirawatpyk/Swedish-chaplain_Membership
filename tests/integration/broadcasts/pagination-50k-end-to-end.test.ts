/**
 * T038 — F7.1a US1 SC-002 perf bench (50,000 recipients).
 *
 * **TC-008 closure 2026-05-21** — converted from `expect.fail`
 * placeholder to a LEAN integration test that exercises
 * `splitBroadcastIntoBatches` against the live Drizzle
 * `BatchManifestsPort` adapter with 50,000 recipients. Mirrors the
 * T037 7,500 pattern at `pagination-7500-end-to-end.test.ts` exactly,
 * just scaled to 5-batch shape per FR-002 + Resend 10k per-audience cap.
 *
 * SC-002 contract (spec.md):
 *   A broadcast targeting up to 50,000 recipients completes dispatch
 *   within **45 minutes** of admin approval, with all per-batch
 *   failure modes recoverable via the existing reconcile-stuck-sending
 *   cron extended to per-batch granularity.
 *
 * Split-correctness verified IN-SESSION (this file):
 *   - exactly 5 batch_manifest rows created
 *   - each batch.recipient_count = 10000
 *   - batch_index 0..4 contiguous + monotonic
 *   - recipient_range_start / _end correct (no gaps, no overlaps)
 *   - idempotency_key in expected format
 *   - re-invocation returns BATCH_ALREADY_DISPATCHED (idempotency)
 *
 * **45-min wall-clock budget (full E2E)** — STAGING-ONLY at T142
 * operator gate per `qa/ship-day-checklist.md § B.1`. Requires:
 *   1. 50,000 throwaway-tenant members seeded (chunked INSERT to
 *      avoid statement_timeout)
 *   2. Live Resend gateway connection (cannot test from CLI without
 *      polluting the Resend account + sending fake emails)
 *   3. Webhook simulator OR live Resend webhook for per-batch counter
 *      reconciliation
 *   4. Wall-clock measurement: split → dispatch → 5 batches reach
 *      terminal `sent` status within 45 min
 * The wall-clock measurement is necessarily a staging exercise;
 * Bangkok ↔ Neon Singapore RTT (~25ms) × 50,000 recipient inserts
 * would alone exceed 45 min in a local CI sandbox. The lean variant
 * here proves SPLIT-CORRECTNESS at 50k; the wall-clock budget proves
 * DISPATCH-PIPELINE-CORRECTNESS at staging.
 *
 * Skipped when DATABASE_URL is unset (CI uses live Neon Singapore;
 * local dev requires the test DB env var). Throwaway broadcast ids +
 * cleanup are scoped per-test so concurrent runs don't collide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { splitBroadcastIntoBatches } from '@/modules/broadcasts/application/use-cases/split-broadcast-into-batches';
import { makeDrizzleBatchManifestsRepo } from '@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { systemClock } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { broadcastBatchManifests } from '@/modules/broadcasts/infrastructure/schema';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL);
const TEST_TENANT = 'swecham';
const TEST_BROADCAST_IDS: string[] = [];

describe.runIf(RUN_INTEGRATION)(
  'F7.1a US1 SC-002 50k split-correctness (T038 lean integration — TC-008 closure)',
  () => {
    beforeAll(async () => {
      // Seed 2 host broadcast rows for the split + idempotency probe.
      // Composite FK (tenant_id, broadcast_id) → broadcasts requires
      // a real row, not just a UUID literal.
      await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        for (let i = 0; i < 2; i++) {
          const broadcastId = randomUUID();
          TEST_BROADCAST_IDS.push(broadcastId);
          const memberId = randomUUID();
          const userId = randomUUID();
          await tx.execute(sql`
            INSERT INTO broadcasts (
              tenant_id, broadcast_id, status, requested_by_member_id,
              requested_by_member_plan_id_snapshot, submitted_by_user_id,
              actor_role, subject, body_html, body_source, from_name,
              reply_to_email, segment_type, segment_params,
              custom_recipient_emails, estimated_recipient_count
            ) VALUES (
              ${TEST_TENANT}, ${broadcastId}::uuid, 'draft',
              ${memberId}::uuid, ${randomUUID()}::uuid, ${userId}::uuid,
              'admin_proxy', 'T038 50k lean integration host', '<p>x</p>', '<p>x</p>',
              'T038 Test', 'noreply@swecham.example', 'all_members', NULL,
              NULL, 50000
            )
            ON CONFLICT (tenant_id, broadcast_id) DO NOTHING
          `);
        }
      });
    });

    afterAll(async () => {
      // Cleanup host broadcasts + cascade-removes batch manifests via FK.
      await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        for (const id of TEST_BROADCAST_IDS) {
          await tx.execute(sql`
            DELETE FROM broadcasts
            WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${id}::uuid
          `);
        }
      });
    });

    it('50,000 recipients → exactly 5 batches × 10,000 with contiguous ranges + correct status + correct idempotency keys', async () => {
      const tenantCtx = asTenantContext(TEST_TENANT);
      const broadcastId = asBroadcastId(TEST_BROADCAST_IDS[0]!);
      const batchManifestsRepo = makeDrizzleBatchManifestsRepo(TEST_TENANT);

      const result = await splitBroadcastIntoBatches(
        {
          batchManifests: batchManifestsRepo,
          audit: f7AuditAdapter,
          clock: systemClock,
        },
        {
          tenantId: tenantCtx,
          broadcastId,
          resolvedRecipientCount: 50_000,
          attempt: 0,
          requestId: 'req-tc-008-50k-split',
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.batchManifestIds).toHaveLength(5);

      // Verify per-batch row shape via bypass-RLS read on the schema-
      // owner connection (matches the T037 read pattern).
      const rows = await db
        .select()
        .from(broadcastBatchManifests)
        .where(
          and(
            eq(broadcastBatchManifests.tenantId, TEST_TENANT),
            eq(broadcastBatchManifests.broadcastId, broadcastId as string),
          ),
        )
        .orderBy(broadcastBatchManifests.batchIndex);

      expect(rows).toHaveLength(5);

      // Each batch: 10,000 recipients · contiguous ranges · pending status
      // · idempotency key in expected per-batch-attempt format.
      let expectedRangeStart = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        expect(row.batchIndex).toBe(i);
        expect(row.recipientCount).toBe(10_000);
        expect(row.recipientRangeStart).toBe(expectedRangeStart);
        expect(row.recipientRangeEnd).toBe(expectedRangeStart + 10_000 - 1);
        expect(row.status).toBe('pending');
        // Idempotency key format (per plan.md § VIII Reliability):
        //   `broadcast-{broadcastId}-batch-{batchIndex}-attempt-{retryCount}`
        expect(row.idempotencyKey).toBe(
          `broadcast-${broadcastId as string}-batch-${i}-attempt-0`,
        );
        expectedRangeStart += 10_000;
      }

      // Contiguous + non-overlapping invariant: last range_end MUST be
      // 49_999 (50_000 - 1).
      expect(rows[rows.length - 1]!.recipientRangeEnd).toBe(49_999);
    });

    it('re-invocation with same broadcastId returns BATCH_ALREADY_DISPATCHED (idempotency)', async () => {
      const tenantCtx = asTenantContext(TEST_TENANT);
      // Use the SAME broadcast id from the first test — manifests already exist.
      const broadcastId = asBroadcastId(TEST_BROADCAST_IDS[0]!);
      const batchManifestsRepo = makeDrizzleBatchManifestsRepo(TEST_TENANT);

      const result = await splitBroadcastIntoBatches(
        {
          batchManifests: batchManifestsRepo,
          audit: f7AuditAdapter,
          clock: systemClock,
        },
        {
          tenantId: tenantCtx,
          broadcastId,
          resolvedRecipientCount: 50_000,
          attempt: 0,
          requestId: 'req-tc-008-50k-idempotent',
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('BATCH_ALREADY_DISPATCHED');
    });
  },
);
