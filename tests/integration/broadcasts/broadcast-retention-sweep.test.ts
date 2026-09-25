/**
 * F7 retention sweep (migration 0310) — `sweepExpiredBroadcasts` end to end on
 * live Neon, through the REAL Drizzle repository, the real RLS context, the
 * real triggers and the real FK cascades.
 *
 * What only the database can prove, and so what this file pins:
 *
 *   - the eligibility rule: terminal status, anchor + the row's own
 *     `retention_years` in the past, no live Resend audience. Each rejected
 *     arm has its own surviving row, and each fallback arm its own swept row;
 *   - the anchor is the status column (falling back to `stage_entered_at`),
 *     never `updated_at` — one row is fresh by its anchor but 6 years old by
 *     `updated_at`, and it stays;
 *   - the children leave by CASCADE only: deliveries (0310's FK + trigger
 *     arm), versions + decisions (0308), batch manifests + their delivery
 *     events (0163/0218). The swept row also carries an `approved_version_id`
 *     pointing at its own version — 0308's ON DELETE NO ACTION FK, whose
 *     end-of-statement check nothing else exercises;
 *   - `chamber_app` still cannot DELETE a delivery or a decision directly (no
 *     grant), and a direct DELETE by the owner still hits the append-only
 *     trigger at depth 1;
 *   - the swept row's images are stamped (so the daily image sweep reclaims
 *     the bytes) and audited as `retention_expired`, and one counts-only
 *     `broadcast_retention_swept` row lands;
 *   - another tenant's expired row is untouched (Principle I).
 *
 * Needs migration 0310 applied to the target branch.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, runInTenant } from '@/lib/db';
import { errorChainMessage } from '@/lib/db-errors';
import { makeSweepExpiredBroadcastsDeps, sweepExpiredBroadcasts } from '@/modules/broadcasts';
import {
  broadcastDeliveries,
  broadcastImages,
  broadcastMemberDecisions,
  broadcasts,
  broadcastVersions,
  type NewBroadcastRow,
} from '@/modules/broadcasts/infrastructure/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const NOW = new Date();
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const yearsAgo = (n: number): Date => new Date(NOW.getTime() - n * YEAR_MS);
const SIX_YEARS_AGO = yearsAgo(6);
const ONE_YEAR_AGO = yearsAgo(1);

type Tx = Parameters<Parameters<typeof runInTenant>[1]>[0];

function row(tenant: TestTenant, over: Partial<NewBroadcastRow>): NewBroadcastRow {
  const status = over.status ?? 'sent';
  return {
    tenantId: tenant.ctx.slug,
    broadcastId: randomUUID(),
    requestedByMemberId: randomUUID(),
    requestedByMemberPlanIdSnapshot: 'plan-retention',
    submittedByUserId: randomUUID(),
    actorRole: 'member_self_service',
    subject: `Retention ${status}`,
    bodyHtml: '<p>retention</p>',
    bodySource: 'retention',
    fromName: 'Chamber',
    replyToEmail: 'reply@example.com',
    segmentType: 'all_members',
    estimatedRecipientCount: 2,
    retentionYears: 5,
    submittedAt: SIX_YEARS_AGO,
    stageEnteredAt: SIX_YEARS_AGO,
    ...(status === 'sent' ? { quotaYearConsumed: SIX_YEARS_AGO.getUTCFullYear(), quotaConsumedAt: SIX_YEARS_AGO } : {}),
    ...over,
    status,
  };
}

async function insertRow(tenant: TestTenant, values: NewBroadcastRow): Promise<string> {
  await runInTenant(tenant.ctx, (tx) => tx.insert(broadcasts).values(values));
  return values.broadcastId!;
}

async function insertDelivery(tx: Tx, tenant: TestTenant, broadcastId: string): Promise<void> {
  await tx.insert(broadcastDeliveries).values({
    tenantId: tenant.ctx.slug,
    deliveryId: randomUUID(),
    broadcastId,
    resendEventId: `evt-retention-${randomUUID()}`,
    resendMessageId: `msg-retention-${randomUUID()}`,
    recipientEmailLower: `retention-${randomUUID().slice(0, 8)}@example.com`,
    status: 'delivered',
    eventTimestamp: SIX_YEARS_AGO,
  });
}

/** A sent version, a decision on it, and the E-Blast pointing at the version as its approval. */
async function insertVersionAndDecision(tx: Tx, tenant: TestTenant, broadcastId: string): Promise<void> {
  const versionId = randomUUID();
  await tx.insert(broadcastVersions).values({
    tenantId: tenant.ctx.slug,
    id: versionId,
    broadcastId,
    versionNo: 1,
    subject: 'v1',
    bodyHtml: '<p>v1</p>',
    bodySource: 'v1',
    authoredByUserId: randomUUID(),
    authoredByRole: 'admin_proxy',
    sentToMemberAt: SIX_YEARS_AGO,
  });
  await tx.insert(broadcastMemberDecisions).values({
    tenantId: tenant.ctx.slug,
    id: randomUUID(),
    broadcastId,
    versionId,
    round: 1,
    decision: 'changes_requested',
    reason: 'please shorten the subject',
    decidedByUserId: randomUUID(),
    decidedByContactId: randomUUID(),
  });
  // Not a content, audience or schedule column, and no status change, so the
  // immutability trigger admits it on a closed row.
  await tx
    .update(broadcasts)
    .set({ approvedVersionId: versionId })
    .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), eq(broadcasts.broadcastId, broadcastId)));
}

