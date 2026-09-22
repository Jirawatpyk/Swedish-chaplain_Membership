/**
 * T071 (F7.1a US2) — `uploadInlineImage` Application use-case.
 *
 * Pipeline (FR-012 / FR-013 + critique E6 + review findings F2-3 / F2-6):
 *   1. MIME-type allowlist (image/png|jpeg|webp|gif) — fast-fail
 *   2. Size band — fast-fail. `> 5 MB` emits `broadcast_image_too_large`;
 *      `< 1 byte` emits `broadcast_image_empty` (F2-6)
 *   3. Filename sanitisation (strip <>&"'\\/ + max 255 chars)
 *   4. ClamAV virus scan via `VirusScannerPort` — fail-closed on
 *      verdict !== 'clean'
 *   5. F2-3 — re-encode through `ImageReencoderPort` to strip EXIF/GPS/XMP
 *   6. SHA-256 content-hash + byte size OF THE RE-ENCODED BYTES — dedup
 *      short-circuit if already stored
 *   7. Vercel Blob persistence in tenant-scoped namespace
 *   8. F119 T033 — record ONE `broadcast_images` row (owner = the E-Blast or
 *      the template) and audit `broadcast_image_uploaded` in the SAME
 *      tenant tx — on the dedup path too (a second owner is a second
 *      reference; the last-reference sweep needs it)
 *   9. Return { blobUrl, allowlistedHostname, contentHash, imageId }
 *
 * Pipeline-order invariant (data-model § FR-013 + critique P/E
 * security clauses): bytes NEVER reach storage before verdict='clean'
 * is recorded. Rejected uploads are NEVER persisted.
 *
 * F2-3 moved steps 4–6 into this order deliberately. The re-encoder is an
 * image DECODER, so it must sit BELOW the ClamAV verdict — never point a
 * decoder at unscanned bytes. And the hash must be taken ABOVE it, on the
 * OUTPUT: the hash is both the dedup key and the blob key, so hashing the
 * INPUT would key the store on bytes that were never stored and the next
 * upload of the same photo would miss the dedup and orphan a blob. The cost
 * is that a deduplicated upload is now scanned before the short-circuit; that
 * is the correct trade (an identical file from a second member is still
 * verified) and it is what makes the dedup key honest.
 *
 * F2-6: the empty-file refusal sits ABOVE the scanner because the DB CHECK is
 * `byte_size BETWEEN 1 AND 5 MB`. Without it a 0-byte `File` passed MIME +
 * size, was scanned, was PUT, and only then violated the CHECK — a 500 for
 * the member plus an orphan blob with NO row, which the sweep (keyed on
 * MARKED ROWS) can never see.
 *
 * Pure Application logic — no framework imports.
 */
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@/lib/result';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
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
import type { BroadcastImageOwnerKind, BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import type { ImageReencoderPort } from '../ports/image-reencoder-port';
import type { TenantSlug } from '@/modules/tenants';

const MAX_BYTES = 5 * 1024 * 1024;

export interface UploadInlineImageDeps {
  readonly allowlistPort: ImageAllowlistPort;
  readonly scanner: VirusScannerPort;
  readonly storage: ImageStoragePort;
  readonly audit: AuditPort;
  /** F119 T033 — the image lifecycle record. */
  readonly imagesRepo: BroadcastImagesRepo;
  /**
   * F2-3 — strips EXIF/GPS before the bytes reach a PUBLIC blob URL.
   * REQUIRED, never optional: a composition that forgot to wire it would
   * publish the member's GPS co-ordinates silently, and silence is exactly
   * what this control exists to prevent.
   */
  readonly reencoder: ImageReencoderPort;
}

/**
 * F119 T033 — who uploads decides the audit's member key (#336/#337): a
 * portal user's upload to their own draft IS member activity, so it carries
 * snake_case `member_id` (the 0009 `last_activity_at` trigger key); a staff
 * upload carries `related_member_id` (the member it is FOR, or null for a
 * template) so it never refreshes the member's recency.
 */
export type UploadInlineImageActor =
  | { readonly role: 'member'; readonly memberId: string }
  | { readonly role: string | null; readonly relatedMemberId: string | null };

export interface UploadInlineImageInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly actorEmail: string;
  /** The E-Blast (a draft IS a `broadcasts` row) or the template that owns the image. */
  readonly owner: { readonly kind: BroadcastImageOwnerKind; readonly id: string };
  readonly actor: UploadInlineImageActor;
  readonly requestId: string;
  readonly fileBytes: Buffer | Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
}

