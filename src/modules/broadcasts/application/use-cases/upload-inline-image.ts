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
import { logger } from '@/lib/logger';
import { asHostname } from '../../domain/value-objects/image-source-allowlist';
import { safeAuditEmit } from './_safe-audit-emit';
import type {
  ImageAllowlistPort,
} from '../ports/image-allowlist-port';
import type { VirusScannerPort } from '../ports/virus-scanner-port';
import {
  isImageMimeType,
  type ImageMimeType,
  type ImageStoragePort,
} from '../ports/image-storage-port';
import type { Hostname } from '../ports/image-allowlist-port';
import type { AuditPort } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';

const MAX_BYTES = 5 * 1024 * 1024;

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
  | { readonly kind: 'broadcast_image_unsafe'; readonly reason: string }
  // PR-review fix 2026-05-20 SF-M4 — distinguishes Blob/storage layer
  // outage (token expired / store suspended / rate-limited) from
  // application-layer rejects. Route maps to HTTP 503 instead of 500
  // so member sees "service unavailable, try again" rather than a
  // generic internal error.
  | { readonly kind: 'storage_unavailable'; readonly reason: string };

export interface UploadInlineImageOutput {
  readonly blobUrl: string;
  // PR-review fix 2026-05-20 TD-M2 — Hostname brand preserved at API
  // boundary. Empty-string used to indicate "blob URL was unparseable"
  // — now explicit `null` keeps the type honest + forces consumers to
  // handle the null branch. (Successful uploads always produce a
  // parseable URL; null only fires on the dedup-fallthrough log path.)
  readonly allowlistedHostname: Hostname | null;
  readonly contentHash: string;
}

