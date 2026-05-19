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

export type ClamavEndpointResolution =
  | {
      readonly ok: true;
      readonly host: string;
      readonly port: number;
      readonly timeoutMs: number;
      readonly mode: 'production' | 'development' | 'staging';
    }
  | {
      readonly ok: false;
      readonly reason: 'unconfigured' | 'invalid_host';
      readonly detail: string;
    };

/**
 * Resolve the ClamAV endpoint from env. Returns a tagged-union so the
 * caller can fail-closed on misconfiguration without throwing.
 *
 * Production heuristic: hostname ending in `.internal` (Fly.io 6PN
 * convention) → `mode: 'production'`.
 * Dev heuristic: hostname `localhost` or `127.0.0.1` → `mode: 'development'`.
 * Otherwise → `mode: 'staging'` (e.g., explicit IP or custom DNS).
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

  // Minimal sanity check — Postgres-style host validation isn't
  // appropriate here (we accept any reachable DNS name including
  // Fly.io's `*.internal`). Just reject obviously malformed values.
  if (host.includes('://') || host.includes(' ') || host.includes('/')) {
    return {
      ok: false,
      reason: 'invalid_host',
      detail: `CLAMAV_HOST=${host} contains scheme/path/whitespace; expected bare hostname`,
    };
  }

  const mode: 'production' | 'development' | 'staging' = host.endsWith('.internal')
    ? 'production'
    : host === 'localhost' || host === '127.0.0.1'
      ? 'development'
      : 'staging';

  return {
    ok: true,
    host,
    port,
    timeoutMs,
    mode,
  };
}