export type UploadInlineImageError =
  | { readonly kind: 'broadcast_image_too_large'; readonly sizeBytes: number }
  // F2-6 — a 0-byte upload. Refused ABOVE the scanner; the DB CHECK on
  // `broadcast_images.byte_size` is `BETWEEN 1 AND 5 MB`, so letting it
  // through cost a 500 and an unsweepable orphan blob.
  | { readonly kind: 'broadcast_image_empty' }
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
  /** F119 T033 — the `broadcast_images` row written for this upload. */
  readonly imageId: string;
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
        owner_kind: input.owner.kind,
        owner_id: input.owner.id,
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
      payload: { sizeBytes, owner_kind: input.owner.kind, owner_id: input.owner.id, mime },
      requestId: input.requestId,
    });
    return err({ kind: 'broadcast_image_too_large', sizeBytes });
  }
  // F2-6 — the OTHER end of the DB CHECK `byte_size BETWEEN 1 AND 5 MB`.
  // Above the scanner and above storage: an empty file is not something to
  // scan, store, and then discover is unrepresentable. No audit row — unlike
  // the too-large / unsafe rejections this is not a security signal, it is a
  // mis-click or a browser that handed us an empty `File`.
  if (sizeBytes < 1) {
    return err({ kind: 'broadcast_image_empty' });
  }

  const sanitisedFilename = sanitiseFilename(input.filename);

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
        owner_kind: input.owner.kind,
        owner_id: input.owner.id,
        verdict: verdict.verdict,
        signature: verdict.verdict === 'infected' ? verdict.signature : null,
        durationMs: verdict.durationMs,
      },
      requestId: input.requestId,
    });
    return err({ kind: 'broadcast_image_unsafe', reason });
  }

  // F2-3 — strip EXIF/GPS/XMP. Below the verdict (never decode unscanned
  // bytes), above the hash (the hash is the dedup + blob key and must
  // describe the bytes that are actually stored).
  const reencoded = await deps.reencoder.reencode(input.fileBytes as Uint8Array, mime);
  if (!reencoded.ok) {
    broadcastsMetrics.imageReencodeFailed(
      input.tenantId as unknown as string,
      reencoded.error.kind,
    );
    // ROUND-2 R-M3 — an OUTAGE is not a verdict about the member's file.
    // Every throw out of the adapter used to arrive here as `decode_failed`,
    // so a libvips OOM or a hung decode gave the member a permanent 415 AND
    // wrote `broadcast_image_unsafe` into the audit log — a statement about
    // something they did not do. Nothing is known about these bytes, so
    // nothing is recorded about them; the member gets the 503 class and can
    // retry.
    if (reencoded.error.kind === 'reencoder_unavailable') {
      logger.error(
        {
          err: reencoded.error.kind,
          tenantId: input.tenantId,
          ownerKind: input.owner.kind,
          mime,
          requestId: input.requestId,
        },
        'broadcasts.uploadInlineImage.reencoder_unavailable',
      );
      return err({ kind: 'storage_unavailable', reason: reencoded.error.reason });
    }
    // Fail-closed: bytes we cannot decode are bytes whose metadata we cannot
    // strip. Mapped onto the existing `invalid_mime` class — from the
    // member's side "this is not an image we can accept" is the same answer.
    logger.warn(
      {
        err: reencoded.error.kind,
        tenantId: input.tenantId,
        ownerKind: input.owner.kind,
        mime,
        requestId: input.requestId,
      },
      'broadcasts.uploadInlineImage.reencode_failed',
    );
    await safeAuditEmit(deps.audit, null, {
      eventType: 'broadcast_image_unsafe',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Inline image rejected — undecodable as ${mime}`,
      payload: {
        owner_kind: input.owner.kind,
        owner_id: input.owner.id,
        reason: 'reencode_failed',
        receivedMime: input.mimeType,
      },
      requestId: input.requestId,
    });
    return err({ kind: 'broadcast_image_invalid_mime', receivedMime: input.mimeType });
  }
  const storedBytes = reencoded.value.bytes;
  const storedSizeBytes = storedBytes.byteLength;
  // Re-check the cap on the OUTPUT: a re-encode can grow a file (a heavily
  // optimised PNG round-tripped at compressionLevel 9 still can), and the DB
  // CHECK and the storage quota both apply to what we write, not what we read.
  if (storedSizeBytes > MAX_BYTES) {
    await safeAuditEmit(deps.audit, null, {
      eventType: 'broadcast_image_too_large',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Inline image rejected — re-encoded size ${storedSizeBytes} > ${MAX_BYTES}`,
      payload: {
        sizeBytes: storedSizeBytes,
        owner_kind: input.owner.kind,
        owner_id: input.owner.id,
        mime,
        stage: 'reencoded',
      },
      requestId: input.requestId,
    });
    return err({ kind: 'broadcast_image_too_large', sizeBytes: storedSizeBytes });
  }
  if (storedSizeBytes < 1) {
    return err({ kind: 'broadcast_image_empty' });
  }

  const contentHash = createHash('sha256').update(storedBytes).digest('hex');

  // Dedup short-circuit (best-effort; correctness handled by put's
  // tenant-scoped + content-addressed key). CR-M3 — passes mime so
  // adapter probes ONE key not 4.
  const existing = await deps.storage.existsByContentHash(
    input.tenantId,
    contentHash,
    mime,
  );
  if (existing) {
    const dedupHost = safeAsHostname(existing.blobUrl);
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
      const imageId = await recordImage(deps, input, {
        contentHash,
        blobUrl: existing.blobUrl,
        blobKey: existing.blobKey,
        mime,
        sizeBytes: storedSizeBytes,
        bytes: storedBytes,
        sanitisedFilename,
      });
      return ok({
        blobUrl: existing.blobUrl,
        allowlistedHostname: dedupHost,
        contentHash,
        imageId,
      });
    }
  }

  // PR-review fix 2026-05-20 SF-M4 — wrap storage.put + map Blob error
  // classes to a typed `storage_unavailable` result so the route can
  // return 503 (not generic 500) on token-expired / suspended /
  // rate-limited outages. Other exceptions still propagate.
  let blobUrl: string;
  let blobKey: string;
  try {
    const result = await deps.storage.put({
      tenantId: input.tenantId,
      // F2-3 — the METADATA-STRIPPED bytes, never `input.fileBytes`.
      bytes: storedBytes,
      contentHash,
      mimeType: mime,
      sanitisedFilename,
    });
    blobUrl = result.blobUrl;
    blobKey = result.blobKey;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      /BlobAccessError|BlobStoreSuspendedError|BlobClientTokenExpiredError|BlobServiceRateLimited|BlobServiceNotAvailable/i.test(
        msg,
      )
    ) {
      logger.error(
        {
          err: errKind(e),
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

  const imageId = await recordImage(deps, input, {
    contentHash,
    blobUrl,
    blobKey,
    mime,
    sizeBytes: storedSizeBytes,
    bytes: storedBytes,
    sanitisedFilename,
  });
  return ok({ blobUrl, allowlistedHostname: hostname, contentHash, imageId });
}

/**
 * F119 T033 — the `broadcast_images` row + the `broadcast_image_uploaded`
 * audit row, in ONE tenant tx (a row without its audit, or an audit without
 * its row, is the forensic gap Principle I clause 3 forbids). The payload
 * carries ids, keys, counts and the hash — never the blob URL. The audit
 * emit is RAW (not `safeAuditEmit`): it is the load-bearing record of a
 * write, so a failed emit rolls the row back and the route answers 500;
 * the bytes stay in Blob and the next upload of the same file dedups.
 */
async function recordImage(
  deps: UploadInlineImageDeps,
  input: UploadInlineImageInput,
  stored: {
    readonly contentHash: string;
    readonly blobUrl: string;
    readonly blobKey: string;
    readonly mime: ImageMimeType;
    readonly sizeBytes: number;
    /** ROUND-2 R-H2 — the stored bytes, for the re-PUT under the lock. */
    readonly bytes: Uint8Array;
    readonly sanitisedFilename: string;
  },
): Promise<string> {
  return deps.imagesRepo.withTx(input.tenantId, async (tx) => {
    // F119 review finding F2-10(a) — the OTHER half of the sweep's lock. The
    // dedup probe above asks BLOB STORAGE whether the bytes exist, not the
    // database, so without this lock a fresh reference could be inserted in
    // the window between the sweep counting 0 live rows and deleting the
    // blob: a live row pointing at a 404. Held to the end of this tx.
    await deps.imagesRepo.lockContentHash(input.tenantId, stored.contentHash, tx);

    // ROUND-2 R-H2 — the lock closes the window from HERE onwards, but the
    // dedup probe and the PUT both happened ABOVE it. A whole sweep pass for
    // this same hash (lock → count 0 → delete the blob → remove the row →
    // commit) fits in that gap, and the row we are about to insert would then
    // point at bytes that no longer exist. So, holding the lock the sweep also
    // needs, ask storage again and put the bytes back if they are gone. The
    // blob key is content-addressed, so the PUT is idempotent — and
    // `existsByContentHash` is documented as allowed to answer a false `null`
    // (cache-cold), which makes a spurious re-PUT the only way this can be
    // wrong. That is the safe direction.
    const stillStored = await deps.storage.existsByContentHash(
      input.tenantId,
      stored.contentHash,
      stored.mime,
    );
    if (stillStored === null) {
      logger.warn(
        {
          tenantId: input.tenantId,
          contentHash: stored.contentHash,
          mime: stored.mime,
          requestId: input.requestId,
        },
        'broadcasts.uploadInlineImage.blob_reclaimed_under_lock_reput',
      );
      await deps.storage.put({
        tenantId: input.tenantId,
        bytes: stored.bytes,
        contentHash: stored.contentHash,
        mimeType: stored.mime,
        sanitisedFilename: stored.sanitisedFilename,
      });
    }

    const row = await deps.imagesRepo.record(
      input.tenantId,
      {
        ownerKind: input.owner.kind,
        ownerId: input.owner.id,
        contentHash: stored.contentHash,
        blobUrl: stored.blobUrl,
        blobKey: stored.blobKey,
        mimeType: stored.mime,
        byteSize: stored.sizeBytes,
        uploadedByUserId: input.actorUserId,
      },
      tx,
    );
    const memberKey =
      input.actor.role === 'member' && 'memberId' in input.actor
        ? { member_id: input.actor.memberId }
        : { related_member_id: 'relatedMemberId' in input.actor ? input.actor.relatedMemberId : null };
    await deps.audit.emit(tx, {
      eventType: 'broadcast_image_uploaded',
      tenantId: input.tenantId,
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      summary: `E-Blast image uploaded (${input.owner.kind})`,
      payload: {
        ...memberKey,
        owner_kind: input.owner.kind,
        owner_id: input.owner.id,
        image_id: row.id,
        byte_size: stored.sizeBytes,
        mime_type: stored.mime,
        content_hash: stored.contentHash,
        actor_role: input.actor.role ?? null,
      },
    });
    return row.id;
  });
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
        err: errKind(e),
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
