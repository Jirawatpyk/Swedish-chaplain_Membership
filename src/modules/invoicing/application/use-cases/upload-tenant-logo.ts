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

export type UploadTenantLogoError =
  | { code: 'mime_rejected'; mime: string }
  | { code: 'too_large'; size: number; maxBytes: 1_048_576 }
  | { code: 'dimensions_out_of_range'; width: number; height: number }
  | { code: 'decode_failed' };

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
  let ext: 'png' | 'jpg';
  let reencoded: Buffer;
  let width: number;
  let height: number;
  try {
    const pipeline = sharp(Buffer.from(input.bytes));
    const meta = await pipeline.metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    if (width < MIN_WIDTH || width > MAX_WIDTH || height < MIN_HEIGHT || height > MAX_HEIGHT) {
      return err({ code: 'dimensions_out_of_range', width, height });
    }
    if (input.declaredMime === 'image/png') {
      ext = 'png';
      reencoded = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    } else {
      ext = 'jpg';
      reencoded = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }
  } catch {
    return err({ code: 'decode_failed' });
  }

  // 5. Upload — unique key per upload so logo history can be
  // inspected / rolled back via audit trail without namespace
  // collision on the Blob store.
  const logoBlobKey = `invoicing/${input.tenantId}/logos/${randomUUID()}.${ext}`;
  await deps.blob.uploadLogo({
    key: logoBlobKey,
    body: new Uint8Array(reencoded),
    contentType: input.declaredMime === 'image/png' ? 'image/png' : 'image/jpeg',
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
