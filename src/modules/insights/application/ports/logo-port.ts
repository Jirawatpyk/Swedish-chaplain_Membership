/**
 * F9 US5 logo pipeline ports (T079 / FR-025a).
 *
 * `LogoImagePort` — server-side re-encode + EXIF/metadata strip + dimension
 * bound (the original upload is NEVER served). `LogoStorePort` — public Blob
 * delivery (the re-encoded logo appears in published outputs, so it must be
 * servable; unlike the private export artefacts, it carries no hidden PII).
 *
 * Pure interfaces — no `sharp`/`@vercel/blob` import (Constitution Principle III).
 */
import type { Result } from '@/lib/result';

export type LogoFormat = 'png' | 'jpeg' | 'webp';
export type LogoContentType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface LogoReencodeResult {
  readonly bytes: Uint8Array;
  readonly contentType: LogoContentType;
  readonly format: LogoFormat;
  readonly width: number;
  readonly height: number;
}

export type LogoReencodeError =
  | { readonly code: 'unsupported_format' }
  | { readonly code: 'decode_failed'; readonly reason: string };

export interface LogoImagePort {
  /**
   * Decode → strip metadata (EXIF/XMP/ICC) → auto-orient → bound dimensions →
   * re-encode to the SAME safe raster format. Rejects non-image / unsupported
   * payloads so the use-case's allow-list invariant holds against the actual
   * bytes (not just the declared MIME).
   */
  reencode(bytes: Uint8Array): Promise<Result<LogoReencodeResult, LogoReencodeError>>;
}

export interface LogoStorePort {
  /** Upload the re-encoded logo to PUBLIC Blob; returns the servable URL. */
  putPublicLogo(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: LogoContentType;
  }): Promise<{ readonly url: string }>;

  /** Delete a previously-stored logo by its URL/key. Idempotent. */
  deleteLogo(urlOrKey: string): Promise<void>;
}