async function insertManifestWithEvent(tx: Tx, tenant: TestTenant, broadcastId: string): Promise<void> {
  const rows = (await tx.execute(sql`
    INSERT INTO broadcast_batch_manifests (
      tenant_id, broadcast_id, batch_index, recipient_count,
      recipient_range_start, recipient_range_end, idempotency_key, status
    ) VALUES (
      ${tenant.ctx.slug}, ${broadcastId}::uuid, 0, 2, 0, 1,
      ${`broadcast-${broadcastId}-batch-0-attempt-0`}, 'pending'
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  await tx.execute(sql`
    INSERT INTO broadcast_batch_delivery_events (tenant_id, resend_event_id, batch_manifest_id, counter_field)
    VALUES (${tenant.ctx.slug}, ${`evt-batch-${randomUUID()}`}, ${rows[0]!.id}::uuid, 'delivered_count')
  `);
}

async function insertImage(tx: Tx, tenant: TestTenant, ownerId: string): Promise<string> {
  const id = randomUUID();
  const hash = randomUUID().replace(/-/g, '');
  await tx.insert(broadcastImages).values({
    tenantId: tenant.ctx.slug,
    id,
    ownerKind: 'broadcast',
    ownerId,
    contentHash: hash,
    blobUrl: `https://assets.example/broadcasts/images/${hash}.png`,
    blobKey: `broadcasts/images/${hash}.png`,
    mimeType: 'image/png',
    byteSize: 10,
    uploadedByUserId: randomUUID(),
  });
  return id;
}

