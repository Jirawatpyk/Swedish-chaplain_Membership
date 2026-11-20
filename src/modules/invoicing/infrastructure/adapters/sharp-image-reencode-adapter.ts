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
import { errKind } from '@/lib/log-id';
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
          // R20-02 / #739 B3b — the class only: sharp's messages can
          // carry sandbox paths / libvips shared-object references.
          reason: errKind(e),
        },
      };
    }
  },
};
