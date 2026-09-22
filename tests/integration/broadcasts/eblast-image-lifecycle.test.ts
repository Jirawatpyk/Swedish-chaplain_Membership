/**
 * F119 review findings F2-1 / F2-10 — the image row/blob lifecycle, end to end
 * on live Neon through the REAL Drizzle repository, the real RLS context and
 * the real `broadcast_images` CHECKs.
 *
 * The unit tests pin the decisions against fakes. This one pins the parts a
 * fake cannot: that `markDeletedByOwner` actually stamps under RLS, that the
 * orphan anti-join finds a row whose owner was hard-deleted, that the
 * advisory lock and the `body_html` reference `EXISTS` are valid SQL against
 * the deployed schema, and that a full upload → discard → sweep round trip
 * really removes the row and really calls `storage.delete`.
 *
 * Storage and the virus scanner are fakes on purpose: the finding is about the
 * DATABASE reachability of the image record, and pointing this at real Vercel
 * Blob would leave test objects in a production bucket. The re-encoder is
 * REAL — it is the F2-3 control and it must not be mocked out of the one test
 * that exercises the whole pipeline.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db, runInTenant } from '@/lib/db';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import { reclaimOrphanedImages } from '@/modules/broadcasts/application/use-cases/reclaim-orphaned-images';
import { markOwnerImagesRemoved } from '@/modules/broadcasts/application/use-cases/_mark-owner-images-removed';
import { drizzleBroadcastImagesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-broadcast-images-repo';
import { sharpImageReencoder } from '@/modules/broadcasts/infrastructure/sharp-image-reencoder';
import { f7AuditAdapter } from '@/modules/broadcasts/infrastructure/audit-adapter';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import type { ImageStoragePort } from '@/modules/broadcasts/application/ports/image-storage-port';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const HOST = 'assets.swecham.zyncdata.app';

function makeStorage(): ImageStoragePort & { readonly deleted: string[] } {
  const stored = new Map<string, { blobUrl: string; blobKey: string }>();
  const deleted: string[] = [];
  return {
    deleted,
    existsByContentHash: vi.fn(async (tenantId: never, hash: string) =>
      stored.get(`${tenantId as unknown as string}:${hash}`) ?? null,
    ),
    put: vi.fn(async (input: Parameters<ImageStoragePort['put']>[0]) => {
      const blobKey = `broadcasts/images/${input.tenantId as unknown as string}/${input.contentHash}.png`;
      const ref = { blobUrl: `https://${HOST}/${blobKey}`, blobKey };
      stored.set(`${input.tenantId as unknown as string}:${input.contentHash}`, ref);
      return { ...ref, contentHash: input.contentHash };
    }),
    delete: vi.fn(async (blobKey: string) => {
      deleted.push(blobKey);
    }),
  } as never;
}

/** A real PNG carrying EXIF, so the pipeline's re-encode step does real work. */
async function pngWithExif(seed: number): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: seed, g: 7, b: 11 } },
  })
    .withExif({ IFD0: { Copyright: `lifecycle-${seed}` } })
    .png()
    .toBuffer();
}

async function seedDraft(tenant: TestTenant, broadcastId: string, memberId: string, bodyHtml: string): Promise<void> {
  await runInTenant(tenant.ctx, (tx) =>
    tx.execute(sql`
      INSERT INTO broadcasts (
        tenant_id, broadcast_id, requested_by_member_id,
        requested_by_member_plan_id_snapshot, submitted_by_user_id,
        actor_role, subject, body_html, body_source, from_name,
        reply_to_email, segment_type, segment_params,
        custom_recipient_emails, estimated_recipient_count, status,
        retention_years, created_at, updated_at
      ) VALUES (
        ${tenant.ctx.slug}, ${broadcastId}::uuid, ${memberId}::uuid,
        ${'plan-test'}, ${randomUUID()}::uuid,
        ${'member_self_service'}, ${'Lifecycle subject'}, ${bodyHtml}, ${'plain'},
        ${'Test Member via Test Chamber'}, ${'reply@example.com'},
        ${'all_members'}, NULL, NULL, ${0}, ${'draft'}::broadcast_status,
        ${5}, now(), now()
      )
    `),
  );
}

