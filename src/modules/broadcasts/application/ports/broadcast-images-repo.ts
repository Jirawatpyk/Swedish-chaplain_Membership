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
  /** Rows already marked (deleted_at IS NOT NULL), oldest first, bounded. */
  listMarked(tenantId: TenantSlug, limit: number, tx: BroadcastImagesTx): Promise<readonly BroadcastImageRecord[]>;
  /** Live rows of EITHER owner_kind sharing the hash — the last-reference rule. */
  countLiveByContentHash(tenantId: TenantSlug, contentHash: string, tx: BroadcastImagesTx): Promise<number>;
  /** Hard-delete one row (after its blob is gone or kept by reference). */
  remove(tenantId: TenantSlug, imageId: string, tx: BroadcastImagesTx): Promise<void>;
}
