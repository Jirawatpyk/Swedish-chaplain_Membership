/**
 * T026 (F7.1a US2) — ClamAV endpoint resolver helper.
 *
 * Resolves `CLAMAV_HOST` for prod (`*.internal` Fly.io private) vs dev
 * (`localhost:3310` Docker) vs staging. Currently the env var carries
 * the full hostname so this helper is mostly a typed accessor + a
 * fail-closed reporter — kept as a separate file because critique E1
 * (round 2) flagged the need for a future-proof resolution layer when
 * Fly.io multi-region deploys land (selecting closest region for
 * latency).
 *
 * Used by T025 `clamav-virus-scanner.ts` + Phase 1 connectivity probe
 * (`scripts/verify-clamav-connectivity.ts`). Pure function — no
 * runtime side effects, no clamscan dep.
 *
 * Per Constitution Principle III: this file lives in Infrastructure
 * because it reads `env.clamav` (which is a normalised view of
 * `process.env`). The Application layer accesses ClamAV only via the
 * `VirusScannerPort` (T021).
 */

import { env } from '@/lib/env';

export type ClamavMode = 'production' | 'development' | 'staging';

export type ClamavEndpointResolution =
  | {
      readonly ok: true;
      readonly host: string;
      readonly port: number;
      readonly timeoutMs: number;
      readonly mode: ClamavMode;
    }
  | {
      readonly ok: false;
      readonly reason: 'unconfigured' | 'invalid_host';
      readonly detail: string;
    };

/**
 * Pure host → mode classifier. Exported separately so unit tests can
 * exercise every branch without env mocking (the env-aware
 * `resolveClamavEndpoint` is the thin wrapper consumers call).
 *
 *   `*.internal`             → production (Fly.io 6PN private DNS)
 *   `localhost` / `127.0.0.1` → development (Docker on dev workstation)
 *   anything else            → staging (explicit IP / custom DNS)
 */
export function classifyClamavMode(host: string): ClamavMode {
  if (host.endsWith('.internal')) return 'production';
  if (host === 'localhost' || host === '127.0.0.1') return 'development';
  return 'staging';
}

/**
 * Pure validity check — same exported separately for unit testability.
 * Returns true if the host string is a plausibly-reachable bare
 * hostname (no scheme/path/whitespace). Does NOT validate DNS
 * reachability — that's the runtime adapter's concern.
 */
export function isValidClamavHost(host: string): boolean {
  return !(host.includes('://') || host.includes(' ') || host.includes('/'));
}

/**
 * Resolve the ClamAV endpoint from env. Returns a tagged-union so the
 * caller can fail-closed on misconfiguration without throwing.
 *
 * Composition of `classifyClamavMode` + `isValidClamavHost` (above)
 * over the `env.clamav` block (Phase 1 T003). Phase 1's
 * connectivity-probe (`scripts/verify-clamav-connectivity.ts`) calls
 * the env directly rather than via this resolver — same end result.
 */
export function resolveClamavEndpoint(): ClamavEndpointResolution {
  const { host, port, timeoutMs } = env.clamav;

  if (!host) {
    return {
      ok: false,
      reason: 'unconfigured',
      detail: 'CLAMAV_HOST is empty; deploy clamav per infra/clamav/README.md',
    };
  }

  if (!isValidClamavHost(host)) {
    return {
      ok: false,
      reason: 'invalid_host',
      detail: `CLAMAV_HOST=${host} contains scheme/path/whitespace; expected bare hostname`,
    };
  }

  return {
    ok: true,
    host,
    port,
    timeoutMs,
    mode: classifyClamavMode(host),
  };
}