async function countImages(tenant: TestTenant, ownerId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM broadcast_images
     WHERE tenant_id = ${tenant.ctx.slug} AND owner_id = ${ownerId}::uuid
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function imageAudits(tenant: TestTenant, requestId: string): Promise<Array<Record<string, unknown>>> {
  const rows = (await db.execute(sql`
    SELECT payload FROM audit_log
     WHERE tenant_id = ${tenant.ctx.slug}
       AND event_type = 'broadcast_image_removed'
       AND request_id = ${requestId}
  `)) as unknown as Array<{ payload: Record<string, unknown> }>;
  return rows.map((r) => r.payload);
}

describe('F119 F2-1/F2-10 — inline image lifecycle (live Neon)', () => {
  let tenant: TestTenant;
  const actorUserId = randomUUID();
  const memberId = randomUUID();

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  function deps(storage: ImageStoragePort) {
    return {
      allowlistPort: makeDrizzleImageAllowlistRepo(),
      scanner: { scan: vi.fn(async () => ({ verdict: 'clean' as const, durationMs: 1 })) },
      storage,
      audit: f7AuditAdapter,
      imagesRepo: drizzleBroadcastImagesRepo,
      reencoder: sharpImageReencoder,
    } as never;
  }

  it(
    'upload → discard → sweep: the row is gone, the blob is deleted, and both audit rows exist',
    async () => {
      const storage = makeStorage();
      const broadcastId = randomUUID();
      await seedDraft(tenant, broadcastId, memberId, '<p>no image reference here</p>');

      const uploaded = await uploadInlineImage(deps(storage), {
        tenantId: tenant.ctx.slug as never,
        actorUserId,
        actorEmail: 'member@example.test',
        owner: { kind: 'broadcast', id: broadcastId },
        actor: { role: 'member', memberId },
        requestId: 'lifecycle-upload',
        fileBytes: await pngWithExif(31),
        filename: 'photo.png',
        mimeType: 'image/png',
      });
      expect(uploaded.ok).toBe(true);
      if (!uploaded.ok) return;
      expect(await countImages(tenant, broadcastId)).toBe(1);

      // The discard: the hard DELETE and the stamp in ONE transaction, exactly
      // as `DELETE /api/broadcasts/draft/[id]` does it.
      const discardRequestId = `lifecycle-discard-${randomUUID().slice(0, 8)}`;
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.execute(sql`
          DELETE FROM broadcasts
           WHERE tenant_id = ${tenant.ctx.slug}
             AND broadcast_id = ${broadcastId}::uuid
             AND status = 'draft'
        `);
        await markOwnerImagesRemoved(
          { imagesRepo: drizzleBroadcastImagesRepo, audit: f7AuditAdapter },
          {
            tenantId: tenant.ctx.slug as never,
            owner: { kind: 'broadcast', id: broadcastId },
            reason: 'draft_discarded',
            at: new Date(),
            requestId: discardRequestId,
            actorUserId,
            actorRole: 'member',
            relatedMemberId: memberId,
          },
          tx,
        );
      });

      const discardAudits = await imageAudits(tenant, discardRequestId);
      expect(discardAudits).toHaveLength(1);
      expect(discardAudits[0]).toMatchObject({
        reason: 'draft_discarded',
        blob_deleted: false,
        related_member_id: memberId,
        actor_role: 'member',
      });
      // Stamped, not yet removed — the bytes are the sweep's job.
      expect(await countImages(tenant, broadcastId)).toBe(1);

      const sweepRequestId = `lifecycle-sweep-${randomUUID().slice(0, 8)}`;
      const swept = await reclaimOrphanedImages(
        { imagesRepo: drizzleBroadcastImagesRepo, storage, audit: f7AuditAdapter },
        { tenantId: tenant.ctx.slug as never, now: new Date(), requestId: sweepRequestId },
      );
      expect(swept.ok).toBe(true);
      expect(storage.deleted).toEqual([uploaded.value.blobUrl.split(`${HOST}/`)[1]]);
      expect(await countImages(tenant, broadcastId)).toBe(0);
      const sweepAudits = await imageAudits(tenant, sweepRequestId);
      expect(sweepAudits.some((p) => p['reason'] === 'sweep' && p['blob_deleted'] === true)).toBe(true);
    },
    180_000,
  );

  it(
    'F2-10(b): a blob still embedded in live body_html keeps its BYTES; only the row goes',
    async () => {
      const storage = makeStorage();
      const ownerId = randomUUID();
      const stillLiveId = randomUUID();
      await seedDraft(tenant, ownerId, memberId, '<p>owner</p>');

      const uploaded = await uploadInlineImage(deps(storage), {
        tenantId: tenant.ctx.slug as never,
        actorUserId,
        actorEmail: 'member@example.test',
        owner: { kind: 'broadcast', id: ownerId },
        actor: { role: 'member', memberId },
        requestId: 'ref-upload',
        fileBytes: await pngWithExif(77),
        filename: 'shared.png',
        mimeType: 'image/png',
      });
      expect(uploaded.ok).toBe(true);
      if (!uploaded.ok) return;

      // A SECOND broadcast embeds the same URL in its body but has NO image row
      // — exactly the pre-0304 shape the table was never backfilled for.
      await seedDraft(tenant, stillLiveId, memberId, `<p><img src="${uploaded.value.blobUrl}"></p>`);

      await runInTenant(tenant.ctx, (tx) =>
        markOwnerImagesRemoved(
          { imagesRepo: drizzleBroadcastImagesRepo, audit: f7AuditAdapter },
          {
            tenantId: tenant.ctx.slug as never,
            owner: { kind: 'broadcast', id: ownerId },
            reason: 'draft_discarded',
            at: new Date(),
            requestId: 'ref-stamp',
            actorUserId,
            actorRole: 'member',
            relatedMemberId: memberId,
          },
          tx,
        ),
      );

      const sweepRequestId = `ref-sweep-${randomUUID().slice(0, 8)}`;
      await reclaimOrphanedImages(
        { imagesRepo: drizzleBroadcastImagesRepo, storage, audit: f7AuditAdapter },
        { tenantId: tenant.ctx.slug as never, now: new Date(), requestId: sweepRequestId },
      );

      expect(storage.deleted).toEqual([]);
      expect(await countImages(tenant, ownerId)).toBe(0);
      const audits = await imageAudits(tenant, sweepRequestId);
      expect(audits.some((p) => p['reason'] === 'sweep_referenced' && p['blob_deleted'] === false)).toBe(true);
    },
    180_000,
  );

  it(
    'F2-2: the erasure cascade stamps the ERASED member\'s images and leaves a peer member\'s alone',
    async () => {
      const storage = makeStorage();
      const erasedMember = randomUUID();
      const peerMember = randomUUID();
      const erasedBroadcast = randomUUID();
      const peerBroadcast = randomUUID();
      await seedDraft(tenant, erasedBroadcast, erasedMember, '<p>mine</p>');
      await seedDraft(tenant, peerBroadcast, peerMember, '<p>theirs</p>');

      for (const [owner, member, seed] of [
        [erasedBroadcast, erasedMember, 41],
        [peerBroadcast, peerMember, 42],
      ] as const) {
        const up = await uploadInlineImage(deps(storage), {
          tenantId: tenant.ctx.slug as never,
          actorUserId,
          actorEmail: 'member@example.test',
          owner: { kind: 'broadcast', id: owner },
          actor: { role: 'member', memberId: member },
          requestId: 'erase-upload',
          fileBytes: await pngWithExif(seed),
          filename: 'own.png',
          mimeType: 'image/png',
        });
        expect(up.ok).toBe(true);
      }

      // The join predicate is the whole point: a wrong one returns 0 rows and a
      // count-only assertion would pass for the wrong reason. So assert BOTH
      // that the erased member's row was stamped AND that the peer's was not.
      const stamped = await runInTenant(tenant.ctx, (tx) =>
        drizzleBroadcastImagesRepo.markDeletedForMember(
          tenant.ctx.slug as never,
          erasedMember,
          new Date(),
          tx,
        ),
      );
      expect(stamped).toHaveLength(1);
      expect(stamped[0]!.ownerId).toBe(erasedBroadcast);

      const rows = (await db.execute(sql`
        SELECT owner_id::text AS owner_id, (deleted_at IS NOT NULL) AS marked
          FROM broadcast_images
         WHERE tenant_id = ${tenant.ctx.slug}
           AND owner_id IN (${erasedBroadcast}::uuid, ${peerBroadcast}::uuid)
      `)) as unknown as Array<{ owner_id: string; marked: boolean }>;
      expect(rows.find((r) => r.owner_id === erasedBroadcast)!.marked).toBe(true);
      expect(rows.find((r) => r.owner_id === peerBroadcast)!.marked).toBe(false);
    },
    180_000,
  );

  it(
    'F2-1 orphan arm: a live row whose owner was hard-deleted WITHOUT a stamp is still reaped',
    async () => {
      const storage = makeStorage();
      const ownerId = randomUUID();
      await seedDraft(tenant, ownerId, memberId, '<p>about to vanish</p>');

      const uploaded = await uploadInlineImage(deps(storage), {
        tenantId: tenant.ctx.slug as never,
        actorUserId,
        actorEmail: 'member@example.test',
        owner: { kind: 'broadcast', id: ownerId },
        actor: { role: 'member', memberId },
        requestId: 'orphan-upload',
        fileBytes: await pngWithExif(123),
        filename: 'orphan.png',
        mimeType: 'image/png',
      });
      expect(uploaded.ok).toBe(true);
      if (!uploaded.ok) return;

      // Simulate a FUTURE hard-delete path that forgets to stamp — the exact
      // class the orphan arm exists to stop from becoming permanent.
      await runInTenant(tenant.ctx, (tx) =>
        tx.execute(sql`
          DELETE FROM broadcasts
           WHERE tenant_id = ${tenant.ctx.slug} AND broadcast_id = ${ownerId}::uuid
        `),
      );
      expect(await countImages(tenant, ownerId)).toBe(1);

      const sweepRequestId = `orphan-sweep-${randomUUID().slice(0, 8)}`;
      const swept = await reclaimOrphanedImages(
        { imagesRepo: drizzleBroadcastImagesRepo, storage, audit: f7AuditAdapter },
        { tenantId: tenant.ctx.slug as never, now: new Date(), requestId: sweepRequestId },
      );
      expect(swept.ok).toBe(true);
      expect(await countImages(tenant, ownerId)).toBe(0);
      // The sweep is tenant-wide and the cases above leave marked rows behind,
      // so assert on THIS blob rather than on the batch size — a count here
      // would be testing test ordering, not the orphan arm.
      expect(storage.deleted).toContain(uploaded.value.blobUrl.split(`${HOST}/`)[1]);
      const audits = await imageAudits(tenant, sweepRequestId);
      expect(audits.some((p) => p['reason'] === 'sweep_orphaned' && p['blob_deleted'] === true)).toBe(true);
    },
    180_000,
  );
});
