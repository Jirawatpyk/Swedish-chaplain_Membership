/**
 * F119 review finding F2-3 — `ImageReencoderPort` sharp adapter.
 *
 * The ONLY place `sharp` is imported in the broadcasts module. `server-only`
 * hard-fails any client component that transitively imports it (sharp is a
 * native libvips binding). Mirrors `insights/infrastructure/logo/
 * sharp-logo-adapter.ts`, with two deliberate differences for this surface:
 *
 *   - NO resize. A logo is bounded to 800 px because it renders small; an
 *     inline E-Blast illustration is the member's own artwork and downscaling
 *     it would be a silent quality change they never asked for. The 5 MB cap
 *     is the bound here, re-checked by the caller on the OUTPUT bytes.
 *   - GIF is supported and its ANIMATION is preserved (`{ animated: true }`
 *     decodes every frame; without it sharp keeps frame 1 and a member's
 *     animated banner would silently freeze).
 *
 * Metadata: sharp drops EXIF / XMP / ICC / IPTC on re-encode unless
 * `keepMetadata()` / `withMetadata()` is called — which is precisely why
 * neither appears below. `.rotate()` with no argument reads the EXIF
 * orientation tag, BAKES that rotation into the pixels, and then drops the
 * tag, so stripping the metadata cannot leave the image sideways.
 *
 * `limitInputPixels` caps decode memory (decompression-bomb guard). The
 * caller has already had ClamAV pass the bytes before we decode them.
 */
import 'server-only';
import sharp from 'sharp';
import { err, ok } from '@/lib/result';
import type { ImageMimeType } from '../application/ports/image-storage-port';
import type { ImageReencoderPort } from '../application/ports/image-reencoder-port';

/** Decompression-bomb ceiling — generous for artwork, bounded for memory. */
const LIMIT_INPUT_PIXELS = 8192 * 8192;

/** What `sharp.metadata().format` reports, per accepted MIME. */
const EXPECTED_FORMAT: Record<ImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function sanitiseReason(raw: unknown): string {
  const s = raw instanceof Error ? raw.message : String(raw);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

export const sharpImageReencoder: ImageReencoderPort = {
  async reencode(bytes, mime) {
    try {
      // `animated` is harmless for the still formats and is what keeps a GIF
      // a GIF; WebP can be animated too, so it gets the same treatment.
      const animated = mime === 'image/gif' || mime === 'image/webp';
      const pipeline = sharp(Buffer.from(bytes), {
        limitInputPixels: LIMIT_INPUT_PIXELS,
        failOn: 'error',
        animated,
      });

      const meta = await pipeline.metadata();
      // Fail-closed on a MIME/content mismatch: the declared type is what the
      // allowlist, the blob key extension and the recipient's mail client all
      // act on, so a JPEG declared as image/png must not be stored as .png.
      if (meta.format !== EXPECTED_FORMAT[mime]) {
        return err({
          kind: 'decode_failed',
          reason: `declared ${mime} but decoded as ${String(meta.format ?? 'unknown')}`,
        });
      }

      // No resize, no `keepMetadata()` / `withMetadata()` → EXIF (incl. GPS),
      // XMP, IPTC and ICC are all dropped. `.rotate()` bakes the orientation
      // in first so dropping the tag cannot turn the picture on its side.
      const oriented = pipeline.rotate();

      let outBuf: Buffer;
      switch (mime) {
        case 'image/png':
          outBuf = await oriented.png({ compressionLevel: 9 }).toBuffer();
          break;
        case 'image/jpeg':
          outBuf = await oriented.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
          break;
        case 'image/webp':
          outBuf = await oriented.webp({ quality: 90 }).toBuffer();
          break;
        case 'image/gif':
          outBuf = await oriented.gif().toBuffer();
          break;
      }

      return ok({ bytes: new Uint8Array(outBuf), mime });
    } catch (e) {
      return err({ kind: 'decode_failed', reason: sanitiseReason(e) });
    }
  },
};
