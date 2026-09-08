/**
 * T132 (108 Phase 9b) — an audience larger than one tick is delivered ACROSS
 * ticks, on live Neon, with a recording fake gateway.
 *
 * This is the composition the unit and contract tests drive piecewise:
 *
 *   - `splitBroadcastIntoBatches` really writes N manifests through the Drizzle
 *     adapter at the new batch size (T134);
 *   - `dispatchAllPendingBatches` dispatches ONE WAVE per invocation and leaves
 *     the rest `pending` (T136) — against real rows, so a repository that
 *     silently returned every manifest instead of the pending ones would show
 *     up here and nowhere else;
 *   - a second invocation picks the remainder up and finishes, which is the
 *     resume half of FR-044.
 *
 * **The gateway is a recording fake, never real Resend.** Dev and prod share
 * `RESEND_BROADCASTS_API_KEY` and `BROADCASTS_FROM_EMAIL`, so a live push from a
 * test would create real audiences on the production account — and on the Free
 * plan (1,000 contacts) three runs of this file would exhaust it. The fake also
 * lets the wave assertions count `createAudience` calls exactly.
 *
 * Cleanup deletes the host broadcast rows; the manifests go with them through
 * the composite FK.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { splitBroadcastIntoBatches } from '@/modules/broadcasts/application/use-cases/split-broadcast-into-batches';
import { dispatchAllPendingBatches } from '@/modules/broadcasts/application/services/batch-dispatcher';
import { makeDrizzleBatchManifestsRepo } from '@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo';
import { makeDrizzleBroadcastsRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { systemClock } from '@/modules/broadcasts/infrastructure/broadcasts-deps';
import { DELIVERABLE_RECIPIENTS_PER_TICK } from '@/modules/broadcasts/domain/audience-ceiling';

const RUN_INTEGRATION = Boolean(process.env.DATABASE_URL);
const TEST_TENANT = 'swecham';
const TEST_BROADCAST_IDS: string[] = [];

/** 1,200 → three batches of 500 / 500 / 200 at the current per-tick size. */
const RECIPIENT_COUNT = 1_200;

interface RecordingGateway {
  readonly createdAudiences: string[];
  readonly contactBatchSizes: number[];
  readonly port: unknown;
}

function makeRecordingGateway(): RecordingGateway {
  const createdAudiences: string[] = [];
  const contactBatchSizes: number[] = [];
  return {
    createdAudiences,
    contactBatchSizes,
    port: {
      async createAudience(audienceName: string) {
        createdAudiences.push(audienceName);
        return { audienceId: `aud-${createdAudiences.length}` };
      },
      async addContactsToAudience(
        _audienceId: string,
        contacts: ReadonlyArray<unknown>,
      ) {
        contactBatchSizes.push(contacts.length);
      },
      async createBroadcast(args: { audienceId: string }) {
        return { broadcastId: `resend-bid-${args.audienceId}` };
      },
      async sendBroadcast() {
        /* no-op — nothing leaves this process */
      },
    },
  };
}

async function readManifestStatuses(
  broadcastIdRaw: string,
): Promise<Array<{ batch_index: number; status: string; recipient_count: number }>> {
  return (await runInTenant(asTenantContext(TEST_TENANT), async (tx) =>
    tx.execute(sql`
      SELECT batch_index, status, recipient_count
      FROM broadcast_batch_manifests
      WHERE tenant_id = ${TEST_TENANT}
        AND broadcast_id = ${broadcastIdRaw}::uuid
      ORDER BY batch_index ASC
    `),
  )) as unknown as Array<{
    batch_index: number;
    status: string;
    recipient_count: number;
  }>;
}

