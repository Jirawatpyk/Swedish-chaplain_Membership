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
   * ROUND-2 R-M1 — the same stamp for MANY owners of one kind, in ONE
   * statement.
   *
   * The daily prune used to call `markDeletedByOwner` once per pruned draft,
   * all inside the DELETE's single transaction: N round-trips and N row-lock
   * sets held open for as long as the slowest one. With a bounded DELETE batch
   * the stamp has to be bounded the same way — one `WHERE owner_id = ANY(…)`
   * per batch.
   *
   * An empty `ownerIds` is a no-op returning `[]` (never a statement that
   * matches everything).
   */
  markDeletedByOwners(
    tenantId: TenantSlug,
    ownerKind: BroadcastImageOwnerKind,
    ownerIds: readonly string[],
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
  /**
   * F119 R17 — every image row of every broadcast the member ORIGINATED, LIVE
   * AND STAMPED (a stamped row is still the record of an upload), newest
   * first, at most `limit` rows. The GDPR export's read: same join as
   * `markDeletedForMember`, `tenant_id` on both sides; templates never match.
   * The caller passes one past its cap to detect truncation.
   */
  listByMember(
    tenantId: TenantSlug,
    memberId: string,
    limit: number,
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
   * ROUND-2 R-H2 — the lock alone does NOT close that window, and an earlier
   * version of this docblock claimed it did. The upload's dedup probe and its
   * PUT both happen ABOVE this lock, so a complete sweep pass for the same
   * hash still fits between them. `recordImage` therefore re-asks
   * `existsByContentHash` while holding this lock and re-PUTs the bytes when
   * the probe says they are GONE. The lock is what makes that re-check
   * meaningful; it is not a substitute for it.
   *
   * ROUND-3 #1 — "when they are gone" means `status: 'absent'`, not "the probe
   * did not answer `present`": a `head` that FAILED knows nothing, and a
   * re-PUT is not free (`allowOverwrite: false` makes it throw over existing
   * content, which rolled back the row and stranded the blob). See
   * `ImageProbeResult`.
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
  /**
   * ROUND-2 S-3 — clear `deleted_at` on one row, putting it back in the LIVE
   * set.
   *
   * The sweep's `sweep_referenced` arm used to keep the bytes and remove the
   * row anyway. A removed row is reachable by nothing afterwards: not the
   * marked arm (nothing to stamp), not the orphan arm (nothing to anti-join),
   * not the Art. 17 / §33 erasure cascade (which stamps rows). The blob went
   * on being served with no handle left on it.
   *
   * Un-stamping keeps the handle. The row is a truthful record either way —
   * live content still embeds this blob, so the reference genuinely is not
   * gone. When that content goes, the next tick's orphan arm (or a fresh
   * stamp) reaches it again.
   */
  restoreLive(tenantId: TenantSlug, imageId: string, tx: BroadcastImagesTx): Promise<void>;
  /** Hard-delete one row (after its blob is gone or kept by reference). */
  remove(tenantId: TenantSlug, imageId: string, tx: BroadcastImagesTx): Promise<void>;
  /**
   * ROUND-3 #4 — `SET LOCAL statement_timeout` on the caller's transaction,
   * in MILLISECONDS. Takes no tenant: it configures the connection for the
   * duration of `tx`, it does not read or write a tenant's rows.
   *
   * The sweep's per-row transaction needs it because both of its waits are
   * otherwise unbounded: `lockContentHash` blocks until the holder commits,
   * and `isBlobReferencedByContent` is a sequential `position()` scan over
   * `broadcasts` + `broadcast_templates` run once per swept row (up to 400 a
   * tick). `src/lib/db.ts` asks for 5 s at connect, but the pooled Neon
   * endpoint DROPS it and reports 0 — so without this the tick has no
   * database-side bound at all and is killed by `maxDuration` instead, part
   * way through, leaving the blob store and this table disagreeing. It lives
   * on the port (not as raw SQL in the use case) because Application may not
   * import Drizzle — Principle III.
   */
  setStatementTimeout(ms: number, tx: BroadcastImagesTx): Promise<void>;
}
