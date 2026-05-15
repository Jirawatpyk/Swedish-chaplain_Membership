/**
 * T007 (Feature 013 / F6.1) — `ErrorCsvStore` Application port.
 *
 * Stores the per-import "error rows CSV" (FR-021 / Q4) in a private object
 * store. Source-of-truth contract lives at
 * `specs/013-csv-import-eventcreate-format/data-model.md § 4`.
 *
 * Two adapters target this port:
 *   - `VercelBlobErrorCsvStore` (T021) — production implementation backed
 *     by `@vercel/blob` private bucket with tenant-scoped path prefix
 *     `tenants/{slug}/csv-import-errors/{recordId}.csv`.
 *   - Test fakes — in-memory `Map<blobUrl, csvBytes>` for unit/contract
 *     tests; the contract test file enforces the strict-audit invariant
 *     (audit emit ONLY on signed-URL success).
 *
 * Lifecycle (research.md R6):
 *   - `put`              — write error CSV to private bucket, return blob URL
 *   - `generateSignedUrl` — 15-min signed URL for admin download (audit
 *                          fires server-side BEFORE redirect)
 *   - `delete`            — daily TTL sweep cron (30-day window)
 *
 * **MVP scope note (T021 stub)**: only `put` is wired in Phase 3. The
 * `generateSignedUrl` + `delete` impl is part of Phase 5 / US5 deferral.
 * The port still declares the full surface so post-MVP work composes
 * cleanly.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { CsvImportRecordId } from '../../domain/csv-import-record-id';

// --- Inputs / outputs -------------------------------------------------------

export interface PutErrorCsvInput {
  readonly tenantId: TenantId;
  readonly recordId: CsvImportRecordId;
  readonly csvBytes: Uint8Array;
  /** Persisted as `csv_import_records.error_csv_expires_at` (UTC). */
  readonly expiresAt: Date;
}

export interface PutErrorCsvOutput {
  /**
   * Persisted as `csv_import_records.error_csv_blob_url`. Opaque to the
   * Application layer — only the adapter understands the URL shape; the
   * Application uses it solely as a handle for subsequent sign / delete
   * calls.
   */
  readonly blobUrl: string;
}

export interface GenerateSignedUrlInput {
  readonly blobUrl: string;
  /** Typical: 900 (15 minutes per research.md R6). */
  readonly expiresInSeconds: number;
}

export interface GenerateSignedUrlOutput {
  /** Time-bound URL the browser can follow to fetch the CSV bytes. */
  readonly signedUrl: string;
  readonly expiresAt: Date;
}

export interface DeleteErrorCsvInput {
  readonly blobUrl: string;
}

// --- Error variants ---------------------------------------------------------

export type ErrorCsvStoreError =
  | { readonly kind: 'blob_not_found' }
  | { readonly kind: 'storage_error'; readonly message: string };

// --- Port -------------------------------------------------------------------

export interface ErrorCsvStore {
  put(
    input: PutErrorCsvInput,
  ): Promise<Result<PutErrorCsvOutput, ErrorCsvStoreError>>;

  generateSignedUrl(
    input: GenerateSignedUrlInput,
  ): Promise<Result<GenerateSignedUrlOutput, ErrorCsvStoreError>>;

  delete(
    input: DeleteErrorCsvInput,
  ): Promise<Result<void, ErrorCsvStoreError>>;
}