describe.runIf(RUN_INTEGRATION)(
  'Phase 9b — deliverable batches across ticks (T132, live Neon)',
  () => {
    beforeAll(async () => {
      await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        const broadcastId = randomUUID();
        TEST_BROADCAST_IDS.push(broadcastId);
        await tx.execute(sql`
          INSERT INTO broadcasts (
            tenant_id, broadcast_id, status, requested_by_member_id,
            requested_by_member_plan_id_snapshot, submitted_by_user_id,
            actor_role, subject, body_html, body_source, from_name,
            reply_to_email, segment_type, segment_params,
            custom_recipient_emails, estimated_recipient_count
          ) VALUES (
            ${TEST_TENANT}, ${broadcastId}::uuid, 'draft',
            ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
            'admin_proxy', 'T132 multi-tick host', '<p>x</p>', '<p>x</p>',
            'T132 Test', 'noreply@swecham.example', 'all_members', NULL,
            NULL, ${RECIPIENT_COUNT}
          )
          ON CONFLICT (tenant_id, broadcast_id) DO NOTHING
        `);
      });
    });

    afterAll(async () => {
      await runInTenant(asTenantContext(TEST_TENANT), async (tx) => {
        for (const id of TEST_BROADCAST_IDS) {
          await tx.execute(sql`
            DELETE FROM broadcasts
            WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${id}::uuid
          `);
        }
      });
    });

    it('1,200 recipients split at the per-tick size, then deliver over two invocations with cap 2', async () => {
      const broadcastIdRaw = TEST_BROADCAST_IDS[0]!;
      const broadcastId = asBroadcastId(broadcastIdRaw);
      const tenantCtx = asTenantContext(TEST_TENANT);
      const batchManifests = makeDrizzleBatchManifestsRepo(TEST_TENANT);

      // ── Split ──────────────────────────────────────────────────────────
      const split = await splitBroadcastIntoBatches(
        { batchManifests, audit: f7AuditAdapter, clock: systemClock },
        { tenantId: tenantCtx, broadcastId, resolvedRecipientCount: RECIPIENT_COUNT },
      );
      expect(split.ok).toBe(true);
      if (!split.ok) return;

      const persisted = await readManifestStatuses(broadcastIdRaw);
      expect(persisted.map((r) => r.recipient_count)).toEqual([500, 500, 200]);
      expect(persisted.every((r) => r.status === 'pending')).toBe(true);
      // Read from the DB rather than from the use case's return value: the
      // sizing has to survive the round trip through the adapter, and the
      // NOT NULL / CHECK constraints on the range columns are only exercised
      // by a real INSERT.
      expect(DELIVERABLE_RECIPIENTS_PER_TICK).toBe(500);

      const allRecipients = Array.from({ length: RECIPIENT_COUNT }, (_, i) => ({
        emailLower: `t132-r${i}@example.invalid`,
      }));
      const broadcastContent = {
        broadcastId,
        subject: 'T132',
        bodyHtml: '<p>body</p>',
        fromName: 'T132 Test',
        fromEmail: 'noreply@swecham.example',
        replyToEmail: 'noreply@swecham.example',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
      };

      // ── Tick 1 ─────────────────────────────────────────────────────────
      const gw1 = makeRecordingGateway();
      const pending1 = await batchManifests.findPendingByBroadcast(
        tenantCtx.slug,
        broadcastId,
      );
      expect(pending1).toHaveLength(3);

      const tick1 = await dispatchAllPendingBatches(
        {
          batchManifests,
          gateway: gw1.port,
          advisoryLock: { async acquire() { return { acquired: true }; } },
          audit: f7AuditAdapter,
          clock: systemClock,
        } as never,
        {
          tenantId: tenantCtx,
          broadcastContent,
          allRecipients,
          pendingBatches: pending1,
          concurrencyCap: 2,
        },
      );

      expect(tick1.totalBatches).toBe(3);
      expect(tick1.succeeded).toBe(2);
      expect(tick1.failed).toBe(0);
      expect(tick1.deferredToNextTick).toBe(1);
      // Exactly two audiences created — the third batch was never handed to
      // `dispatchBroadcastBatch`, which is the assertion the whole one-wave
      // change exists for. An orphan third audience here would be the
      // maxDuration failure reproduced in miniature.
      expect(gw1.createdAudiences).toHaveLength(2);
      expect(Math.max(...gw1.contactBatchSizes)).toBeLessThanOrEqual(
        DELIVERABLE_RECIPIENTS_PER_TICK,
      );

      const afterTick1 = await readManifestStatuses(broadcastIdRaw);
      expect(afterTick1.filter((r) => r.status === 'pending')).toHaveLength(1);

      // ── Tick 2 ─────────────────────────────────────────────────────────
      const gw2 = makeRecordingGateway();
      const pending2 = await batchManifests.findPendingByBroadcast(
        tenantCtx.slug,
        broadcastId,
      );
      // The deferred batch is still claimable — it was left untouched, not
      // half-dispatched, so the next tick starts it from index 0 of its OWN
      // range rather than resuming a partial push.
      expect(pending2).toHaveLength(1);
      expect(pending2[0]!.batchIndex).toBe(2);

      const tick2 = await dispatchAllPendingBatches(
        {
          batchManifests,
          gateway: gw2.port,
          advisoryLock: { async acquire() { return { acquired: true }; } },
          audit: f7AuditAdapter,
          clock: systemClock,
        } as never,
        {
          tenantId: tenantCtx,
          broadcastContent,
          allRecipients,
          pendingBatches: pending2,
          concurrencyCap: 2,
        },
      );

      expect(tick2.succeeded).toBe(1);
      expect(tick2.deferredToNextTick).toBe(0);
      expect(gw2.createdAudiences).toHaveLength(1);
      // 200, not 500: the last batch is the remainder, and sending it at full
      // size would push 300 addresses that belong to no batch.
      expect(gw2.contactBatchSizes).toEqual([200]);

      const afterTick2 = await readManifestStatuses(broadcastIdRaw);
      expect(afterTick2.filter((r) => r.status === 'pending')).toHaveLength(0);
      // Three audiences over two ticks — every batch pushed exactly once. A
      // manifest re-dispatched after deferral would show a fourth.
      expect(
        gw1.createdAudiences.length + gw2.createdAudiences.length,
      ).toBe(3);
      expect(
        gw1.contactBatchSizes.reduce((a, b) => a + b, 0) +
          gw2.contactBatchSizes.reduce((a, b) => a + b, 0),
      ).toBe(RECIPIENT_COUNT);
    }, 60_000);

    /**
     * T147 (Phase 9b) — the hand-off WRITE, against a real `approved` row.
     *
     * `dispatch-scheduled` corrects `estimated_recipient_count` when the
     * audience outgrew one tick since submit, so the next
     * `split-large-broadcasts` claim sees a number that is true. Everything
     * else about that path is covered by unit tests with a stub repo — this is
     * the one part a stub cannot answer, because the question is whether
     * Postgres accepts the UPDATE at all.
     *
     * The specific worry: `broadcasts_immutable_after_submit_fn` locks the row
     * after submit. Reading migration `0224` says the non-GUC branch is a
     * BLOCKLIST of `subject / body_html / body_source / segment_type /
     * segment_params / custom_recipient_emails / scheduled_for`, and
     * `estimated_recipient_count` is not among them — so the write should pass.
     * "Should" is what this test replaces: a trigger, a CHECK, or the adapter's
     * own `assertTenantBoundTx` + rowcount assertion could each refuse, and all
     * three are invisible to a stub. If any of them did, every hand-off would
     * throw and the row would strand exactly as it did before T147 — the
     * failure the whole task exists to prevent, reintroduced silently.
     */
    it('the estimate write-back succeeds on an approved row — the post-submit immutability trigger permits it', async () => {
      const tenantCtx = asTenantContext(TEST_TENANT);
      const broadcastIdRaw = randomUUID();
      TEST_BROADCAST_IDS.push(broadcastIdRaw);
      const broadcastId = asBroadcastId(broadcastIdRaw);

      await runInTenant(tenantCtx, async (tx) => {
        await tx.execute(sql`
          INSERT INTO broadcasts (
            tenant_id, broadcast_id, status, requested_by_member_id,
            requested_by_member_plan_id_snapshot, submitted_by_user_id,
            actor_role, subject, body_html, body_source, from_name,
            reply_to_email, segment_type, segment_params,
            custom_recipient_emails, estimated_recipient_count,
            submitted_at, approved_at
          ) VALUES (
            ${TEST_TENANT}, ${broadcastIdRaw}::uuid, 'approved',
            ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
            'admin_proxy', 'T147 hand-off host', '<p>x</p>', '<p>x</p>',
            'T147 Test', 'noreply@swecham.example', 'all_members', NULL,
            NULL, 400, now(), now()
          )
        `);
      });

      const broadcastsRepo = makeDrizzleBroadcastsRepo(TEST_TENANT);
      await broadcastsRepo.withTx(async (tx) => {
        await broadcastsRepo.updateEstimatedRecipientCount(
          tx,
          tenantCtx.slug,
          broadcastId,
          600,
        );
      });

      const rows = (await runInTenant(tenantCtx, async (tx) =>
        tx.execute(sql`
          SELECT estimated_recipient_count, status::text AS status,
                 approved_at IS NOT NULL AS still_approved
          FROM broadcasts
          WHERE tenant_id = ${TEST_TENANT} AND broadcast_id = ${broadcastIdRaw}::uuid
        `),
      )) as unknown as Array<{
        estimated_recipient_count: number;
        status: string;
        still_approved: boolean;
      }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]!.estimated_recipient_count).toBe(600);
      // The row must still be claimable by `split-large-broadcasts` — a status
      // change here would route it nowhere, and re-stamping the approval is why
      // this is a narrow single-column writer rather than `applyTransition`.
      expect(rows[0]!.status).toBe('approved');
      expect(rows[0]!.still_approved).toBe(true);
    }, 30_000);
  },
);
