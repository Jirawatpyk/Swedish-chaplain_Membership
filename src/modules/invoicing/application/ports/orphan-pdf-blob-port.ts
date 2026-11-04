/**
 * #729 — the orphan PDF sweeper's view of Blob: one page of keys under a
 * prefix, each with its upload time (the age rule) and etag (the conditional
 * delete), plus the existing delete. Kept apart from `BlobStoragePort`, whose
 * `list` is a capped, unpaged read of pathnames only (logo-cap callers).
 */
import type { BlobStoragePort } from './blob-storage-port';

export interface OrphanPdfBlobItem {
  readonly key: string;
  readonly uploadedAt: Date;
  readonly etag: string;
}

export interface OrphanPdfBlobPage {
  readonly items: readonly OrphanPdfBlobItem[];
  /** Pass back to read the next page; undefined on the last page. */
  readonly cursor: string | undefined;
  readonly hasMore: boolean;
}

export interface OrphanPdfBlobPort extends Pick<BlobStoragePort, 'delete'> {
  /**
   * One page. `signal` bounds the call (the SDK retries a 5xx for minutes);
   * without one the adapter applies its own timeout.
   */
  listPage(
    prefix: string,
    cursor: string | undefined,
    limit: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<OrphanPdfBlobPage>;
}
