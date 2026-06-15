/**
 * F7-SF-1 — integration test for the batch webhook counter idempotency.
 *
 * The batch path's `incrementCounter` was an UNCONDITIONAL UPDATE with no
 * dedup on the Resend event id, so a Svix/Resend redelivery of the same
 * event double-counted delivered/bounced/complained/unsubscribed. The fix
 * adds the broadcast_batch_delivery_events ledger (PK = (tenant_id,
 * resend_event_id)) and INSERTs ON CONFLICT DO NOTHING in the SAME tx as
 * the increment. A mock-only unit test cannot prove this (the dedup lives
 * in raw SQL against the ledger table) — this exercises it on live Neon.
 *
 * Runs on live Neon Singapore via DATABASE_URL. Throwaway IDs (random
 * event ids per run to avoid cross-run PK collisions); the broadcast +
 * its batch + the ledger rows are cleaned up via ON DELETE CASCADE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext, type TenantSlug } from '@/modules/tenants';
import { makeDrizzleBatchManifestsRepo } from '@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL);
const TEST_TENANT = 'swecham';

describe.runIf(RUN_INTEGRATION)('F7-SF-1 — batch webhook counter dedup', () => {
  const ctx = asTenantContext(TEST_TENANT);
  const repo = makeDrizzleBatchManifestsRepo(TEST_TENANT);
  let broadcastId: string;
  let batchId: string;

  async function deliveredCount(): Promise<number> {
    const rows = (await runInTenant(ctx, async (tx) =>
      tx.execute(sql`
        SELECT delivered_count::int AS c
        FROM broadcast_batch_manifests
        WHERE tenant_id = ${TEST_TENANT} AND id = ${batchId}::uuid
      `),
    )) as unknown as Array<{ c: number }>;
    return rows[0]!.c;
  }

  beforeAll(async () => {
    broadcastId = randomUUID();
    await runInTenant(ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO broadcasts (
          tenant_id, broadcast_id, status, requested_by_member_id,
          requested_by_member_plan_id_snapshot, submitted_by_user_id,
          actor_role, subject, body_html, body_source, from_name,
          reply_to_email, segment_type, estimated_recipient_count
        ) VALUES (
          ${TEST_TENANT}, ${broadcastId}::uuid, 'sending',
          ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
          'admin_proxy', 'F7-SF-1 dedup test', '<p>x</p>', 'x',
          'Test', 'noreply@swecham.example', 'all_members', 100
        )
      `);
      const rows = (await tx.execute(sql`
        INSERT INTO broadcast_batch_manifests (
          tenant_id, broadcast_id, batch_index, recipient_count,
          recipient_range_start, recipient_range_end, idempotency_key, status
        ) VALUES (
          ${TEST_TENANT}, ${broadcastId}::uuid, 0, 100, 0, 99,
          ${`broadcast-${broadcastId}-batch-0-attempt-0`}, 'sending'
        ) RETURNING id
      `)) as unknown as Array<{ id: string }>;
      batchId = rows[0]!.id;
    });
  });

  afterAll(async () => {
    await runInTenant(ctx, async (tx) => {
      await tx.execute(sql`
        DELETE FROM broadcasts
        WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${broadcastId}::uuid
      `);
    });
  });

  it('first event increments; replay of same resend_event_id is a no-op; a new event increments', async () => {
    const evtA = `evt-${randomUUID()}`;
    const evtB = `evt-${randomUUID()}`;

    const first = await repo.incrementCounter(
      TEST_TENANT as TenantSlug,
      batchId,
      'deliveredCount',
      evtA,
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.duplicate).toBe(false);
    expect(await deliveredCount()).toBe(1);

    // Replay the SAME event id — must NOT double-count.
    const replay = await repo.incrementCounter(
      TEST_TENANT as TenantSlug,
      batchId,
      'deliveredCount',
      evtA,
    );
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.duplicate).toBe(true);
    expect(await deliveredCount()).toBe(1); // still 1, not 2

    // A DIFFERENT event id increments.
    const second = await repo.incrementCounter(
      TEST_TENANT as TenantSlug,
      batchId,
      'deliveredCount',
      evtB,
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.duplicate).toBe(false);
    expect(await deliveredCount()).toBe(2);
  }, 20_000);

  it('increment on a missing batch → not_found (FK violation mapped)', async () => {
    const missing = await repo.incrementCounter(
      TEST_TENANT as TenantSlug,
      randomUUID(),
      'deliveredCount',
      `evt-${randomUUID()}`,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('not_found');
  }, 15_000);
});
