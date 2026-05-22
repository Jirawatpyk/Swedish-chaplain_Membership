/**
 * T025 (F7.1a US2) — ClamAV `VirusScannerPort` Infrastructure adapter.
 *
 * Option D (2026-05-22): the app no longer talks raw TCP to clamd.
 * Fly.io's 6PN private network is IPv6-only and a Vercel serverless
 * function cannot join it, so clamd is fronted by a public HTTPS
 * scan-wrapper (`infra/clamav/scan-server.mjs`). This adapter POSTs the
 * image bytes to that wrapper with a bearer token; the wrapper performs
 * the clamd INSTREAM scan over localhost and returns a JSON verdict.
 * See specs/014-email-broadcast-advance/clamav-vercel-connectivity.md.
 *
 * Configuration (`env.clamav.*`, Phase 1 T003 + Option D additions):
 *   - `scanUrl`    empty → `verdict: 'error', reason: 'unconfigured'`
 *   - `scanSecret` bearer token presented to the wrapper
 *   - `timeoutMs`  AbortController deadline (default 50s)
 *
 * Verdict mapping (FR-013):
 *   - wrapper 200 {verdict:'clean'}            → clean
 *   - wrapper 200 {verdict:'infected',sig}     → infected
 *   - wrapper 200 {verdict:'error'|'timeout'}  → error/timeout (passthrough)
 *   - 401/403                                  → error/daemon_error (auth)
 *   - 413                                      → error/daemon_error (payload_too_large)
 *   - other non-2xx                            → error/daemon_error
 *   - fetch AbortError (timeout)               → timeout
 *   - network error (ECONNREFUSED/ENOTFOUND/…) → error/unreachable
 *
 * The adapter NEVER throws — every failure surfaces as a typed verdict
 * so the use case (`upload-inline-image.ts` T071) can fail-closed
 * without try/catch plumbing.
 *
 * Per Constitution Principle III: this Infrastructure adapter is the
 * only place that knows the wrapper transport. The use case sees only
 * the `VirusScannerPort` interface (T021). The `clamscan` npm dep is no
 * longer imported here (it moved into the Fly-side wrapper).
 */

import { Readable } from 'node:stream';

import { env } from '@/lib/env';
import type {
  VirusScannerPort,
  VirusScanVerdict,
} from '../application/ports/virus-scanner-port';

/** Defensive ceiling when buffering a Readable (use-case enforces 5 MB). */
const MAX_BUFFER_BYTES = 6 * 1024 * 1024;

/** Shape returned by `scan-server.mjs`. All fields optional/untrusted. */
interface WrapperResponse {
  readonly verdict?: string;
  readonly signature?: string;
  readonly reason?: string;
}

async function toBuffer(content: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(content)) return content;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of content) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > MAX_BUFFER_BYTES) {
      throw new Error('payload exceeds MAX_BUFFER_BYTES');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Production `VirusScannerPort` adapter. `makeXxx` factory matches the
 * F7 MVP composition-root convention (`broadcasts-deps.ts`).
 */
export function makeClamavVirusScanner(): VirusScannerPort {
  return {
    async scan(content) {
      const start = performance.now();
      const { scanUrl, scanSecret, timeoutMs } = env.clamav;

      // Fail-closed: empty scan URL = adapter not configured. The use
      // case (T081) maps this to the "image scanning unavailable" UX
      // banner. Mirrors the old empty-CLAMAV_HOST exit-code-2 contract.
      if (!scanUrl) {
        return {
          verdict: 'error',
          reason: 'unconfigured',
          durationMs: performance.now() - start,
        };
      }

      let bytes: Buffer;
      try {
        bytes = await toBuffer(content);
      } catch (err) {
        return classifyError(err, performance.now() - start);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // `fetch` BodyInit wants a Uint8Array backed by a (non-shared)
        // ArrayBuffer — a Node Buffer (or a view over `bytes.buffer`,
        // typed `ArrayBufferLike` under TS 5.7) does not match. `from`
        // copies into a clean ArrayBuffer-backed array (≤5 MB, cheap).
        const reqBody = Uint8Array.from(bytes);
        const resp = await fetch(scanUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${scanSecret}`,
            'content-type': 'application/octet-stream',
          },
          body: reqBody,
          signal: controller.signal,
        });
        const durationMs = performance.now() - start;

        if (resp.status === 401 || resp.status === 403) {
          return { verdict: 'error', reason: 'daemon_error', detail: 'auth', durationMs };
        }
        if (resp.status === 413) {
          return {
            verdict: 'error',
            reason: 'daemon_error',
            detail: 'payload_too_large',
            durationMs,
          };
        }
        if (!resp.ok) {
          return {
            verdict: 'error',
            reason: 'daemon_error',
            detail: `http_${resp.status}`,
            durationMs,
          };
        }

        const body = (await resp.json().catch(() => ({}))) as WrapperResponse;
        switch (body.verdict) {
          case 'clean':
            return { verdict: 'clean', durationMs };
          case 'infected':
            return {
              verdict: 'infected',
              signature: body.signature ?? 'unknown',
              durationMs,
            };
          case 'timeout':
            return { verdict: 'timeout', durationMs };
          case 'error':
            return {
              verdict: 'error',
              reason: normalizeReason(body.reason),
              // exactOptionalPropertyTypes: omit `detail` rather than
              // setting it to undefined when the wrapper gave no reason.
              ...(body.reason !== undefined ? { detail: body.reason } : {}),
              durationMs,
            };
          default:
            return {
              verdict: 'error',
              reason: 'daemon_error',
              detail: `unexpected_verdict:${String(body.verdict)}`,
              durationMs,
            };
        }
      } catch (err) {
        return classifyError(err, performance.now() - start);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Map a wrapper-supplied `reason` string onto the port's reason union. */
function normalizeReason(
  reason: string | undefined,
): 'unconfigured' | 'unreachable' | 'daemon_error' | 'unknown' {
  switch (reason) {
    case 'unconfigured':
    case 'unreachable':
    case 'daemon_error':
      return reason;
    default:
      return 'daemon_error';
  }
}

/**
 * @internal Exported for unit tests
 *   (tests/unit/broadcasts/infrastructure/clamav-virus-scanner.test.ts).
 *   NOT part of the broadcasts barrel. Classifies fetch/transport
 *   failures onto the port verdict union. `AbortError` (fetch timeout)
 *   → `timeout`; connection errors → `unreachable`; everything else →
 *   `unknown`.
 */
export function classifyError(err: unknown, durationMs: number): VirusScanVerdict {
  // fetch() aborts (timeout) throw a DOMException/Error named 'AbortError'.
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  // Node fetch wraps the underlying cause; inspect it too.
  const causeCode =
    err instanceof Error && err.cause && typeof err.cause === 'object' && 'code' in err.cause
      ? String((err.cause as { code?: unknown }).code).toLowerCase()
      : '';

  if (name === 'AbortError' || message.includes('timeout') || message.includes('etimedout')) {
    return { verdict: 'timeout', durationMs };
  }
  if (
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('ehostunreach') ||
    message.includes('econnreset') ||
    message.includes('fetch failed') ||
    causeCode.includes('econnrefused') ||
    causeCode.includes('enotfound') ||
    causeCode.includes('ehostunreach') ||
    causeCode.includes('econnreset')
  ) {
    return {
      verdict: 'error',
      reason: 'unreachable',
      detail: causeCode || message,
      durationMs,
    };
  }
  return {
    verdict: 'error',
    reason: 'unknown',
    detail: err instanceof Error ? err.message : String(err),
    durationMs,
  };
}
