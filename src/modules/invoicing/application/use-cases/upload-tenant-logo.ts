/**
 * R7-B2 — upload-tenant-logo use case (FR-034, F4 US4 AS4).
 *
 * Dedicated logo upload endpoint so the tenant-invoice-settings PATCH
 * never receives raw image bytes. Pipeline:
 *
 *   1. MIME whitelist — accept only `image/png` / `image/jpeg`.
 *   2. Size ≤ 1 MB.
 *   3. Dimensions: 200 ≤ width ≤ 2000 AND 100 ≤ height ≤ 500.
 *   4. Re-encode through `sharp` to strip EXIF / metadata / embedded
 *      scripts; output format matches input (`png` → `png`,
 *      `jpeg` → `jpeg` with 85 % quality).
 *   5. Upload to Blob under `invoicing/{tenantId}/logos/{random}.{ext}`.
 *   6. Return the new `logoBlobKey` — caller feeds it to
 *      `updateTenantInvoiceSettings({ logoBlobKey })`.
 *
 * The subsequent PATCH is what actually wires the new logo into the
 * tenant's identity snapshot; this use-case only uploads bytes. Split
 * so an upload failure never half-applies a settings change.
 */
import { err, ok, type Result } from '@/lib/result';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { AuditPort } from '../ports/audit-port';

export interface UploadTenantLogoInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId?: string | null;
  readonly bytes: Uint8Array;
  readonly declaredMime: string;
  readonly declaredSize: number;
}

/**
 * T092b — enforce a per-tenant logo-history cap so a pathological
 * client (or a buggy auto-save that re-uploads on every keystroke)
 * cannot exhaust the Blob store. `50` matches the R2-E6 spec value
 * and is generous: a normal tenant replaces their logo 1–3 times in
 * the lifetime of the account.
 */
export const LOGO_HISTORY_CAP = 50;

export type UploadTenantLogoError =
  | { code: 'mime_rejected'; mime: string }
  | { code: 'too_large'; size: number; maxBytes: 1_048_576 }
  | { code: 'dimensions_out_of_range'; width: number; height: number }
  | { code: 'decode_failed' }
  | { code: 'logo_history_cap_reached'; current: number; cap: typeof LOGO_HISTORY_CAP };

export interface UploadTenantLogoDeps {
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
}

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg']);
const MAX_BYTES = 1_048_576; // 1 MB
const MIN_WIDTH = 200;
const MAX_WIDTH = 2000;
const MIN_HEIGHT = 100;
const MAX_HEIGHT = 500;

