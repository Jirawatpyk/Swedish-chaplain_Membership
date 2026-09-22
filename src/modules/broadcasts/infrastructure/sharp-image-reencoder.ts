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
 *
 * `failOn: 'error'` is kept, and it covers HARD errors only — libvips still
 * accepts input it can decode with warnings. It is a decode bound, not a
 * validity oracle; the MIME/format cross-check below is what refuses a file
 * whose declared type is a lie.
 */
import 'server-only';
import sharp from 'sharp';
import { err, ok, type Result } from '@/lib/result';
import type { ImageMimeType } from '../application/ports/image-storage-port';
import type {
  ImageReencodeError,
  ImageReencoderPort,
  ReencodedImage,
} from '../application/ports/image-reencoder-port';

/**
 * Decompression-bomb ceiling.
 *
 * ROUND-2 R-M4 / S-5 — 4096×4096 (16.7 Mpx), matching
 * `insights/infrastructure/logo/sharp-logo-adapter.ts`. The previous
 * 8192×8192 was 67 Mpx: at 4 bytes per pixel that is ~268 MB of decoded
 * surface for ONE upload, inside a serverless function that also holds the
 * original bytes and the output buffer. 16.7 Mpx still clears any camera a
 * member is likely to use.
 */
const LIMIT_INPUT_PIXELS = 4096 * 4096;

/**
 * ROUND-2 R-M4 — wall-clock bound on one re-encode. A decode with no bound can
 * pin the function for its whole `maxDuration` and take the member's request
 * with it; a bounded one fails as an outage the member can retry.
 */
const REENCODE_TIMEOUT_MS = 15_000;

/** Distinguishes "we gave up waiting" from anything libvips said. */
class ReencodeTimeoutError extends Error {
  constructor(ms: number) {
    super(`reencode timeout after ${ms}ms`);
    this.name = 'ReencodeTimeoutError';
  }
}

/**
 * ROUND-2 R-M3 — the messages libvips uses for input it cannot decode. A throw
 * matching this is ABOUT THE BYTES (415 + an unsafe audit row); anything else
 * is about US (503, no audit).
 *
 * `exceeds pixel limit` is in here deliberately: a decompression bomb is a
 * refusal of the input, and classing it as an outage would tell the caller to
 * retry an attack.
 */
const MALFORMED_INPUT =
  /unsupported image format|Input buffer contains unsupported image format|VipsJpeg|premature end|corrupt|Input file is missing|exceeds pixel limit/i;

/**
 * ROUND-3 #16 — a DEADLINE, not a cancellation.
 *
 * `Promise.race` settles the caller's promise; it cannot reach into libvips
 * and stop the decode. The worker thread keeps going until it finishes on its
 * own, still holding its memory, and the route has already answered 503. So
 * this bounds how long the MEMBER waits, not how much work the process does —
 * which matters because the retry they are invited to make starts a second
 * decode beside the first.
 *
 * What actually bounds the work is `limitInputPixels` (`LIMIT_INPUT_PIXELS`,
 * the 4096² cap) plus the 5 MB upload cap above it: they keep any single
 * decode small enough that the orphaned one drains quickly. Raising either
 * without revisiting this is how a decompression bomb turns into a memory
 * incident that the timeout hides rather than prevents.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReencodeTimeoutError(ms)), ms);
  });
  return Promise.race([p, bound]).finally(() => clearTimeout(timer));
}

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

async function doReencode(
  bytes: Uint8Array,
  mime: ImageMimeType,
): Promise<Result<ReencodedImage, ImageReencodeError>> {
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
  //
  // ROUND-2 S-5 — but NOT when the decode is animated. With `{ animated: true }`
  // libvips presents the frames as one tall strip, and `.rotate()` turns the
  // STRIP: an orientation tag on an animated WebP would produce a sideways,
  // smeared banner instead of a rotated animation. An animated image has no
  // meaningful orientation tag to honour, so skipping it loses nothing.
  const oriented = animated ? pipeline : pipeline.rotate();

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
}

export const sharpImageReencoder: ImageReencoderPort = {
  async reencode(bytes, mime) {
    try {
      return await withTimeout(doReencode(bytes, mime), REENCODE_TIMEOUT_MS);
    } catch (e) {
      // ROUND-2 R-M3 — classify. Only a message libvips uses for input it
      // cannot decode is the member's fault; everything else (OOM, a missing
      // native binding, our own timeout) is ours, and recording it as
      // `broadcast_image_unsafe` would put a false statement in the audit log.
      const reason = sanitiseReason(e);
      if (e instanceof ReencodeTimeoutError || !MALFORMED_INPUT.test(reason)) {
        return err({ kind: 'reencoder_unavailable', reason });
      }
      return err({ kind: 'decode_failed', reason });
    }
  },
};
