/**
 * F9 US5 `LogoImagePort` sharp adapter (T079 / FR-025a).
 *
 * The ONLY place `sharp` is imported in the insights module. `server-only`
 * hard-fails any client component that transitively imports it (sharp is a
 * native libvips dep). Re-encoding strips EXIF/XMP/ICC by default (no
 * `.withMetadata()`); `.rotate()` auto-orients from EXIF then drops it; the
 * resize bounds output dimensions; `limitInputPixels` guards decompression
 * bombs. PNG/JPEG/WebP only — anything else is `unsupported_format`.
 */
import 'server-only';
import sharp from 'sharp';
import { ok, err } from '@/lib/result';
import type {
  LogoContentType,
  LogoFormat,
  LogoImagePort,
} from '../../application/ports/logo-port';

/** Decompression-bomb ceiling (≫ the bounded output, but caps decode memory). */
const LIMIT_INPUT_PIXELS = 4096 * 4096;
/** Bounded output edge — logos render small in the E-Book / directory. */
const MAX_DIMENSION = 800;

const CONTENT_TYPE: Record<LogoFormat, LogoContentType> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function sanitiseReason(raw: unknown): string {
  const s = raw instanceof Error ? raw.message : String(raw);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

export const sharpLogoAdapter: LogoImagePort = {
  async reencode(bytes) {
    try {
      const pipeline = sharp(Buffer.from(bytes), {
        limitInputPixels: LIMIT_INPUT_PIXELS,
        failOn: 'error',
      });
      const meta = await pipeline.metadata();
      const fmt = meta.format;
      if (fmt !== 'png' && fmt !== 'jpeg' && fmt !== 'webp') {
        return err({ code: 'unsupported_format' });
      }

      // .rotate() auto-orients from EXIF then strips it; resize bounds the edge
      // (never enlarges). No .withMetadata() → EXIF/XMP/ICC dropped.
      const bounded = pipeline
        .rotate()
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true });

      let outBuf: Buffer;
      if (fmt === 'png') outBuf = await bounded.png({ compressionLevel: 9 }).toBuffer();
      else if (fmt === 'jpeg') outBuf = await bounded.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      else outBuf = await bounded.webp({ quality: 85 }).toBuffer();

      const outMeta = await sharp(outBuf).metadata();
      return ok({
        bytes: new Uint8Array(outBuf),
        contentType: CONTENT_TYPE[fmt],
        format: fmt,
        width: outMeta.width ?? 0,
        height: outMeta.height ?? 0,
      });
    } catch (e) {
      return err({ code: 'decode_failed', reason: sanitiseReason(e) });
    }
  },
};
