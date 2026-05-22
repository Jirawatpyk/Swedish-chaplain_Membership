/**
 * T037 — F7.1a US1 Pagination CI smoke (7,500 recipients).
 *
 * Phase 3E.2 (2026-05-19) — converted from skip-equivalent to a
 * LEAN integration test that exercises the `splitBroadcastIntoBatches`
 * use case against the live Drizzle `BatchManifestsPort` adapter
 * with a synthetic recipient count input. The original spec called
 * for seeding a 7,500-member tenant + full submit→approve→dispatch
 * flow — that level of setup (mock Resend + member bulk-insert +
 * webhook simulation) is Phase 3E.3 operator-gated work.
 *
 * The lean variant verifies:
 *   (a) `splitBroadcastIntoBatches` accepts 7,500 recipients and
 *       produces exactly 1 `broadcast_batch_manifests` row
 *   (b) The persisted row has recipient_count=7500, range [0..7499],
 *       status='pending', idempotency_key in expected format
 *   (c) Re-invocation with same broadcastId returns
 *       BATCH_ALREADY_DISPATCHED (idempotency)
 *
 * Skipped when DATABASE_URL is unset (CI uses live Neon Singapore;
 * local dev requires the test DB env var). Throwaway broadcast ids
 * + cleanup are scoped per-test so concurrent runs don't collide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { splitBroadcastIntoBatches } from '@/modules/broadcasts/application/use-cases/split-broadcast-into-batches';
import { makeDrizzleBatchManifestsRepo } from '@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { systemClock } from '@/modules/broadcasts/infrastructure/broadcasts-deps';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL);
const TEST_TENANT = 'swecham';
const TEST_BROADCAST_IDS: string[] = [];

describe.runIf(RUN_INTEGRATION)(
  'F7.1a US1 7,500-end-to-end lean integration (T037)',
  () => {
    beforeAll(async () => {
      // Seed a host broadcast row that the manifests can FK to.
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
              'admin_proxy', 'T037 lean integration host', '<p>x</p>', '<p>x</p>',
              'T037 Test', 'noreply@swecham.example', 'all_members', NULL,
              NULL, 7500
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

    it('7,500 recipients → exactly 1 batch row persisted with correct range', async () => {
      const broadcastIdRaw = TEST_BROADCAST_IDS[0]!;
      const broadcastId = asBroadcastId(broadcastIdRaw);
      const tenantCtx = asTenantContext(TEST_TENANT);

      const deps = {
        batchManifests: makeDrizzleBatchManifestsRepo(TEST_TENANT),
        audit: f7AuditAdapter,
        clock: systemClock,
      };

      const result = await splitBroadcastIntoBatches(deps, {
        tenantId: tenantCtx,
        broadcastId,
        resolvedRecipientCount: 7_500,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.batchCount).toBe(1);
      expect(result.value.batchManifestIds).toHaveLength(1);

      // Verify the persisted row matches expectations.
      const rows = (await runInTenant(tenantCtx, async (tx) =>
        tx.execute(sql`
          SELECT batch_index, recipient_count, recipient_range_start,
                 recipient_range_end, status, idempotency_key
          FROM broadcast_batch_manifests
          WHERE tenant_id = ${TEST_TENANT}
            AND broadcast_id = ${broadcastIdRaw}::uuid
          ORDER BY batch_index ASC
        `),
      )) as unknown as Array<{
        batch_index: number;
        recipient_count: number;
        recipient_range_start: number;
        recipient_range_end: number;
        status: string;
        idempotency_key: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.batch_index).toBe(0);
      expect(rows[0]!.recipient_count).toBe(7500);
      expect(rows[0]!.recipient_range_start).toBe(0);
      expect(rows[0]!.recipient_range_end).toBe(7499);
      expect(rows[0]!.status).toBe('pending');
      expect(rows[0]!.idempotency_key).toMatch(
        new RegExp(`^broadcast-${broadcastIdRaw}-batch-0-attempt-0$`),
      );
    }, 15_000);

    it('re-invocation with same broadcastId → BATCH_ALREADY_DISPATCHED (idempotency)', async () => {
      const broadcastIdRaw = TEST_BROADCAST_IDS[1]!;
      const broadcastId = asBroadcastId(broadcastIdRaw);
      const tenantCtx = asTenantContext(TEST_TENANT);

      const deps = {
        batchManifests: makeDrizzleBatchManifestsRepo(TEST_TENANT),
        audit: f7AuditAdapter,
        clock: systemClock,
      };

      // First call — succeeds.
      const first = await splitBroadcastIntoBatches(deps, {
        tenantId: tenantCtx,
        broadcastId,
        resolvedRecipientCount: 7_500,
      });
      expect(first.ok).toBe(true);

      // Second call with same broadcastId + same attempt → idempotency
      // key collision → BATCH_ALREADY_DISPATCHED via the unique index
      // on (tenant_id, idempotency_key).
      const second = await splitBroadcastIntoBatches(deps, {
        tenantId: tenantCtx,
        broadcastId,
        resolvedRecipientCount: 7_500,
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect((second.error as { kind: string }).kind).toBe(
        'BATCH_ALREADY_DISPATCHED',
      );

      // Verify only 1 row persisted (the second call's INSERT was rejected).
      const rows = (await runInTenant(tenantCtx, async (tx) =>
        tx.execute(sql`
          SELECT COUNT(*)::int AS count
          FROM broadcast_batch_manifests
          WHERE tenant_id = ${TEST_TENANT}
            AND broadcast_id = ${broadcastIdRaw}::uuid
        `),
      )) as unknown as Array<{ count: number }>;
      expect(rows[0]!.count).toBe(1);
    }, 15_000);
  },
);

// Re-export `db` to avoid TS unused-import warning if test env strips it.
void db;
