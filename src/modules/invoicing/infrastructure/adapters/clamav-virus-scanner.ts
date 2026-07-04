/**
 * 088 US8 UX-B1 (T061e-1) — invoicing ClamAV `VirusScannerPort` adapter.
 *
 * A THIN adapter that reuses the F7.1a Fly.io ClamAV HTTPS scan-wrapper via
 * `env.clamav.{scanUrl,scanSecret,timeoutMs}` (NO new env var). It POSTs the
 * certificate bytes to the wrapper with a bearer token; the wrapper performs
 * the clamd INSTREAM scan and returns a JSON verdict.
 *
 * MODULE-BOUNDARY NOTE (Constitution Principle III): this is invoicing's OWN
 * adapter. It does NOT import the broadcasts `clamav-virus-scanner` (a
 * cross-module infrastructure deep-import banned by ESLint
 * `no-restricted-imports`). It shares ONLY `env.clamav.*` transport config with
 * the broadcasts adapter — a lib-level dependency, not a module coupling. The
 * two adapters intentionally duplicate the ~40-line wrapper protocol rather
 * than couple two bounded contexts.
 *
 * Configuration (`env.clamav.*`):
 *   - `scanUrl`    empty → `verdict:'error', reason:'unconfigured'` (fail-closed)
 *   - `scanSecret` bearer token presented to the wrapper
 *   - `timeoutMs`  AbortController deadline (default 50s)
 *
 * The adapter NEVER throws — every failure surfaces as a typed verdict so the
 * `upload-zero-rate-cert` use-case fails closed without try/catch plumbing.
 */
import { env } from '@/lib/env';
import type {
  VirusScannerPort,
  VirusScanVerdict,
} from '../../application/ports/virus-scanner-port';

/** Shape returned by the Fly scan-wrapper. All fields optional/untrusted. */
interface WrapperResponse {
  readonly verdict?: string;
  readonly signature?: string;
  readonly reason?: string;
}

/**
 * Production `VirusScannerPort` adapter. `makeXxx` factory matches the F4/F7
 * composition-root convention.
 */
export function makeClamavVirusScanner(): VirusScannerPort {
  return {
    async scan(bytes) {
      const start = performance.now();
      const { scanUrl, scanSecret, timeoutMs } = env.clamav;

      // Fail-closed: empty scan URL = adapter not configured. In dev the cert
      // scan is OPTIONAL (the cert NUMBER is the fail-closed gate), so a
      // rejected upload here is acceptable. Mirrors the broadcasts adapter's
      // empty-scanUrl → unconfigured contract.
      if (!scanUrl) {
        return {
          verdict: 'error',
          reason: 'unconfigured',
          durationMs: performance.now() - start,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // `fetch` BodyInit wants a Uint8Array backed by a (non-shared)
        // ArrayBuffer — a Node Buffer typed `ArrayBufferLike` under TS 5.7
        // does not match. `from` copies into a clean ArrayBuffer-backed array
        // (≤5 MB, cheap).
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
              // exactOptionalPropertyTypes: omit `detail` rather than setting it
              // to undefined when the wrapper gave no reason.
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
 * @internal Exported for unit tests. Classifies fetch/transport failures onto
 *   the port verdict union. `AbortError` (fetch timeout) → `timeout`;
 *   connection errors → `unreachable`; everything else → `unknown`.
 */
export function classifyError(err: unknown, durationMs: number): VirusScanVerdict {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message.toLowerCase() : '';
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
