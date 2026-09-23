/**
 * F119 T033 — Drizzle adapter for `BroadcastImagesRepo` (migration 0304).
 *
 * Every query runs on the caller's tenant `tx` (`withTenantTxOrOpen`) —
 * never the pool-global `db`, which would bypass RLS + FORCE silently (the
 * F7.1a US2 rule). Drizzle-inferred row types stay inside this file.
 */
import { and, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { runInTenant, withTenantTxOrOpen, type TenantTx } from '@/lib/db';
import { asTenantContext, type TenantSlug } from '@/modules/tenants';
import type {
  BroadcastImageOwnerKind,
  BroadcastImageRecord,
  BroadcastImagesRepo,
  BroadcastImagesTx,
  NewBroadcastImage,
} from '../../application/ports/broadcast-images-repo';
import type { ImageMimeType } from '../../application/ports/image-storage-port';
import { broadcastImages, type BroadcastImageRow } from '../schema';

function toRecord(row: BroadcastImageRow): BroadcastImageRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerKind: row.ownerKind as BroadcastImageOwnerKind,
    ownerId: row.ownerId,
    contentHash: row.contentHash,
    blobUrl: row.blobUrl,
    blobKey: row.blobKey,
    mimeType: row.mimeType as ImageMimeType,
    byteSize: row.byteSize,
    uploadedByUserId: row.uploadedByUserId,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

export const drizzleBroadcastImagesRepo: BroadcastImagesRepo = {
  async withTx<T>(tenantId: TenantSlug, fn: (tx: BroadcastImagesTx) => Promise<T>): Promise<T> {
    return runInTenant(asTenantContext(tenantId as unknown as string), async (tx) => fn(tx));
  },

  async record(tenantId: TenantSlug, input: NewBroadcastImage, tx: BroadcastImagesTx): Promise<BroadcastImageRecord> {
    const rows = await (tx as TenantTx)
      .insert(broadcastImages)
      .values({
        tenantId: tenantId as string,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        contentHash: input.contentHash,
        blobUrl: input.blobUrl,
        blobKey: input.blobKey,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        uploadedByUserId: input.uploadedByUserId,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('broadcast_images_insert_returned_no_row');
    return toRecord(row);
  },

  async listByOwner(tenantId, owner, tx) {
    return withTenantTxOrOpen(tenantId, tx ?? null, async (inner: TenantTx) => {
      const rows = await inner
        .select()
        .from(broadcastImages)
        .where(
          and(
            eq(broadcastImages.tenantId, tenantId as string),
            eq(broadcastImages.ownerKind, owner.kind),
            eq(broadcastImages.ownerId, owner.id),
            isNull(broadcastImages.deletedAt),
          ),
        )
        .orderBy(desc(broadcastImages.createdAt));
      return rows.map(toRecord);
    });
  },

  async markDeletedByOwner(tenantId, owner, at, tx) {
    const rows = await (tx as TenantTx)
      .update(broadcastImages)
      .set({ deletedAt: at })
      .where(
        and(
          eq(broadcastImages.tenantId, tenantId as string),
          eq(broadcastImages.ownerKind, owner.kind),
          eq(broadcastImages.ownerId, owner.id),
          isNull(broadcastImages.deletedAt),
        ),
      )
      .returning();
    return rows.map(toRecord);
  },

  /**
   * ROUND-2 R-M1 — one bounded `WHERE owner_id = ANY(…)` per prune batch,
   * replacing one UPDATE per pruned draft inside a single long transaction.
   * An empty id list short-circuits: `inArray` with `[]` renders a constant
   * false, but returning early keeps the intent obvious and saves a round-trip.
   */
  async markDeletedByOwners(tenantId, ownerKind, ownerIds, at, tx) {
    if (ownerIds.length === 0) return [];
    const rows = await (tx as TenantTx)
      .update(broadcastImages)
      .set({ deletedAt: at })
      .where(
        and(
          eq(broadcastImages.tenantId, tenantId as string),
          eq(broadcastImages.ownerKind, ownerKind),
          inArray(broadcastImages.ownerId, [...ownerIds]),
          isNull(broadcastImages.deletedAt),
        ),
      )
      .returning();
    return rows.map(toRecord);
  },

  /**
   * F2-2 — the erasure cascade's image reach, as one tenant-scoped UPDATE
   * joined to `broadcasts` by originating member. Only `owner_kind='broadcast'`
   * can match: a template belongs to the chamber, not to a member.
   */
  async markDeletedForMember(tenantId, memberId, at, tx) {
    const rows = (await (tx as TenantTx).execute(sql`
      UPDATE broadcast_images bi
         SET deleted_at = ${at.toISOString()}::timestamptz
       WHERE bi.tenant_id = ${tenantId as string}
         AND bi.owner_kind = 'broadcast'
         AND bi.deleted_at IS NULL
         AND EXISTS (
               SELECT 1 FROM broadcasts b
                WHERE b.tenant_id = ${tenantId as string}
                  AND b.broadcast_id = bi.owner_id
                  AND b.requested_by_member_id = ${memberId}
             )
      RETURNING bi.id, bi.tenant_id, bi.owner_kind, bi.owner_id, bi.content_hash,
                bi.blob_url, bi.blob_key, bi.mime_type, bi.byte_size,
                bi.uploaded_by_user_id, bi.created_at, bi.deleted_at
    `)) as unknown as Array<{
      id: string;
      tenant_id: string;
      owner_kind: string;
      owner_id: string;
      content_hash: string;
      blob_url: string;
      blob_key: string;
      mime_type: string;
      byte_size: number;
      uploaded_by_user_id: string;
      created_at: string | Date;
      deleted_at: string | Date | null;
    }>;
    // Raw `execute` returns the SQL column names, not Drizzle's camelCase
    // inference, so `toRecord` cannot be reused here.
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      ownerKind: r.owner_kind as BroadcastImageOwnerKind,
      ownerId: r.owner_id,
      contentHash: r.content_hash,
      blobUrl: r.blob_url,
      blobKey: r.blob_key,
      mimeType: r.mime_type as ImageMimeType,
      byteSize: Number(r.byte_size),
      uploadedByUserId: r.uploaded_by_user_id,
      createdAt: new Date(r.created_at),
      deletedAt: r.deleted_at === null ? null : new Date(r.deleted_at),
    }));
  },

  /**
   * F119 R17 — the GDPR export's read: the `markDeletedForMember` join as a
   * SELECT, with NO `deleted_at` filter (a stamped row is still the record).
   * Only `owner_kind='broadcast'` can match — a template is the chamber's.
   */
  async listByMember(tenantId, memberId, limit, tx) {
    const rows = await (tx as TenantTx)
      .select()
      .from(broadcastImages)
      .where(
        and(
          eq(broadcastImages.tenantId, tenantId as string),
          eq(broadcastImages.ownerKind, 'broadcast'),
          sql`EXISTS (
            SELECT 1 FROM broadcasts b
             WHERE b.tenant_id = ${tenantId as string}
               AND b.broadcast_id = ${broadcastImages.ownerId}
               AND b.requested_by_member_id = ${memberId}
          )`,
        ),
      )
      .orderBy(desc(broadcastImages.createdAt), desc(broadcastImages.id))
      .limit(limit);
    return rows.map(toRecord);
  },

  async listMarked(tenantId, limit, tx) {
    const rows = await (tx as TenantTx)
      .select()
      .from(broadcastImages)
      .where(and(eq(broadcastImages.tenantId, tenantId as string), isNotNull(broadcastImages.deletedAt)))
      .orderBy(broadcastImages.deletedAt)
      .limit(limit);
    return rows.map(toRecord);
  },

  /**
   * F2-1 — live rows whose owner is gone. Two anti-joins, one per owner_kind,
   * both tenant-scoped (RLS confines the tx, and the explicit `tenant_id`
   * predicate keeps the index usable and the intent readable).
   *
   * A template is SOFT-deleted (`broadcast_templates.deleted_at`), so its
   * images are not orphans while the row survives — a soft-deleted template
   * is still restorable. A broadcast is hard-deleted, which is the case this
   * arm is really for.
   */
  async listOrphaned(tenantId, limit, tx) {
    const inner = tx as TenantTx;
    const rows = await inner
      .select()
      .from(broadcastImages)
      .where(
        and(
          eq(broadcastImages.tenantId, tenantId as string),
          isNull(broadcastImages.deletedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM broadcasts b
             WHERE b.tenant_id = ${tenantId as string}
               AND b.broadcast_id = ${broadcastImages.ownerId}
               AND ${broadcastImages.ownerKind} = 'broadcast'
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM broadcast_templates t
             WHERE t.tenant_id = ${tenantId as string}
               AND t.id = ${broadcastImages.ownerId}
               AND ${broadcastImages.ownerKind} = 'template'
          )`,
        ),
      )
      .orderBy(broadcastImages.createdAt)
      .limit(limit);
    return rows.map(toRecord);
  },

  async countLiveByContentHash(tenantId, contentHash, tx, excludeImageId) {
    const rows = await (tx as TenantTx)
      .select({ n: count() })
      .from(broadcastImages)
      .where(
        and(
          eq(broadcastImages.tenantId, tenantId as string),
          eq(broadcastImages.contentHash, contentHash),
          isNull(broadcastImages.deletedAt),
          ...(excludeImageId === undefined ? [] : [ne(broadcastImages.id, excludeImageId)]),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  },

  /**
   * F2-10(a) — `pg_advisory_xact_lock`, released when `tx` ends.
   * `hashtextextended(…, 0)` gives the bigint the lock API wants (the repo-wide
   * convention — `hashtext` returns int4 and widens, halving the key space); a
   * collision costs a little serialisation between two unrelated hashes, never
   * a correctness loss.
   *
   * ROUND-2 R-H2 — this lock does NOT on its own close the upload's
   * probe→insert window: the dedup probe and the PUT run above it. The upload
   * re-probes storage while holding this lock and re-PUTs only when that probe
   * positively reports the bytes GONE (ROUND-3 #1 — a probe that failed is not
   * a report). See `BroadcastImagesRepo.lockContentHash`.
   */
  async lockContentHash(tenantId, contentHash, tx) {
    await (tx as TenantTx).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`broadcasts-image:${tenantId as string}:${contentHash}`}, 0))`,
    );
  },

  /**
   * F2-10(b) — `EXISTS` over the two places a blob URL can appear in live
   * content. `body_source` is the editor's own JSON and carries the same URL,
   * but `body_html` is what is SENT, so it is the authority; both are checked
   * because a draft whose HTML has not been re-rendered yet still references
   * the image from its source.
   *
   * ROUND-2 R-M2 + S-4 + L-2 — `position(url in body)` replaced three
   * leading-wildcard `LIKE '%' || url || '%'` predicates.
   *
   *   - S-4 (correctness): `%` and `_` are LIKE metacharacters and the URL was
   *     interpolated unescaped, so a blob key containing `_` matched any
   *     character in that position. The sweep could answer "still referenced"
   *     about a DIFFERENT image and keep bytes it should have reclaimed.
   *     `position` has no pattern semantics, so there is nothing to escape.
   *   - R-M2 / L-2 (cost): still a sequential scan of `broadcasts` and
   *     `broadcast_templates` per call, and the sweep calls it once per swept
   *     row. It is not batched across rows because each swept row runs in its
   *     OWN transaction holding its OWN per-content-hash advisory lock — the
   *     isolation that makes one bad blob not block the batch. The scale
   *     follow-up is a pg_trgm GIN index on `broadcasts.body_html` (and the
   *     template body), which `position` can use the same way `LIKE` could;
   *     at SweCham's row counts with a 200-row batch bound it is not yet
   *     worth the write amplification.
   */
  async isBlobReferencedByContent(tenantId, blobUrl, tx) {
    const rows = (await (tx as TenantTx).execute(sql`
      SELECT 1 AS hit
       WHERE EXISTS (
               SELECT 1 FROM broadcasts b
                WHERE b.tenant_id = ${tenantId as string}
                  AND (position(${blobUrl} in b.body_html) > 0
                       OR position(${blobUrl} in b.body_source) > 0)
             )
          OR EXISTS (
               SELECT 1 FROM broadcast_templates t
                WHERE t.tenant_id = ${tenantId as string}
                  AND position(${blobUrl} in t.body_html) > 0
             )
    `)) as unknown as Array<{ hit: number }>;
    return rows.length > 0;
  },

  /**
   * ROUND-2 S-3 — put a swept-but-still-referenced row back in the live set.
   * Idempotent: an already-live row is a 0-row update.
   */
  async restoreLive(tenantId, imageId, tx) {
    await (tx as TenantTx)
      .update(broadcastImages)
      .set({ deletedAt: null })
      .where(
        and(
          eq(broadcastImages.tenantId, tenantId as string),
          eq(broadcastImages.id, imageId),
          isNotNull(broadcastImages.deletedAt),
        ),
      );
  },

  async remove(tenantId, imageId, tx) {
    await (tx as TenantTx)
      .delete(broadcastImages)
      .where(and(eq(broadcastImages.tenantId, tenantId as string), eq(broadcastImages.id, imageId)));
  },

  /**
   * ROUND-3 #4 — `SET LOCAL statement_timeout`, released when `tx` ends.
   *
   * `SET` takes no bind parameters, so the value is interpolated — which is
   * why it is clamped to a sane integer range first. `ms` reaches this method
   * only from the sweep's own constant, but a raw interpolation that relies on
   * its caller for safety is the kind of thing that stops being true later.
   * A bare integer is milliseconds to Postgres.
   */
  async setStatementTimeout(ms, tx) {
    // NaN survives min/max; a non-finite input falls back to the 5 s default.
    const bounded = Number.isFinite(ms) ? Math.min(60_000, Math.max(1, Math.trunc(ms))) : 5_000;
    await (tx as TenantTx).execute(sql.raw(`SET LOCAL statement_timeout = ${bounded}`));
  },
};
