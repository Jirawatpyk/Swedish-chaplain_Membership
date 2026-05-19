/**
 * T025 (F7.1a US2) — ClamAV `VirusScannerPort` Infrastructure adapter.
 *
 * Wraps the `clamscan@^2.4` Node binding (Phase 1 dep) and talks to a
 * self-hosted `clamav/clamav:stable` daemon over TCP. In production
 * the daemon lives on Fly.io `sin` region (private 6PN network); in
 * dev it runs in Docker (`docker run -d -p 3310:3310 clamav/clamav:stable`).
 *
 * Configuration source: `env.clamav.*` block (Phase 1 T003).
 *   - `host`         empty → adapter returns `verdict: 'error', reason: 'unconfigured'`
 *   - `port`         default 3310
 *   - `timeoutMs`    default 300000 (5 min per FR-013)
 *   - `sharedSecret` ≥32 chars REQUIRED when `FEATURE_F71A_BROADCAST_ADVANCED=true`
 *                   (runtime guard here — kept out of zod schema per
 *                   Phase 1 T003 deviation rationale)
 *
 * Verdict mapping (FR-013):
 *   - clamscan `isInfected=true`  → `verdict: 'infected'`
 *   - clamscan `isInfected=false` → `verdict: 'clean'`
 *   - clamscan `isInfected=null`  (scan inconclusive) → `verdict: 'error'`
 *   - thrown `NodeClamError`      → `verdict: 'error'` or `'timeout'`
 *
 * The adapter NEVER throws — all failure modes surface as a typed
 * verdict so the calling use case (Phase 4 T071 `uploadInlineImage`)
 * can implement fail-closed handling without `try/catch` plumbing.
 *
 * Per Constitution Principle III (NON-NEGOTIABLE): the `clamscan`
 * import is restricted to this Infrastructure file (eslint.config.mjs
 * Phase 1 T009 forbidden-imports list). The use case sees only the
 * port interface (T021 `virus-scanner-port.ts`).
 */

import { Readable } from 'node:stream';
import NodeClam from 'clamscan';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import type {
  VirusScannerPort,
  VirusScanVerdict,
} from '../application/ports/virus-scanner-port';

type ScanStreamResult = {
  readonly isInfected: boolean | null;
  readonly viruses?: readonly string[];
};

interface NodeClamLike {
  scanStream(stream: Readable): Promise<ScanStreamResult>;
}

let scannerSingleton: Promise<NodeClamLike> | null = null;

/**
 * Lazy NodeClam init — single shared instance per process. We do NOT
 * init at module load because Phase 2 ships the adapter dark behind
 * `FEATURE_F71A_BROADCAST_ADVANCED=false`; eager init would attempt a
 * TCP connect at every process boot regardless of feature state.
 */
function getScanner(host: string, port: number, timeoutMs: number): Promise<NodeClamLike> {
  if (scannerSingleton) return scannerSingleton;
  scannerSingleton = (async (): Promise<NodeClamLike> => {
    const init = await new NodeClam().init({
      removeInfected: false,
      debugMode: false,
      clamdscan: {
        host,
        port,
        timeout: timeoutMs,
        localFallback: false,
      },
      preference: 'clamdscan',
    });
    return init as unknown as NodeClamLike;
  })();
  return scannerSingleton;
}

/**
 * Production `VirusScannerPort` adapter. The `makeXxxDeps` factory
 * pattern matches F7 MVP composition-root convention (Phase 3+ wires
 * this into the use case via `broadcasts-deps.ts`).
 */
export function makeClamavVirusScanner(): VirusScannerPort {
  return {
    async scan(content) {
      const start = performance.now();
      const { host, port, timeoutMs, sharedSecret } = env.clamav;

      // Fail-closed: empty host = adapter not configured. Phase 1
      // verify-clamav-connectivity.ts exits with code 2 for this
      // case; the use case translates this verdict to a generic
      // "image scanning unavailable" UX banner (Phase 4 T081).
      if (!host) {
        return {
          verdict: 'error',
          reason: 'unconfigured',
          durationMs: performance.now() - start,
        };
      }

      // Phase 1 T003 deferred this length guard to the adapter so
      // env.ts shape stays stable across the dark → live transition.
      // When master flag flips ON, sharedSecret < 32 chars is a
      // configuration bug — fail-closed at scan boundary.
      if (env.features.f71aBroadcastAdvanced && sharedSecret.length < 32) {
        logger.error(
          { sharedSecretLen: sharedSecret.length },
          'CLAMAV_SHARED_SECRET must be ≥32 chars when F7.1a master flag is ON',
        );
        return {
          verdict: 'error',
          reason: 'unconfigured',
          detail: 'shared_secret_too_short',
          durationMs: performance.now() - start,
        };
      }

      let scanner: NodeClamLike;
      try {
        scanner = await getScanner(host, port, timeoutMs);
      } catch (err) {
        return classifyError(err, performance.now() - start);
      }

      const stream =
        content instanceof Readable ? content : Readable.from(content);

      try {
        const result = await scanner.scanStream(stream);
        const durationMs = performance.now() - start;

        if (result.isInfected === true) {
          return {
            verdict: 'infected',
            signature: result.viruses?.[0] ?? 'unknown',
            durationMs,
          };
        }
        if (result.isInfected === false) {
          return { verdict: 'clean', durationMs };
        }
        // inconclusive — null verdict from daemon
        return {
          verdict: 'error',
          reason: 'daemon_error',
          detail: 'inconclusive_scan',
          durationMs,
        };
      } catch (err) {
        return classifyError(err, performance.now() - start);
      }
    },
  };
}

function classifyError(err: unknown, durationMs: number): VirusScanVerdict {
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  if (message.includes('timeout') || message.includes('etimedout')) {
    return { verdict: 'timeout', durationMs };
  }
  if (
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('ehostunreach')
  ) {
    return {
      verdict: 'error',
      reason: 'unreachable',
      detail: message,
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
