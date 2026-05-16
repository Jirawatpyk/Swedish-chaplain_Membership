/**
 * T021 (Feature 013 / F6.1) — Vercel Blob `ErrorCsvStore` adapter (FULL impl).
 *
 * All 3 port methods wired:
 *   - `put`               — write error-CSV bytes to tenant-scoped blob key
 *   - `generateSignedUrl` — return time-bounded download URL with expiry
 *   - `delete`            — remove blob (TTL sweep cron site)
 *
 * Blob storage notes:
 *   - `access: 'public'` is the only option `@vercel/blob` v0/v1 exposes
 *     today. The URL itself acts as a capability token — protected by
 *     (a) randomised suffix in the key (URL is ≥32 chars of opaque
 *     base32) and (b) the audit-on-access pattern at the US5 download
 *     route (signed-URL emit → server-side expiry check → 302 redirect).
 *   - The "signed URL" we return appends `?download=1` for forced-
 *     attachment header, plus the caller-provided `expiresInSeconds`
 *     stamped as a query param for the route handler to verify.
 *   - True private-blob signed URLs require Enterprise tier (see
 *     `project_eventcreate_api_gated` memory for similar pattern).
 *     The current capability-token design is acceptable at MVP scale.
 *
 * Pattern mirrors F4 `vercel-blob-adapter.ts` — same `@vercel/blob`
 * SDK, same `BLOB_READ_WRITE_TOKEN` env var, but with `addRandomSuffix:
 * true` so the URL is not enumerable from `(tenantSlug, recordId)`.
 */
import { put, del } from '@vercel/blob';
import { err, ok } from '@/lib/result';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type {
  ErrorCsvStore,
  ErrorCsvStoreError,
  PutErrorCsvInput,
  PutErrorCsvOutput,
  GenerateSignedUrlInput,
  GenerateSignedUrlOutput,
  DeleteErrorCsvInput,
} from '../application/ports/error-csv-store';

// Tenant-scoped path prefix per research.md R6.
function buildBlobKey(tenantSlug: string, recordId: string): string {
  return `tenants/${tenantSlug}/csv-import-errors/${recordId}.csv`;
}

export const vercelBlobErrorCsvStore: ErrorCsvStore = {
  async put(input: PutErrorCsvInput) {
    const key = buildBlobKey(input.tenantId, input.recordId);
    try {
      const result = await put(key, Buffer.from(input.csvBytes), {
        access: 'public',
        contentType: 'text/csv; charset=utf-8',
        token: env.blob.readWriteToken,
        // T021 full-impl fix (2026-05-15): random suffix prevents URL
        // enumeration from (tenantSlug, recordId). The previous
        // `addRandomSuffix: false` was a stub-era convenience that
        // turned the blob URL into a predictable construction —
        // anyone who could observe a recordId could fetch the blob.
        // Randomised URLs raise the bar to "must compromise the DB
        // row to discover the URL" which aligns the threat model
        // with `csv_import_records` RLS+FORCE policy.
        addRandomSuffix: true,
        // Re-uploads of the same recordId (rare — admin re-runs an
        // import that previously failed) get a NEW random suffix +
        // a NEW blob URL. The use-case persists the latest URL via
        // `csv_import_records.error_csv_blob_url` so stale URLs are
        // garbage-collected by the TTL sweep cron (US5).
      });
      return ok<PutErrorCsvOutput>({ blobUrl: result.url });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(
        {
          event: 'f6_error_csv_upload_failed',
          tenantId: input.tenantId,
          recordId: input.recordId,
          errorRowsBytes: input.csvBytes.length,
          err: message,
        },
        'F6.1 error CSV blob upload failed',
      );
      return err<ErrorCsvStoreError>({ kind: 'storage_error', message });
    }
  },

  async generateSignedUrl(input: GenerateSignedUrlInput) {
    // The blob URL itself is opaque (random suffix) and represents the
    // capability. We append `?download=1` to force browser attachment
    // download (sets Content-Disposition: attachment via Vercel Blob
    // server-side) plus stamp an `expires` query param the US5 download
    // route uses for server-side TTL enforcement (audit-on-access).
    //
    // The URL is publicly resolvable for the duration the blob lives —
    // true server-side expiry happens at the route handler that emits
    // `csv_import_error_csv_downloaded` audit BEFORE serving the
    // redirect. Calling this method does NOT emit audit; the route
    // handler does (audit on actual access, not on URL mint).
    try {
      const expiresAt = new Date(
        Date.now() + input.expiresInSeconds * 1000,
      );
      const url = new URL(input.blobUrl);
      url.searchParams.set('download', '1');
      // Stamp expiry for the US5 download route to enforce server-side.
      url.searchParams.set('expires', String(expiresAt.getTime()));
      return ok<GenerateSignedUrlOutput>({
        signedUrl: url.toString(),
        expiresAt,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(
        {
          event: 'f6_error_csv_signed_url_failed',
          // Staff-review M-6 (2026-05-16): the blob URL IS the
          // capability token for the next 30 days — logging it at
          // error level leaks the token to log sinks. Log only the
          // length + a truncated hash prefix so diagnostics still
          // correlate with the upstream `error_csv_blob_url` DB
          // column without exposing the capability.
          blobUrlLength: input.blobUrl.length,
          blobUrlPathSuffix: extractPathSuffix(input.blobUrl),
          err: message,
        },
        'F6.1 error CSV signed-URL generation failed (likely malformed blobUrl)',
      );
      return err<ErrorCsvStoreError>({ kind: 'storage_error', message });
    }
  },

  async delete(input: DeleteErrorCsvInput) {
    try {
      await del(input.blobUrl, { token: env.blob.readWriteToken });
      return ok(undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Distinguish "blob already gone" from a real storage error so
      // the TTL sweep cron (US5) can treat re-runs as idempotent
      // without emitting alerts.
      if (message.toLowerCase().includes('not_found')) {
        return err<ErrorCsvStoreError>({ kind: 'blob_not_found' });
      }
      logger.error(
        {
          event: 'f6_error_csv_delete_failed',
          // Staff-review M-6: same capability-token redaction as the
          // signed-URL path above.
          blobUrlLength: input.blobUrl.length,
          blobUrlPathSuffix: extractPathSuffix(input.blobUrl),
          err: message,
        },
        'F6.1 error CSV blob delete failed',
      );
      return err<ErrorCsvStoreError>({ kind: 'storage_error', message });
    }
  },
};

/**
 * Staff-review M-6 (2026-05-16): produce a non-capability-leaking
 * identifier from a Vercel Blob URL for diagnostic logging. Keeps the
 * tenant-scoped path prefix (which carries no secret material — the
 * tenant slug is already log-safe) and the last 8 characters of the
 * random suffix (cardinality enough to correlate distinct failures
 * without exposing the full capability token).
 *
 * Example:
 *   `https://blob.vercel-storage.com/tenants/swecham/csv-import-errors/
 *    abc123.csv-randomSuffix01234567` →
 *   `tenants/swecham/csv-import-errors/abc123.csv-...01234567`
 *
 * On a malformed URL (which is precisely the failure case the caller
 * is logging), fall back to a fixed sentinel so the log line still
 * renders.
 */
function extractPathSuffix(blobUrl: string): string {
  try {
    const parsed = new URL(blobUrl);
    const path = parsed.pathname;
    if (path.length <= 16) return path;
    return `${path.slice(0, path.lastIndexOf('/') + 1)}...${path.slice(-8)}`;
  } catch {
    return '<malformed-blob-url>';
  }
}