export async function uploadInlineImage(
  deps: UploadInlineImageDeps,
  input: UploadInlineImageInput,
): Promise<Result<UploadInlineImageOutput, UploadInlineImageError>> {
  if (!isImageMimeType(input.mimeType)) {
    // PR-review fix 2026-05-20 CR-M6 — emit audit for invalid_mime
    // reject so SIEM can alert on probing patterns (e.g. attacker
    // posting application/octet-stream payloads). Reuses
    // `broadcast_image_unsafe` event-type with `reason: 'invalid_mime'`
    // discriminant to keep audit-event-type count stable at 55.
    await safeAuditEmit(deps.audit, null, {
      eventType: 'broadcast_image_unsafe',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Inline image rejected — invalid MIME ${input.mimeType}`,
      payload: {
        draftId: input.draftId,
        reason: 'invalid_mime',
        receivedMime: input.mimeType,
      },
      requestId: input.requestId,
    });
    return err({
      kind: 'broadcast_image_invalid_mime',
      receivedMime: input.mimeType,
    });
  }
  // Post-narrow: `input.mimeType` is now `ImageMimeType` via the
  // user-defined type guard above — no `as` cast needed.
  const mime: ImageMimeType = input.mimeType;

  const sizeBytes = input.fileBytes.byteLength;
  if (sizeBytes > MAX_BYTES) {
    // PR-review fix 2026-05-20 SF-H3: safeAuditEmit preserves the
    // 413-reject effect even when audit storage hiccups (would
    // previously bubble as 500 + lose the security event).
    await safeAuditEmit(deps.audit, null, {
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
  // tenant-scoped + content-addressed key). CR-M3 — passes mime so
  // adapter probes ONE key not 4.
  const existing = await deps.storage.existsByContentHash(
    input.tenantId,
    contentHash,
    mime,
  );
  if (existing) {
    const dedupHost = safeAsHostname(existing);
    // PR-review fix 2026-05-20 SF-M3 — when the existing blob URL is
    // unparseable (corrupt cache / future URL-shape change), don't
    // return an unusable success. Log + fall through to fresh upload
    // so the member's image actually ends up at a hostname the
    // submit-time allowlist can validate.
    if (!dedupHost) {
      logger.warn(
        { tenantId: input.tenantId, contentHash, existing },
        'broadcasts.uploadInlineImage.dedup_url_unparseable_fallthrough',
      );
    } else {
      // PR-review fix 2026-05-20 CR-H2 — ensure the deduped blob's
      // hostname is in the tenant allowlist BEFORE returning success.
      await ensureBlobHostAllowlisted(deps, input.tenantId, dedupHost);
      return ok({
        blobUrl: existing,
        allowlistedHostname: dedupHost,
        contentHash,
      });
    }
  }

  const verdict = await deps.scanner.scan(Buffer.from(input.fileBytes));
  if (verdict.verdict !== 'clean') {
    const reason =
      verdict.verdict === 'infected'
        ? verdict.signature
        : verdict.verdict === 'error'
          ? `scanner_error:${verdict.reason}`
          : 'scanner_timeout';
    // PR-review fix 2026-05-20 SF-H2: safeAuditEmit preserves the
    // 422-reject + bytes-NEVER-persisted invariant even when audit
    // storage hiccups (pipeline-order invariant from FR-013).
    await safeAuditEmit(deps.audit, null, {
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

  // PR-review fix 2026-05-20 SF-M4 — wrap storage.put + map Blob error
  // classes to a typed `storage_unavailable` result so the route can
  // return 503 (not generic 500) on token-expired / suspended /
  // rate-limited outages. Other exceptions still propagate.
  let blobUrl: string;
  try {
    const result = await deps.storage.put({
      tenantId: input.tenantId,
      bytes: input.fileBytes as Uint8Array,
      contentHash,
      mimeType: mime,
      sanitisedFilename,
    });
    blobUrl = result.blobUrl;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      /BlobAccessError|BlobStoreSuspendedError|BlobClientTokenExpiredError|BlobServiceRateLimited|BlobServiceNotAvailable/i.test(
        msg,
      )
    ) {
      logger.error(
        {
          err: msg,
          tenantId: input.tenantId,
          contentHash,
          mime,
        },
        'broadcasts.blob_put_failed',
      );
      return err({ kind: 'storage_unavailable', reason: msg });
    }
    throw e;
  }
  const hostname = safeAsHostname(blobUrl);

  // PR-review fix 2026-05-20 CR-H2 — auto-allowlist the resulting blob
  // hostname on BOTH dedup short-circuit AND fresh-upload paths via
  // the shared `ensureBlobHostAllowlisted` helper (extracted below).
  if (hostname) {
    await ensureBlobHostAllowlisted(deps, input.tenantId, hostname);
  }

  return ok({ blobUrl, allowlistedHostname: hostname, contentHash });
}

/**
 * PR-review fix 2026-05-20 CR-H2 — idempotently ensure the
 * platform-controlled blob hostname is in the tenant's allowlist.
 * Called on BOTH the dedup short-circuit branch AND the fresh-upload
 * branch (previously only the latter, which left first-upload-then-
 * dedup races with submit-time REJECT and no recovery path).
 *
 * Best-effort: failure is logged at warn level + ignored so the upload
 * still returns success. Subsequent uploads re-attempt the seed.
 */
async function ensureBlobHostAllowlisted(
  deps: UploadInlineImageDeps,
  tenantId: TenantSlug,
  hostname: Hostname,
): Promise<void> {
  try {
    await deps.allowlistPort.seedDefaults(tenantId, [hostname]);
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId,
        hostname,
      },
      'broadcasts.uploadInlineImage.allowlist_seed_failed',
    );
  }
}

function sanitiseFilename(raw: string): string {
  // Strip HTML / JS-meta characters per FR-013 critique E6, collapse
  // whitespace, cap at 255 chars.
  return raw
    .replace(/[<>&"'\\/]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 255);
}

/**
 * PR-review fix 2026-05-20 TD-M2 — chains URL parsing + `asHostname`
 * branding so the resulting hostname is either a validated `Hostname`
 * brand or `null`. Replaces the previous `safeUrlHostname` that
 * returned raw `string` (defeated the brand precisely at the API
 * boundary where it matters most for submit-time allowlist validation).
 */
function safeAsHostname(u: string): Hostname | null {
  let raw: string;
  try {
    raw = new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
  const res = asHostname(raw);
  return res.ok ? res.value : null;
}