export async function uploadTenantLogo(
  deps: UploadTenantLogoDeps,
  input: UploadTenantLogoInput,
): Promise<Result<{ logoBlobKey: string }, UploadTenantLogoError>> {
  // 1. MIME whitelist — the declared MIME is advisory; the `sharp`
  // probe below verifies the actual image format. SVG is explicitly
  // NOT in the whitelist (can carry embedded scripts / external refs).
  if (!ALLOWED_MIMES.has(input.declaredMime)) {
    return err({ code: 'mime_rejected', mime: input.declaredMime });
  }

  // 2. Size ceiling.
  if (input.declaredSize > MAX_BYTES) {
    return err({ code: 'too_large', size: input.declaredSize, maxBytes: MAX_BYTES });
  }

  // 3 + 4. sharp probe → re-encode. A malformed/non-image payload
  // fails the metadata() call; a re-encode that matches the input
  // format strips EXIF + XMP + ICC (sharp default behaviour: strips
  // unless `withMetadata()` is called).
  //
  // N3 (review 2026-04-19 21:19):
  //   (a) `limitInputPixels` caps decompression-bomb payloads at the
  //       dimension bounding box so a 900 KB file declaring
  //       65 000 × 65 000 pixels fails fast at the decoder rather
  //       than OOMing the Function.
  //   (b) Choose the output encoder branch + upload contentType from
  //       the DETECTED `meta.format`, not the client-supplied
  //       `declaredMime`. Prevents format-confusion where a client
  //       declares `image/png` but the bytes are JPEG (or vice
  //       versa). Declared MIME is still used as a fast-reject gate.
  let ext: 'png' | 'jpg';
  let outputContentType: 'image/png' | 'image/jpeg';
  let reencoded: Buffer;
  let width: number;
  let height: number;
  try {
    const pipeline = sharp(Buffer.from(input.bytes), {
      limitInputPixels: MAX_WIDTH * MAX_HEIGHT, // 2000*500 = 1M pixels
      failOn: 'error',
    });
    const meta = await pipeline.metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    if (width < MIN_WIDTH || width > MAX_WIDTH || height < MIN_HEIGHT || height > MAX_HEIGHT) {
      return err({ code: 'dimensions_out_of_range', width, height });
    }
    // Detected format must also be in the whitelist — otherwise we
    // have a declared/detected mismatch that could land in Blob with
    // a misleading contentType.
    if (meta.format !== 'png' && meta.format !== 'jpeg') {
      return err({ code: 'decode_failed' });
    }
    if (meta.format === 'png') {
      ext = 'png';
      outputContentType = 'image/png';
      reencoded = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    } else {
      ext = 'jpg';
      outputContentType = 'image/jpeg';
      reencoded = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }
  } catch (e) {
    // Log at warn — sharp failure is not PII-sensitive and blind
    // discard hides real deployment issues (missing libvips shared
    // object, upstream sharp bug). Post-review 2026-04-19 agent nit.
    logger.warn(
      { err: e, tenantId: input.tenantId, declaredMime: input.declaredMime },
      'uploadTenantLogo: sharp decode / re-encode failed',
    );
    return err({ code: 'decode_failed' });
  }

  // 5. History-cap gate (T092b) — list existing logos under the
  // per-tenant prefix and refuse if at or above the cap. Runs AFTER
  // the validation gates above (cheap fast-fails first) and BEFORE
  // the upload so a capped tenant does not waste Blob write quota.
  const prefix = `invoicing/${input.tenantId}/logos/`;
  // Pass `LOGO_HISTORY_CAP + 1` so the result distinguishes
  // "exactly at cap" from "over cap" in a single call.
  const existing = await deps.blob.list(prefix, LOGO_HISTORY_CAP + 1);
  if (existing.length >= LOGO_HISTORY_CAP) {
    logger.warn(
      { tenantId: input.tenantId, count: existing.length, cap: LOGO_HISTORY_CAP },
      'uploadTenantLogo: logo history cap reached',
    );
    return err({
      code: 'logo_history_cap_reached',
      current: existing.length,
      cap: LOGO_HISTORY_CAP,
    });
  }

  // 6. Upload — unique key per upload so logo history can be
  // inspected / rolled back via audit trail without namespace
  // collision on the Blob store.
  const logoBlobKey = `${prefix}${randomUUID()}.${ext}`;
  await deps.blob.uploadLogo({
    key: logoBlobKey,
    body: new Uint8Array(reencoded),
    contentType: outputContentType,
  });

  // Audit trail — logo changes are a tenant-identity mutation that a
  // finance reviewer may need to reconstruct. Emit before the caller
  // PATCHes the settings row so an abandoned upload (user aborts
  // before saving the form) still leaves an audit breadcrumb.
  await deps.audit.emit(null, {
    tenantId: input.tenantId,
    requestId: input.requestId ?? null,
    eventType: 'tenant_invoice_settings_updated',
    actorUserId: input.actorUserId,
    summary: 'Tenant logo uploaded',
    payload: {
      logoBlobKey,
      declaredMime: input.declaredMime,
      declaredSize: input.declaredSize,
      width,
      height,
      reencodedSize: reencoded.byteLength,
    },
  });

  return ok({ logoBlobKey });
}
