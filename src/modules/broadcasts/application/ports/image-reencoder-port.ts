/**
 * F119 review finding F2-3 — `ImageReencoderPort`: strip embedded metadata
 * from member-uploaded inline images before a single byte reaches storage.
 *
 * WHY this port exists. An inline E-Blast image is written to a PUBLIC Vercel
 * Blob URL and then served, unauthenticated, to every recipient of the
 * broadcast (a mail client cannot present a session cookie, so the tier has to
 * be public). A photo taken on a phone carries an EXIF block, and that block
 * routinely carries GPS co-ordinates, the capture timestamp and the device
 * serial — i.e. the location of the member's office, published to an audience
 * and to anyone who later obtains the URL. Nothing downstream removes it: the
 * MIME allowlist reads the declared type, ClamAV looks for signatures, and the
 * storage adapter writes the bytes it is handed.
 *
 * The precedent is already in this repo — `tenant-invoice-settings/logo` and
 * `sharp-logo-adapter` re-encode through `sharp` for exactly this reason. The
 * E-Blast path is the one image surface that did not.
 *
 * PIPELINE POSITION (enforced in `upload-inline-image.ts`):
 *   …ClamAV verdict = 'clean'  →  reencode  →  sha256 + byte_size  →  put
 * AFTER the scan, because a re-encoder is an image DECODER and must never be
 * pointed at unscanned bytes. BEFORE the hash, because the hash is the dedup
 * key and the blob key — hashing the input would key the store on bytes that
 * were never stored, so a second upload of the same photo would miss the
 * dedup and orphan a blob.
 *
 * Pure interface — no framework imports (Constitution Principle III). The
 * `sharp` dependency lives only in the Infrastructure adapter.
 */
import type { Result } from '@/lib/result';
import type { ImageMimeType } from './image-storage-port';

export interface ReencodedImage {
  /** The re-encoded bytes — this is what gets hashed, sized and stored. */
  readonly bytes: Uint8Array;
  /**
   * The MIME type of the OUTPUT. The adapter re-encodes to the same family it
   * decoded, so this normally equals the input; it is returned explicitly so
   * the caller never has to assume that.
   */
  readonly mime: ImageMimeType;
}

/**
 * ROUND-2 R-M3 — TWO kinds, because they are two different events and they
 * were being recorded as one.
 *
 * Everything the adapter threw used to come back as `decode_failed`, and the
 * caller answers that with a 415 plus a `broadcast_image_unsafe
 * { reason: 'reencode_failed' }` audit row. A libvips OOM, a missing native
 * binding or a hung decode is a SERVER fault, and writing it down as "the
 * member uploaded something unsafe" is the audit-truth class this repo guards
 * elsewhere: a row must not state something its subject did not do. It also
 * gave the member a permanent 415 for a transient outage.
 */
export type ImageReencodeError =
  | {
      /**
       * The bytes could not be decoded as an image at all (a renamed
       * executable, a truncated upload, a decompression bomb over the pixel
       * ceiling, a format `sharp` was not built with). Fail-closed: the caller
       * refuses the upload rather than storing bytes whose metadata it could
       * not inspect. This IS about the input, so it is the member's answer:
       * 415, and a security-relevant audit row.
       */
      readonly kind: 'decode_failed';
      /** Bounded, already-truncated reason for the log — never raw user content. */
      readonly reason: string;
    }
  | {
      /**
       * The re-encoder could not run: out of memory, native binding missing,
       * or the decode exceeded its wall-clock bound. Nothing is known about the
       * bytes. The caller answers 503 (`storage_unavailable`-class) and emits
       * NO unsafe audit — there is no evidence of anything unsafe.
       */
      readonly kind: 'reencoder_unavailable';
      /** Bounded, already-truncated reason for the log — never raw user content. */
      readonly reason: string;
    };

export interface ImageReencoderPort {
  reencode(
    bytes: Uint8Array,
    mime: ImageMimeType,
  ): Promise<Result<ReencodedImage, ImageReencodeError>>;
}
