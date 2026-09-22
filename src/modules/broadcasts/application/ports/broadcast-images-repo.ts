/**
 * F119 T033 — `BroadcastImagesRepo` Application port (data-model § 4).
 *
 * The image lifecycle record: one row per upload, owned by the E-Blast
 * (`owner_kind='broadcast'` — a draft IS a `broadcasts` row) or the
 * template. It is what makes ownership enforceable (the route's ownership
 * check) and erasure reachable (`markDeletedByOwner` stamps `deleted_at`
 * inside the same tx as a withdrawal / rejection / erasure; the bytes go
 * on the daily sweep under the LAST-REFERENCE rule — `countLiveByContentHash`
 * counts live rows of EITHER owner_kind).
 *
 * Every method takes the caller's `tx` (or opens its own tenant tx when
 * given null); the adapter never reaches for the pool-global `db`.
 */
import type { TenantSlug } from '@/modules/tenants';
import type { ImageMimeType } from './image-storage-port';

export type BroadcastImagesTx = unknown;
export type BroadcastImageOwnerKind = 'broadcast' | 'template';

export interface BroadcastImageRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerKind: BroadcastImageOwnerKind;
  readonly ownerId: string;
  readonly contentHash: string;
  readonly blobUrl: string;
  readonly blobKey: string;
  readonly mimeType: ImageMimeType;
  readonly byteSize: number;
  readonly uploadedByUserId: string;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

export interface NewBroadcastImage {
  readonly ownerKind: BroadcastImageOwnerKind;
  readonly ownerId: string;
  readonly contentHash: string;
  readonly blobUrl: string;
  readonly blobKey: string;
  readonly mimeType: ImageMimeType;
  readonly byteSize: number;
  readonly uploadedByUserId: string;
}

export interface BroadcastImagesRepo {
  withTx<T>(tenantId: TenantSlug, fn: (tx: BroadcastImagesTx) => Promise<T>): Promise<T>;
  /** Insert one row; returns it with its generated id. */
  record(tenantId: TenantSlug, input: NewBroadcastImage, tx: BroadcastImagesTx): Promise<BroadcastImageRecord>;
  /** Live rows (deleted_at IS NULL) of one owner. */
  listByOwner(
    tenantId: TenantSlug,
    owner: { readonly kind: BroadcastImageOwnerKind; readonly id: string },
    tx?: BroadcastImagesTx | null,
  ): Promise<readonly BroadcastImageRecord[]>;
  /** Stamp deleted_at on every live row of one owner; returns the rows stamped. */
  markDeletedByOwner(
    tenantId: TenantSlug,
    owner: { readonly kind: BroadcastImageOwnerKind; readonly id: string },
    at: Date,
    tx: BroadcastImagesTx,
  ): Promise<readonly BroadcastImageRecord[]>;
  /**
   * F119 review finding F2-2 — stamp `deleted_at` on every live image of every
   * broadcast the member ORIGINATED, in ONE update, for the Art. 17 / PDPA §33
   * erasure cascade. Returns the rows stamped so the caller audits each.
   *
   * The cascade previously redacted `subject` / `body_html` and stopped there:
   * the member's UPLOADED PHOTOGRAPH stayed at its public blob URL, unchanged
   * and still served, after the erasure was certified complete. Redacting the
   * HTML removes the pointer, not the file.
   *
   * By member rather than by owner because the cascade has the member, not the
   * broadcast list — and because an N+1 over every broadcast a long-standing
   * member ever wrote is the wrong shape inside an erasure transaction.
   */
  markDeletedForMember(
    tenantId: TenantSlug,
    memberId: string,
    at: Date,
    tx: BroadcastImagesTx,
  ): Promise<readonly BroadcastImageRecord[]>;
  /** Rows already marked (deleted_at IS NOT NULL), oldest first, bounded. */
  listMarked(tenantId: TenantSlug, limit: number, tx: BroadcastImagesTx): Promise<readonly BroadcastImageRecord[]>;
  /**
   * F119 review finding F2-1 — LIVE rows (`deleted_at IS NULL`) whose owner
   * row no longer exists: an anti-join against `broadcasts` /
   * `broadcast_templates` within the tenant.
   *
   * This is DEFENCE IN DEPTH, not the primary mechanism. `owner_id` carries no
   * FK (two possible parents), so nothing in the database reacts to a hard
   * delete; the two hard-delete paths that exist today (draft discard, draft
   * prune) now stamp `deleted_at` themselves, in the owner's transaction. This
   * arm exists so that a FUTURE hard-delete path that forgets to stamp cannot
   * recreate the class — a member's photograph stranded at a public blob URL
   * that no sweep and no erasure can reach.
   */
  listOrphaned(tenantId: TenantSlug, limit: number, tx: BroadcastImagesTx): Promise<readonly BroadcastImageRecord[]>;
  /**
   * Live rows of EITHER owner_kind sharing the hash — the last-reference rule.
   *
   * `excludeImageId` omits ONE row from the count. The orphan arm needs it:
   * an orphan is itself a live row, so without the exclusion it would count
   * itself and its blob could never be reclaimed.
   */
  countLiveByContentHash(
    tenantId: TenantSlug,
    contentHash: string,
    tx: BroadcastImagesTx,
    excludeImageId?: string,
  ): Promise<number>;
  /**
   * F119 review finding F2-10(a) — `pg_advisory_xact_lock` on
   * `('broadcasts-image:' || tenant || ':' || content_hash)`, held to the end
   * of `tx`.
   *
   * Taken by BOTH the sweep's per-row transaction and `recordImage`'s
   * transaction. Without it the sweep read `countLiveByContentHash`, found 0,
   * and then deleted the blob — while a concurrent upload of the same file
   * short-circuited on blob EXISTENCE (the dedup probe asks storage, not the
   * database) and inserted a live row. Result: a live row pointing at a 404.
   *
   * `broadcasts-image:` is a NEW sub-namespace. The three existing advisory
   * namespaces mean different things and are deliberately disjoint —
   * `invoicing:` is §87 gap-free numbering, `payments:` is a per-invoice
   * TOCTOU guard, `broadcasts:` is per-broadcast. This one is per
   * (tenant, content_hash) and guards blob reclamation only; never reuse it
   * for anything else.
   */
  lockContentHash(tenantId: TenantSlug, contentHash: string, tx: BroadcastImagesTx): Promise<void>;
  /**
   * F119 review finding F2-10(b) — does any LIVE content of this tenant still
   * embed this blob URL? A tenant-scoped `EXISTS` over `broadcasts.body_html`
   * and the templates' body.
   *
   * The `broadcast_images` table was NOT backfilled, so every image uploaded
   * before migration 0304 is referenced by `body_html` with no row to show for
   * it. Under the row-only last-reference rule, the first time ANY row sharing
   * that hash was marked, the blob was deleted — and a live E-Blast lost its
   * picture. This check is the backstop: when it says true the row is still
   * removed (its own reference is gone) but the BYTES stay.
   */
  isBlobReferencedByContent(tenantId: TenantSlug, blobUrl: string, tx: BroadcastImagesTx): Promise<boolean>;
  /** Hard-delete one row (after its blob is gone or kept by reference). */
  remove(tenantId: TenantSlug, imageId: string, tx: BroadcastImagesTx): Promise<void>;
}
