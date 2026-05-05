/**
 * R19 — `sharp` adapter for the `ImageReEncodePort` (F4 / FR-034).
 *
 * The ONLY place in the F4 bounded context where `sharp` is imported.
 * Wraps the decode → metadata → re-encode pipeline with decompression-
 * bomb protection and EXIF/ICC/metadata stripping.
 *
 * Chosen over `pdfkit` / manual decoders because `sharp` ships with
 * libvips native binaries that are well-tested in production Vercel
 * runtimes, handles both PNG and JPEG in a single API surface, and
 * defaults to stripping metadata on re-encode (no opt-in required).
 */
// `sharp` is a Node-only native dep (libvips → detect-libc → child_process).
// Hard-fail any client component that transitively imports this adapter
// — defence-in-depth alongside the dynamic-import in
// `invoicing-deps.ts:makeUploadTenantLogoDeps`. Without this guard, a
// stray static import from a barrel re-export causes Turbopack 16 to
// pull `sharp` into client bundles and break the build.
import 'server-only';
import sharp from 'sharp';
import type {
  ImageReEncodePort,
  ImageReEncodeResult,
  ImageReEncodeError,
} from '../../application/ports/image-reencode-port';

// Decompression-bomb ceiling. Matches the Application-layer dimension
// invariant (MAX_WIDTH × MAX_HEIGHT = 2000 × 500 = 1M pixels) — a 900KB
// PNG declaring 65,000 × 65,000 would otherwise OOM the serverless
// function on decode. The use-case's dimension check catches oversized
// images that DO decode successfully; this limit catches ones that try
// to allocate too much memory just to decode.
const LIMIT_INPUT_PIXELS = 2_000 * 500;

/**
 * R20-02 — sanitise a libvips / sharp error message before it lands in
 * the returned `reason` field (which the use-case logs at warn level
 * AND carries across the Application boundary).
 *
 * Sharp occasionally embeds absolute filesystem paths (sandbox temp
 * dirs, libvips shared-object paths) in its error messages.
 * Separately, any numeric run-id or inode in the path could pattern-
 * match on a 13-digit Thai tax-id regex and drag a real tax_id through
 * logs if a coincidentally-shaped substring appears. Belt-and-
 * suspenders: strip 13-digit sequences + truncate to 200 chars.
 *
 * Mirrors `void-invoice.ts:sanitiseErrorReason` for consistency.
 */
function sanitiseErrorReason(raw: unknown): string {
  const s = (raw instanceof Error ? raw.message : String(raw))
    .replace(/\d{13}/g, '[REDACTED-TAXID]');
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

export const sharpImageReencodeAdapter: ImageReEncodePort = {
  async reencode(
    bytes: Uint8Array,
  ): Promise<
    { ok: true; value: ImageReEncodeResult } | { ok: false; error: ImageReEncodeError }
  > {
    try {
      const pipeline = sharp(Buffer.from(bytes), {
        limitInputPixels: LIMIT_INPUT_PIXELS,
        failOn: 'error',
      });
      const meta = await pipeline.metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;

      // Only PNG and JPEG are in scope; anything else (GIF, WebP, TIFF,
      // AVIF, …) is reported as `unknown` so the use-case can reject
      // via its format-whitelist invariant. We do NOT attempt to
      // re-encode an unknown-format payload into a supported one —
      // that would mask a category-error from the operator.
      //
      // R20-01 — the `unknown` variant omits `bytes` by type so TS
      // narrowing makes downstream access structurally impossible.
      if (meta.format !== 'png' && meta.format !== 'jpeg') {
        return {
          ok: true,
          value: { format: 'unknown', width, height },
        };
      }

      // Re-encode with format-appropriate settings. Re-encoding (even
      // with no explicit option changes) strips EXIF / XMP / ICC by
      // default — sharp only retains metadata when `.withMetadata()`
      // is called. That call is deliberately absent here.
      let outBuf: Buffer;
      if (meta.format === 'png') {
        outBuf = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      } else {
        // jpeg branch
        outBuf = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      }

      return {
        ok: true,
        value: {
          format: meta.format,
          width,
          height,
          bytes: new Uint8Array(outBuf),
        },
      };
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'decode_failed',
          // R20-02 — strip 13-digit sequences + truncate to 200 chars
          // before the reason crosses the Application boundary. Sharp
          // error messages can carry sandbox paths / libvips shared-
          // object references that shouldn't live in warn logs raw.
          reason: sanitiseErrorReason(e),
        },
      };
    }
  },
};
