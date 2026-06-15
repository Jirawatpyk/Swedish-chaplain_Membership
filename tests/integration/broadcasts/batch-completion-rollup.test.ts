/**
 * Ship-blocker A — integration test for the batch-completion roll-up on
 * live Neon. Verifies the finder (raw SQL) + the real DB transitions
 * (sending → sent + quota, sending → partially_sent) that only became
 * possible after H-1 taught the trigger the F7.1a edges.
 *
 * Seeds via raw SQL (each test fresh ids); cleaned up via ON DELETE
 * CASCADE in afterAll. Uses rollUpBatchBroadcast PER broadcast (not the
 * tenant-wide sweep) so the assertions are isolated from any other
 * 'sending' batch rows in the shared tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext, type TenantSlug } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import {
  makeRollUpBatchBroadcastDeps,
  rollUpBatchBroadcast,
} from '@/modules/broadcasts';
import { makeDrizzleBatchManifestsRepo } from '@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL);
const TEST_TENANT = 'swecham';

describe.runIf(RUN_INTEGRATION)('Ship-blocker A — batch completion roll-up', () => {
  const ctx = asTenantContext(TEST_TENANT);
  const deps = makeRollUpBatchBroadcastDeps(TEST_TENANT);
  const batchRepo = makeDrizzleBatchManifestsRepo(TEST_TENANT);
  const seeded: string[] = [];

  /** Seed a 'sending' broadcast + N batches with given counters/status. */
  async function seed(
    batches: ReadonlyArray<{
      delivered?: number;
      status?: string;
      recipientCount?: number;
      retryCount?: number;
    }>,
  ): Promise<string> {
    const broadcastId = randomUUID();
    seeded.push(broadcastId);
    await runInTenant(ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO broadcasts (
          tenant_id, broadcast_id, status, requested_by_member_id,
          requested_by_member_plan_id_snapshot, submitted_by_user_id,
          actor_role, subject, body_html, body_source, from_name,
          reply_to_email, segment_type, estimated_recipient_count,
          sending_started_at
        ) VALUES (
          ${TEST_TENANT}, ${broadcastId}::uuid, 'sending',
          ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
          'admin_proxy', 'rollup test', '<p>x</p>', 'x',
          'Test', 'noreply@swecham.example', 'all_members', 100, now()
        )
      `);
      let i = 0;
      for (const b of batches) {
        const rc = b.recipientCount ?? 100;
        await tx.execute(sql`
          INSERT INTO broadcast_batch_manifests (
            tenant_id, broadcast_id, batch_index, recipient_count,
            recipient_range_start, recipient_range_end, idempotency_key,
            status, delivered_count, retry_count
          ) VALUES (
            ${TEST_TENANT}, ${broadcastId}::uuid, ${i}, ${rc},
            0, ${rc - 1}, ${`broadcast-${broadcastId}-batch-${i}-attempt-0`},
            ${b.status ?? 'sending'}, ${b.delivered ?? 0}, ${b.retryCount ?? 0}
          )
        `);
        i++;
      }
    });
    return broadcastId;
  }

  async function statusOf(id: string): Promise<{ status: string; quota: number | null }> {
    const rows = (await runInTenant(ctx, async (tx) =>
      tx.execute(sql`
        SELECT status, quota_year_consumed AS quota
        FROM broadcasts
        WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${id}::uuid
      `),
    )) as unknown as Array<{ status: string; quota: number | null }>;
    return rows[0]!;
  }

  beforeAll(() => undefined);

  afterAll(async () => {
    await runInTenant(ctx, async (tx) => {
      for (const id of seeded) {
        await tx.execute(sql`
          DELETE FROM broadcasts
          WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${id}::uuid
        `);
      }
    });
  });

  it('finder lists a sending broadcast that has batches', async () => {
    const id = await seed([{ delivered: 0 }]);
    const ids = await batchRepo.findSendingBroadcastIdsWithBatches(
      TEST_TENANT as TenantSlug,
      200,
    );
    expect(ids.map((x) => x as unknown as string)).toContain(id);
  });

  it('all batches counter-complete → sending → sent + quota consumed', async () => {
    const id = await seed([{ delivered: 100 }, { delivered: 100 }]);
    const r = await rollUpBatchBroadcast(deps, {
      broadcastId: asBroadcastId(id),
      requestId: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('rolled_up_sent');
    const after = await statusOf(id);
    expect(after.status).toBe('sent');
    expect(after.quota).not.toBeNull();
  });

  it('≥1 batch failed → sending → partially_sent (no quota)', async () => {
    const id = await seed([
      { delivered: 100 },
      { status: 'failed', retryCount: 5 },
    ]);
    const r = await rollUpBatchBroadcast(deps, {
      broadcastId: asBroadcastId(id),
      requestId: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('rolled_up_partial');
    const after = await statusOf(id);
    expect(after.status).toBe('partially_sent');
    expect(after.quota).toBeNull();
  });

  it('a batch still in progress → broadcast stays sending', async () => {
    const id = await seed([{ delivered: 100 }, { delivered: 50 }]);
    const r = await rollUpBatchBroadcast(deps, {
      broadcastId: asBroadcastId(id),
      requestId: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('in_progress');
    const after = await statusOf(id);
    expect(after.status).toBe('sending');
  });
});
