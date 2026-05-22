/**
 * Phase 3F.8 (2026-05-19) — Integration test verifying the composite
 * FK CASCADE behavior on `broadcast_batch_manifests` per pr-review
 * Finding F-19. The `findBatchByProviderBroadcastIdBypassRls` adapter
 * relies on the assumption that hard-deleting a broadcast also
 * removes its manifests — if a future migration loosens the FK to
 * ON DELETE SET NULL or NO ACTION, the webhook routing path could
 * silently resolve to half-stale tenant data.
 *
 * Test seeds (a) a broadcast row + 2 batch_manifest rows, (b)
 * deletes the broadcast, (c) verifies the manifests are gone.
 *
 * Runs on live Neon Singapore via `DATABASE_URL`. Throwaway IDs
 * cleaned up in `afterAll` so concurrent runs don't collide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL);
const TEST_TENANT = 'swecham';
const TEST_BROADCAST_IDS: string[] = [];

describe.runIf(RUN_INTEGRATION)(
  'F7.1a batch-manifests FK CASCADE (Phase 3F.8 / F-19)',
  () => {
    beforeAll(async () => {
      await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
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
            'admin_proxy', 'F-19 FK CASCADE test', '<p>x</p>', '<p>x</p>',
            'F-19 Test', 'noreply@swecham.example', 'all_members', NULL,
            NULL, 100
          )
        `);

        // 2 batch_manifest rows under this broadcast
        for (let i = 0; i < 2; i++) {
          await tx.execute(sql`
            INSERT INTO broadcast_batch_manifests (
              tenant_id, broadcast_id, batch_index, recipient_count,
              recipient_range_start, recipient_range_end, idempotency_key, status
            ) VALUES (
              ${TEST_TENANT}, ${broadcastId}::uuid, ${i}, 50,
              ${i * 50}, ${i * 50 + 49},
              ${`broadcast-${broadcastId}-batch-${i}-attempt-0`}, 'pending'
            )
          `);
        }
      });
    });

    afterAll(async () => {
      // Defensive cleanup — should be a no-op if the CASCADE test passed,
      // but covers the case where the test FAILED and left rows.
      await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        for (const id of TEST_BROADCAST_IDS) {
          await tx.execute(sql`
            DELETE FROM broadcasts
            WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${id}::uuid
          `);
        }
      });
    });

    it('DELETE broadcasts cascades to broadcast_batch_manifests', async () => {
      const broadcastIdRaw = TEST_BROADCAST_IDS[0]!;
      const tenantCtx = asTenantContext(TEST_TENANT);

      // Verify the 2 manifest rows exist before delete.
      const beforeRows = (await runInTenant(tenantCtx, async (tx) =>
        tx.execute(sql`
          SELECT COUNT(*)::int AS count
          FROM broadcast_batch_manifests
          WHERE tenant_id = ${TEST_TENANT}
            AND broadcast_id = ${broadcastIdRaw}::uuid
        `),
      )) as unknown as Array<{ count: number }>;
      expect(beforeRows[0]!.count).toBe(2);

      // DELETE the broadcast row.
      await runInTenant(tenantCtx, async (tx) => {
        await tx.execute(sql`
          DELETE FROM broadcasts
          WHERE tenant_id = ${TEST_TENANT}
            AND broadcast_id = ${broadcastIdRaw}::uuid
        `);
      });

      // Verify manifest rows are gone (composite FK ON DELETE CASCADE
      // from migration 0163 fired correctly).
      const afterRows = (await runInTenant(tenantCtx, async (tx) =>
        tx.execute(sql`
          SELECT COUNT(*)::int AS count
          FROM broadcast_batch_manifests
          WHERE tenant_id = ${TEST_TENANT}
            AND broadcast_id = ${broadcastIdRaw}::uuid
        `),
      )) as unknown as Array<{ count: number }>;
      expect(afterRows[0]!.count).toBe(0);
    }, 15_000);
  },
);
