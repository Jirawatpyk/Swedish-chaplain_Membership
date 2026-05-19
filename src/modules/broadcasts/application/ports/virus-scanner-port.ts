/**
 * T021 (F7.1a US2) — `VirusScannerPort` Application port.
 *
 * One-method contract for an external virus-scanning daemon. The
 * production adapter (T025 `clamav-virus-scanner.ts`) talks to a
 * self-hosted ClamAV (`clamav/clamav:stable`) over TCP on the Fly.io
 * 6PN private network; the Phase 1 connectivity probe lives at
 * `scripts/verify-clamav-connectivity.ts`.
 *
 * Verdict taxonomy (FR-013):
 *   - `clean`     — daemon scanned the bytes and found no signature match
 *   - `infected`  — signature DB matched; the use case MUST reject the upload
 *                   and emit `broadcast_image_unsafe` audit
 *   - `error`     — daemon unreachable / unconfigured / non-EICAR error.
 *                   The use case MUST treat as fail-closed (reject) per
 *                   FR-013 conservative posture (no quarantine bypass on
 *                   infra hiccups). When `CLAMAV_HOST` is empty, the
 *                   adapter returns `error` with `reason: 'unconfigured'`
 *                   (see Phase 1 `verify-clamav-connectivity.ts` exit
 *                   code 2 contract).
 *   - `timeout`   — scan exceeded `CLAMAV_TIMEOUT_MS` (default 300s).
 *                   Same fail-closed treatment as `error`.
 *
 * `durationMs` is captured for the `broadcasts.image_scan_duration_ms`
 * OTel metric (Phase 6 T122) and the SC-005 p95 budget (≤500ms for
 * files ≤2 MB).
 *
 * Pure interface — no framework imports (Constitution Principle III
 * NON-NEGOTIABLE). The ClamAV SDK (`clamscan` Node binding) lives in
 * Infrastructure only; ESLint `no-restricted-imports` enforces this
 * (see `eslint.config.mjs:30-39, 56-65` Phase 1 T009).
 */

import type { Readable } from 'node:stream';

export type VirusScanVerdict =
  | { readonly verdict: 'clean'; readonly durationMs: number }
  | {
      readonly verdict: 'infected';
      readonly signature: string;
      readonly durationMs: number;
    }
  | {
      readonly verdict: 'error';
      readonly reason:
        | 'unconfigured'
        | 'unreachable'
        | 'daemon_error'
        | 'unknown';
      readonly detail?: string;
      readonly durationMs: number;
    }
  | { readonly verdict: 'timeout'; readonly durationMs: number };

export interface VirusScannerPort {
  /**
   * Scan a byte buffer or readable stream for known signatures.
   *
   * @param content - Image bytes (≤5 MB per FR-012 cap, but the port
   *                  itself is content-agnostic — size enforcement
   *                  lives in `upload-inline-image.ts` use case T071).
   * @returns A verdict + duration. Never throws — all failure modes
   *          surface as a `verdict: 'error'` or `'timeout'` variant so
   *          the calling use case can decide fail-closed handling
   *          without `try/catch` plumbing.
   */
  scan(content: Buffer | Readable): Promise<VirusScanVerdict>;
}
