/**
 * T071 (F7.1a US2) — `uploadInlineImage` Application use-case.
 *
 * Pipeline (FR-012 / FR-013 + critique E6):
 *   1. MIME-type allowlist (image/png|jpeg|webp|gif) — fast-fail
 *   2. Size cap (≤5 MB) — fast-fail emits `broadcast_image_too_large`
 *   3. Filename sanitisation (strip <>&"'\\/ + max 255 chars)
 *   4. SHA-256 content-hash — dedup short-circuit if already stored
 *   5. ClamAV virus scan via `VirusScannerPort` — fail-closed on
 *      verdict !== 'clean'
 *   6. Vercel Blob persistence in tenant-scoped namespace
 *   7. Return { blobUrl, allowlistedHostname, contentHash }
 *
 * Pipeline-order invariant (data-model § FR-013 + critique P/E
 * security clauses): bytes NEVER reach storage before verdict='clean'
 * is recorded. Rejected uploads are NEVER persisted.
 *
 * Pure Application logic — no framework imports.
 */
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@/lib/result';
import type {
  ImageAllowlistPort,
} from '../ports/image-allowlist-port';
import type { VirusScannerPort } from '../ports/virus-scanner-port';
import type {
  ImageStoragePort,
  ImageMimeType,
} from '../ports/image-storage-port';
import type { AuditPort } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set<ImageMimeType>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export interface UploadInlineImageDeps {
  readonly allowlistPort: ImageAllowlistPort;
  readonly scanner: VirusScannerPort;
  readonly storage: ImageStoragePort;
  readonly audit: AuditPort;
}

export interface UploadInlineImageInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly draftId: string;
  readonly requestId: string;
  readonly fileBytes: Buffer | Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
}

export type UploadInlineImageError =
  | { readonly kind: 'broadcast_image_too_large'; readonly sizeBytes: number }
  | {
      readonly kind: 'broadcast_image_invalid_mime';
      readonly receivedMime: string;
    }
  | { readonly kind: 'broadcast_image_unsafe'; readonly reason: string };

export interface UploadInlineImageOutput {
  readonly blobUrl: string;
  readonly allowlistedHostname: string;
  readonly contentHash: string;
}

export async function uploadInlineImage(
  deps: UploadInlineImageDeps,
  input: UploadInlineImageInput,
): Promise<Result<UploadInlineImageOutput, UploadInlineImageError>> {
  if (!ALLOWED_MIME.has(input.mimeType as ImageMimeType)) {
    return err({
      kind: 'broadcast_image_invalid_mime',
      receivedMime: input.mimeType,
    });
  }
  const mime = input.mimeType as ImageMimeType;

  const sizeBytes = input.fileBytes.byteLength;
  if (sizeBytes > MAX_BYTES) {
    await deps.audit.emit(null, {
      eventType: 'broadcast_image_too_large',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Inline image rejected — size ${sizeBytes} > ${MAX_BYTES}`,
      payload: { sizeBytes, draftId: input.draftId, mime },
      requestId: input.requestId,
    });
    return err({ kind: 'broadcast_image_too_large', sizeBytes });
  }

  const sanitisedFilename = sanitiseFilename(input.filename);
  const contentHash = createHash('sha256')
    .update(input.fileBytes as Uint8Array)
    .digest('hex');

  // Dedup short-circuit (best-effort; correctness handled by put's
  // tenant-scoped + content-addressed key).
  const existing = await deps.storage.existsByContentHash(
    input.tenantId,
    contentHash,
  );
  if (existing) {
    const hostname = safeUrlHostname(existing) ?? '';
    return ok({ blobUrl: existing, allowlistedHostname: hostname, contentHash });
  }

  const verdict = await deps.scanner.scan(Buffer.from(input.fileBytes));
  if (verdict.verdict !== 'clean') {
    const reason =
      verdict.verdict === 'infected'
        ? verdict.signature
        : verdict.verdict === 'error'
          ? `scanner_error:${verdict.reason}`
          : 'scanner_timeout';
    await deps.audit.emit(null, {
      eventType: 'broadcast_image_unsafe',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Inline image rejected — virus-scan verdict=${verdict.verdict}`,
      payload: {
        draftId: input.draftId,
        verdict: verdict.verdict,
        signature: verdict.verdict === 'infected' ? verdict.signature : null,
        durationMs: verdict.durationMs,
      },
      requestId: input.requestId,
    });
    return err({ kind: 'broadcast_image_unsafe', reason });
  }

  const { blobUrl } = await deps.storage.put({
    tenantId: input.tenantId,
    bytes: input.fileBytes as Uint8Array,
    contentHash,
    mimeType: mime,
    sanitisedFilename,
  });
  const hostname = safeUrlHostname(blobUrl) ?? '';
  return ok({ blobUrl, allowlistedHostname: hostname, contentHash });
}

function sanitiseFilename(raw: string): string {
  // Strip HTML / JS-meta characters per FR-013 critique E6, collapse
  // whitespace, cap at 255 chars.
  return raw
    .replace(/[<>&"'\\/]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 255);
}

function safeUrlHostname(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}
