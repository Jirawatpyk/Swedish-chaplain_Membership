/**
 * R19 — Image re-encode port (F4 / FR-034 logo upload).
 *
 * Abstracts the binary image decoder + re-encoder behind a port so that
 * `upload-tenant-logo.ts` (Application layer) stays free of direct
 * infrastructure library imports. Constitution Principle III (Clean
 * Architecture, NON-NEGOTIABLE) requires Application code to have zero
 * Infrastructure / framework / binary-lib imports; `sharp` is an I/O +
 * binary-codec library and therefore belongs strictly behind this port.
 *
 * The adapter (`sharp-image-reencode-adapter.ts`) wraps `sharp` with:
 *   - `limitInputPixels` — decompression-bomb guard
 *   - EXIF / metadata / ICC strip (sharp default when re-encoding)
 *   - Output format matching input: PNG → PNG (max compression),
 *     JPEG → JPEG (mozjpeg quality 85)
 *   - Detected-format drives encoder branch (NOT declared MIME) —
 *     prevents format-confusion attacks where declared MIME ≠ actual
 *
 * The Application use-case retains responsibility for:
 *   - MIME whitelist check on the declared field (fast-reject before
 *     invoking the decoder)
 *   - Size ceiling (1 MB)
 *   - Dimension bounds check (200×100 … 2000×500) — the PORT returns
 *     detected w/h; the use-case compares against the invariant
 *   - Detected-format whitelist (PNG/JPEG only — rejected otherwise)
 *
 * These are business rules, not decoder mechanics; keeping them in the
 * use-case lets the port stay pure-I/O and lets the test suite mock
 * the port without having to also duplicate validation logic.
 */

/**
 * Discriminated union on `format`. The `'unknown'` variant deliberately
 * omits `bytes` so that TypeScript narrowing makes it structurally
 * impossible to read a stale empty buffer downstream — callers MUST
 * narrow on `format` before accessing `bytes`. R20-01 hardening.
 */
export type ImageReEncodeResult =
  | {
      /** Actual decoded format — authoritative (declared MIME is advisory). */
      readonly format: 'png' | 'jpeg';
      /** Pixel dimensions of the decoded image. */
      readonly width: number;
      readonly height: number;
      /**
       * Re-encoded bytes stripped of EXIF/metadata/ICC. Always a
       * non-empty buffer on this variant — the adapter fails to
       * `decode_failed` rather than returning zero-length bytes.
       */
      readonly bytes: Uint8Array;
    }
  | {
      /**
       * Decoded successfully but NOT in the F4 format whitelist
       * (GIF / WebP / TIFF / AVIF / …). Callers MUST refuse via the
       * business-rule format whitelist in the use-case. No bytes are
       * returned — re-encoding to a supported format would mask a
       * category-error from the operator.
       */
      readonly format: 'unknown';
      readonly width: number;
      readonly height: number;
    };

export type ImageReEncodeError =
  /**
   * Decode failed outright (corrupt payload, unsupported format inside
   * the probe, decompression-bomb limit exceeded). The use-case maps
   * this to the public `decode_failed` error code.
   */
  | { readonly code: 'decode_failed'; readonly reason: string };

export interface ImageReEncodePort {
  /**
   * Probe + re-encode the supplied bytes. Returns the detected format,
   * dimensions, and stripped-metadata re-encoded bytes on success.
   *
   * The port does NOT know about MIME whitelist, size cap, or
   * dimension bounds — the Application use-case enforces those.
   * The port's only contract:
   *   - If the bytes can be decoded → return `{ format, width, height, bytes }`
   *   - If the bytes cannot be decoded → return `{ code: 'decode_failed', reason }`
   *
   * The adapter MUST enforce its own decompression-bomb guard
   * (`limitInputPixels` or equivalent) — the use-case trusts the port
   * to fail-fast on malicious payloads.
   */
  reencode(
    bytes: Uint8Array,
  ): Promise<{ ok: true; value: ImageReEncodeResult } | { ok: false; error: ImageReEncodeError }>;
}