/** Child-row counts for one E-Blast, read as the owner (RLS bypassed) so nothing is hidden. */
async function childCounts(tenant: TestTenant, broadcastId: string): Promise<Record<string, number>> {
  const rows = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM broadcast_deliveries
        WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}::uuid) AS deliveries,
      (SELECT count(*)::int FROM broadcast_versions
        WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}::uuid) AS versions,
      (SELECT count(*)::int FROM broadcast_member_decisions
        WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}::uuid) AS decisions,
      (SELECT count(*)::int FROM broadcast_batch_manifests
        WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${broadcastId}::uuid) AS manifests,
      (SELECT count(*)::int FROM broadcast_batch_delivery_events e
         JOIN broadcast_batch_manifests m ON m.id = e.batch_manifest_id
        WHERE m.tenant_id = ${tenant.ctx.slug} AND m.broadcast_id = ${broadcastId}::uuid) AS batch_events
  `)) as unknown as Array<Record<string, number>>;
  return rows[0]!;
}

async function surviving(tenant: TestTenant, ids: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: broadcasts.broadcastId })
    .from(broadcasts)
    .where(and(eq(broadcasts.tenantId, tenant.ctx.slug), inArray(broadcasts.broadcastId, [...ids])));
  return rows.map((r) => r.id).sort();
}

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return errorChainMessage(e);
  }
  return 'no error';
}

describe('F7 retention sweep (0310) — live Neon', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const tenants = await createTwoTestTenants();
    tenantA = tenants.a;
    tenantB = tenants.b;
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      // `broadcast_images` is not in the shared tenant cleanup.
      await db.delete(broadcastImages).where(eq(broadcastImages.tenantId, t.ctx.slug)).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it(
    'deletes exactly the expired closed rows, with every child by cascade, stamps their images, and leaves everything else',
    async () => {
      // ── Swept ────────────────────────────────────────────────────────────
      const oldSent = await insertRow(tenantA, row(tenantA, { status: 'sent', sentAt: SIX_YEARS_AGO }));
      // Fallback: own column NULL → stage_entered_at (6 y).
      const oldCancelledNoColumn = await insertRow(tenantA, row(tenantA, { status: 'cancelled', cancelledAt: null }));
      // The day-30 close has no column of its own.
      const oldExpired = await insertRow(tenantA, row(tenantA, { status: 'expired_no_member_response' }));
      // Its audience was reaped already → no longer blocks.
      const oldSentAudienceReaped = await insertRow(
        tenantA,
        row(tenantA, { sentAt: SIX_YEARS_AGO, resendAudienceId: `aud-reaped-${randomUUID()}`, audienceDeletedAt: yearsAgo(5.9) }),
      );

      // ── Kept ─────────────────────────────────────────────────────────────
      // Fresh by its anchor, although `updated_at` is 6 years old.
      const freshSent = await insertRow(
        tenantA,
        row(tenantA, { sentAt: ONE_YEAR_AGO, stageEnteredAt: ONE_YEAR_AGO, updatedAt: SIX_YEARS_AGO }),
      );
      // Own column (1 y) wins over an old stage_entered_at (6 y).
      const cancelledRecently = await insertRow(tenantA, row(tenantA, { status: 'cancelled', cancelledAt: ONE_YEAR_AGO }));
      // 10-year retention: 6 years is not enough.
      const tenYearRow = await insertRow(tenantA, row(tenantA, { sentAt: SIX_YEARS_AGO, retentionYears: 10 }));
      // Live Resend audience: cleanup-audiences must reap it first.
      const liveAudience = await insertRow(
        tenantA,
        row(tenantA, { sentAt: SIX_YEARS_AGO, resendAudienceId: `aud-live-${randomUUID()}`, audienceDeletedAt: null }),
      );
      // Not terminal: still somebody's work, however old.
      const oldApproved = await insertRow(tenantA, row(tenantA, { status: 'approved', approvedAt: SIX_YEARS_AGO }));
      // Another tenant's expired row.
      const otherTenantOld = await insertRow(tenantB, row(tenantB, { sentAt: SIX_YEARS_AGO }));

      let oldImage = '';
      let freshImage = '';
      await runInTenant(tenantA.ctx, async (tx) => {
        await insertDelivery(tx, tenantA, oldSent);
        await insertDelivery(tx, tenantA, oldSent);
        await insertVersionAndDecision(tx, tenantA, oldSent);
        await insertManifestWithEvent(tx, tenantA, oldSent);
        oldImage = await insertImage(tx, tenantA, oldSent);
        await insertDelivery(tx, tenantA, freshSent);
        freshImage = await insertImage(tx, tenantA, freshSent);
      });
      await runInTenant(tenantB.ctx, (tx) => insertDelivery(tx, tenantB, otherTenantOld));

      expect(await childCounts(tenantA, oldSent)).toEqual({
        deliveries: 2,
        versions: 1,
        decisions: 1,
        manifests: 1,
        batch_events: 1,
      });

      const requestId = `retention-it-${randomUUID()}`;
      const result = await sweepExpiredBroadcasts({
        ...makeSweepExpiredBroadcastsDeps(tenantA.ctx.slug, requestId),
        clock: { now: () => NOW },
      });

      expect(result).toEqual({
        ok: true,
        value: { sweptCount: 4, imagesMarked: 1, batches: 1, budgetExhausted: false },
      });

      const swept = [oldSent, oldCancelledNoColumn, oldExpired, oldSentAudienceReaped];
      const kept = [freshSent, cancelledRecently, tenYearRow, liveAudience, oldApproved];
      expect(await surviving(tenantA, swept)).toEqual([]);
      expect(await surviving(tenantA, kept)).toEqual([...kept].sort());

      // Every child went with its parent, by cascade.
      expect(await childCounts(tenantA, oldSent)).toEqual({
        deliveries: 0,
        versions: 0,
        decisions: 0,
        manifests: 0,
        batch_events: 0,
      });
      // A kept row keeps its children.
      expect((await childCounts(tenantA, freshSent)).deliveries).toBe(1);

      // Another tenant's expired row and its delivery are untouched.
      expect(await surviving(tenantB, [otherTenantOld])).toEqual([otherTenantOld]);
      expect((await childCounts(tenantB, otherTenantOld)).deliveries).toBe(1);

      // The swept row's image is stamped for the daily image sweep; the kept row's is not.
      const images = await db
        .select({ id: broadcastImages.id, deletedAt: broadcastImages.deletedAt })
        .from(broadcastImages)
        .where(and(eq(broadcastImages.tenantId, tenantA.ctx.slug), inArray(broadcastImages.id, [oldImage, freshImage])));
      const deletedAtOf = new Map(images.map((i) => [i.id, i.deletedAt]));
      expect(deletedAtOf.get(oldImage)).toBeInstanceOf(Date);
      expect(deletedAtOf.get(freshImage)).toBeNull();

      // Audit: one retention_expired row per stamped image, and ONE counts-only run row.
      const audits = (await db.execute(sql`
        SELECT event_type, payload FROM audit_log
         WHERE tenant_id = ${tenantA.ctx.slug} AND request_id = ${requestId}
      `)) as unknown as Array<{ event_type: string; payload: Record<string, unknown> }>;
      const imageRemoved = audits.filter((a) => a.event_type === 'broadcast_image_removed');
      expect(imageRemoved.map((a) => [a.payload['image_id'], a.payload['reason']])).toEqual([
        [oldImage, 'retention_expired'],
      ]);
      const runRows = audits.filter((a) => a.event_type === 'broadcast_retention_swept');
      expect(runRows.map((a) => a.payload)).toEqual([
        {
          swept_count: 4,
          images_marked: 1,
          batches: 1,
          budget_exhausted: false,
          completed: true,
          actor_role: 'system',
        },
      ]);
    },
    120_000,
  );

  it('chamber_app still cannot DELETE a delivery or a decision directly, and the owner still hits the depth-1 trigger', async () => {
    const id = await insertRow(tenantA, row(tenantA, { sentAt: ONE_YEAR_AGO, stageEnteredAt: ONE_YEAR_AGO }));
    await runInTenant(tenantA.ctx, async (tx) => {
      await insertDelivery(tx, tenantA, id);
      await insertVersionAndDecision(tx, tenantA, id);
    });

    // Each probe in its own transaction: a refused statement poisons its tx.
    const appDeliveries = await refusal(() =>
      runInTenant(tenantA.ctx, (tx) =>
        tx.delete(broadcastDeliveries).where(
          and(eq(broadcastDeliveries.tenantId, tenantA.ctx.slug), eq(broadcastDeliveries.broadcastId, id)),
        ),
      ),
    );
    expect(appDeliveries).toContain('permission denied');

    const appDecisions = await refusal(() =>
      runInTenant(tenantA.ctx, (tx) =>
        tx.delete(broadcastMemberDecisions).where(
          and(eq(broadcastMemberDecisions.tenantId, tenantA.ctx.slug), eq(broadcastMemberDecisions.broadcastId, id)),
        ),
      ),
    );
    expect(appDecisions).toContain('permission denied');

    // The owner has the privilege, so the trigger is what answers: depth 1.
    const ownerDeliveries = await refusal(() =>
      db
        .delete(broadcastDeliveries)
        .where(and(eq(broadcastDeliveries.tenantId, tenantA.ctx.slug), eq(broadcastDeliveries.broadcastId, id))),
    );
    expect(ownerDeliveries).toContain('broadcast_deliveries_append_only');

    expect(await childCounts(tenantA, id)).toMatchObject({ deliveries: 1, decisions: 1 });
  });

  it('a second run with nothing left to sweep deletes nothing and still writes its run row', async () => {
    const requestId = `retention-it-empty-${randomUUID()}`;
    const result = await sweepExpiredBroadcasts({
      ...makeSweepExpiredBroadcastsDeps(tenantA.ctx.slug, requestId),
      clock: { now: () => NOW },
    });
    expect(result).toEqual({
      ok: true,
      value: { sweptCount: 0, imagesMarked: 0, batches: 1, budgetExhausted: false },
    });
    const runRows = (await db.execute(sql`
      SELECT payload FROM audit_log
       WHERE tenant_id = ${tenantA.ctx.slug} AND request_id = ${requestId}
         AND event_type = 'broadcast_retention_swept'
    `)) as unknown as Array<{ payload: Record<string, unknown> }>;
    expect(runRows).toHaveLength(1);
    expect(runRows[0]!.payload).toMatchObject({ swept_count: 0, completed: true });
  });
});
