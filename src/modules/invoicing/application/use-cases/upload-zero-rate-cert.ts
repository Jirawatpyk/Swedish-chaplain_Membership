/**
 * 088 US8 UX-B1 (T061e-2) — `uploadZeroRateCert` Application use-case.
 *
 * Attaches an OPTIONAL MFA §80/1(5) zero-rate certificate SCAN to a
 * zero-rated invoice (FR-024). Mirrors the F7.1a inline-image upload pipeline:
 *
 *   1. MIME-type allowlist (application/pdf | image/png | image/jpeg) — fast-fail
 *   2. Size cap (≤5 MB) — fast-fail
 *   3. ClamAV virus scan via `VirusScannerPort` — FAIL-CLOSED on verdict!=='clean'
 *   4. Vercel Blob persistence at a deterministic tenant-scoped key
 *   5. Return { blobKey }
 *
 * PIPELINE-ORDER INVARIANT (FR-024 / F7.1a critique): bytes NEVER reach storage
 * before verdict='clean' is recorded. A rejected upload (oversize / infected /
 * scanner-error / bad-mime) is NEVER persisted.
 *
 * The cert scan is OPTIONAL — the cert NUMBER (`zeroRateCertNo`, gated at
 * issue-invoice) is the fail-closed compliance gate, NOT the scan. When ClamAV
 * is unconfigured (dev `env.clamav.scanUrl` empty) the scanner returns
 * `error/unconfigured` and this use-case rejects the upload; that is acceptable
 * because the invoice can still be issued on the cert NUMBER alone.
 *
 * NO audit dep: the cert BLOB key is later PINNED at issue-invoice, where the
 * `invoice_issued` audit already records `vat_treatment` + `zero_rate_cert_no`.
 * There is no fitting F4 audit event type for a pre-issue attach and adding one
 * is a heavy 4-place change (Constitution X: prefer simpler). An orphaned scan
 * (upload without a subsequent issue) is swept by the UX-B2 TTL cron (deferred).
 *
 * Pure Application logic — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { ClockPort } from '../ports/clock-port';
import type { VirusScannerPort } from '../ports/virus-scanner-port';

const MAX_BYTES = 5 * 1024 * 1024;

/** Accepted cert MIME types → file extension used in the blob key. */
const ACCEPTED_MIME = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
} as const;
type CertMimeType = keyof typeof ACCEPTED_MIME;

export function isCertMimeType(m: string): m is CertMimeType {
  return m === 'application/pdf' || m === 'image/png' || m === 'image/jpeg';
}

export interface UploadZeroRateCertDeps {
  readonly scanner: VirusScannerPort;
  readonly blob: BlobStoragePort;
  /** Injected clock — `uploadedAtMs` derives from `nowIso()`, never module-scope Date.now(). */
  readonly clock: ClockPort;
}

export interface UploadZeroRateCertInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer | Uint8Array;
}

export type UploadZeroRateCertError =
  | { readonly kind: 'zero_rate_cert_invalid_mime'; readonly receivedMime: string }
  | { readonly kind: 'zero_rate_cert_too_large'; readonly sizeBytes: number }
  | { readonly kind: 'zero_rate_cert_unsafe'; readonly reason: string }
  | { readonly kind: 'zero_rate_cert_scan_failed'; readonly reason: string };

export interface UploadZeroRateCertOutput {
  /**
   * Deterministic tenant-scoped blob key. The `invoiceId` is embedded so the
   * UX-B2 TTL sweep can join blob→invoice; the `uploadedAtMs` suffix keeps
   * every attempt at a distinct key (no conflict-as-success needed).
   */
  readonly blobKey: string;
}

export async function uploadZeroRateCert(
  deps: UploadZeroRateCertDeps,
  input: UploadZeroRateCertInput,
): Promise<Result<UploadZeroRateCertOutput, UploadZeroRateCertError>> {
  // 1. MIME allowlist — fast-fail before touching the scanner or blob.
  const mime = input.contentType;
  if (!isCertMimeType(mime)) {
    return err({ kind: 'zero_rate_cert_invalid_mime', receivedMime: mime });
  }

  // 2. Size cap — fast-fail.
  const sizeBytes = input.bytes.byteLength;
  if (sizeBytes > MAX_BYTES) {
    return err({ kind: 'zero_rate_cert_too_large', sizeBytes });
  }

  // 3. ClamAV scan — FAIL-CLOSED. Bytes are NOT uploaded before a clean verdict.
  const scanBytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  const verdict = await deps.scanner.scan(scanBytes);
  if (verdict.verdict !== 'clean') {
    if (verdict.verdict === 'infected') {
      logger.warn(
        { tenantId: input.tenantId, invoiceId: input.invoiceId, verdict: 'infected' },
        'uploadZeroRateCert: cert scan flagged infected — rejected (bytes NOT persisted)',
      );
      return err({ kind: 'zero_rate_cert_unsafe', reason: verdict.signature });
    }
    const reason =
      verdict.verdict === 'timeout' ? 'scanner_timeout' : `scanner_${verdict.reason}`;
    logger.warn(
      { tenantId: input.tenantId, invoiceId: input.invoiceId, verdict: verdict.verdict },
      'uploadZeroRateCert: cert scan not clean — rejected (fail-closed, bytes NOT persisted)',
    );
    return err({ kind: 'zero_rate_cert_scan_failed', reason });
  }

  // 4. Persist — only reached on a clean verdict. Reuse the F4 blob adapter's
  // `uploadPdf` / `uploadLogo` (no new port method): both use
  // access:'public' + addRandomSuffix:false. The timestamped key is unique per
  // upload, so neither method's conflict handling ever triggers.
  const ext = ACCEPTED_MIME[mime];
  const uploadedAtMs = new Date(deps.clock.nowIso()).getTime();
  const blobKey = `invoicing/${input.tenantId}/zero-rate-certs/${input.invoiceId}_${uploadedAtMs}.${ext}`;
  const body = scanBytes;
  if (mime === 'application/pdf') {
    await deps.blob.uploadPdf({ key: blobKey, body, contentType: 'application/pdf' });
  } else {
    await deps.blob.uploadLogo({ key: blobKey, body, contentType: mime });
  }

  return ok({ blobKey });
}
