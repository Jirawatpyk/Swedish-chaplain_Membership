/**
 * ClamAV connectivity self-test (T007, F7.1a US2 dependency).
 *
 * Smoke-tests the clamd daemon reachable at `env.clamav.host:port`:
 *
 *   1. PING the daemon — fails fast if the socket is unreachable.
 *   2. Scan the canonical EICAR test signature → expect verdict
 *      `infected` with virus name containing "EICAR". Confirms the
 *      signature DB is loaded and pattern-matching works end-to-end.
 *   3. Scan an empty buffer → expect verdict `clean`. Confirms the
 *      clean path doesn't false-positive.
 *   4. Latency benchmark — 5× clean-buffer scans, report p50/p95/p99.
 *      Provides a baseline against the SC-005 budget (p95 ≤ 500 ms
 *      for files ≤2 MB) for the operator to compare on ship-day.
 *
 * Exits non-zero on the first failure so CI / pre-deploy checks can
 * gate on this script. Intentionally single-file with one runtime
 * dependency (`clamscan`); no test framework — keeps the cold-path
 * overhead low when the ship-day operator runs this manually.
 *
 * Run: `pnpm verify:clamav`
 *
 * (Do NOT run via bare `pnpm tsx scripts/verify-clamav-connectivity.ts`
 * — that does NOT load `.env.local`, so `src/lib/env.ts` validation
 * fails on DATABASE_URL/RESEND_API_KEY/etc BEFORE the ClamAV probe.
 * The `verify:clamav` npm script wraps it with
 * `node --env-file=.env.local --import tsx`. Fixed 2026-05-22.)
 *
 * Required env (`.env.local`):
 *   CLAMAV_HOST=localhost     # dev Docker, or "<app>.internal" on Fly.io
 *   CLAMAV_PORT=3310
 *   CLAMAV_TIMEOUT_MS=300000
 *
 * Empty CLAMAV_HOST exits with a clear "feature not configured"
 * message and exit code 2 (distinct from connectivity failure exit
 * code 1) so callers can distinguish "scanner not deployed yet" from
 * "scanner deployed but broken".
 */
import NodeClam from 'clamscan';

import { env } from '../src/lib/env';

// EICAR Anti-Virus Test File — the canonical 68-byte string that
// every signature-based scanner is required to detect. NOT a real
// virus. https://www.eicar.org/download-anti-malware-testfile/
// Split into two literals so editor/repo-side virus scanners do not
// flag this source file itself as containing the EICAR signature.
const EICAR_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}' + '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const LATENCY_SAMPLES = 5;
const SC_005_BUDGET_MS = 500;

function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q));
  return sortedAsc[idx] ?? 0;
}

async function main(): Promise<void> {
  if (!env.clamav.host) {
    console.error(
      '\n[verify-clamav] CLAMAV_HOST is empty.\n' +
        '  → Dev: run `docker run -d -p 3310:3310 clamav/clamav:stable`\n' +
        '         then set CLAMAV_HOST="localhost" in .env.local.\n' +
        '  → Prod: deploy via infra/clamav/README.md § Deploy and set\n' +
        '         CLAMAV_HOST="clamav-swecham.internal" in Vercel env.\n',
    );
    process.exit(2);
  }

  console.log(
    `[verify-clamav] connecting to ${env.clamav.host}:${env.clamav.port} ` +
      `(timeout ${env.clamav.timeoutMs}ms)…`,
  );

  // Construct + init NodeClam against the configured TCP endpoint.
  // We intentionally do NOT pass `clamscan.path` (the local binary
  // fallback) — Chamber-OS only talks to clamd over TCP. Falling back
  // to a local binary would mask a missing Fly deploy.
  let scanner: NodeClam;
  try {
    scanner = await new NodeClam().init({
      removeInfected: false,
      debugMode: false,
      clamdscan: {
        host: env.clamav.host,
        port: env.clamav.port,
        timeout: env.clamav.timeoutMs,
        localFallback: false,
      },
      preference: 'clamdscan',
    });
  } catch (err) {
    console.error('[verify-clamav] init failed:', err);
    process.exit(1);
  }

  // 1) PING — surfaces "daemon down" before we waste a scan attempt.
  try {
    await scanner.ping();
    console.log('[verify-clamav] ping OK');
  } catch (err) {
    console.error('[verify-clamav] ping failed:', err);
    process.exit(1);
  }

  // 2) EICAR — must come back `infected` with a signature name. If a
  // scanner returns `clean` for EICAR, the signature DB never loaded.
  try {
    const eicarStream = bufferToStream(Buffer.from(EICAR_SIGNATURE, 'utf8'));
    const { isInfected, viruses } = await scanner.scanStream(eicarStream);
    if (!isInfected) {
      console.error(
        '[verify-clamav] FAIL: EICAR test signature scanned as clean. ' +
          'Signature DB likely failed to load. Check fly logs for `freshclam` errors.',
      );
      process.exit(1);
    }
    console.log(`[verify-clamav] EICAR detected: ${viruses.join(', ')}`);
  } catch (err) {
    console.error('[verify-clamav] EICAR scan threw:', err);
    process.exit(1);
  }

  // 3) Clean buffer — must come back `clean`. False positive here
  // would indicate signature corruption or a wildcard rule.
  try {
    const cleanStream = bufferToStream(Buffer.from('hello chamber-os', 'utf8'));
    const { isInfected } = await scanner.scanStream(cleanStream);
    if (isInfected) {
      console.error('[verify-clamav] FAIL: clean buffer scanned as infected.');
      process.exit(1);
    }
    console.log('[verify-clamav] clean scan OK');
  } catch (err) {
    console.error('[verify-clamav] clean scan threw:', err);
    process.exit(1);
  }

  // 4) Latency benchmark — clean buffer ×5. Skipped if any sample
  // throws; we still consider the connectivity probe a pass because
  // the daemon answered (1)+(2)+(3) successfully. The benchmark is
  // observational, not a hard gate.
  const latencies: number[] = [];
  for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
    const t0 = performance.now();
    try {
      const stream = bufferToStream(Buffer.from(`benchmark-${i}`, 'utf8'));
      await scanner.scanStream(stream);
      latencies.push(performance.now() - t0);
    } catch (err) {
      console.warn(`[verify-clamav] latency sample ${i + 1} threw (continuing):`, err);
    }
  }
  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);
    const p95 = quantile(sorted, 0.95);
    const p99 = quantile(sorted, 0.99);
    const tail =
      p95 > SC_005_BUDGET_MS
        ? `⚠ p95 exceeds SC-005 budget (${SC_005_BUDGET_MS} ms)`
        : '✓ within SC-005 budget';
    console.log(
      `[verify-clamav] latency over ${latencies.length} samples: ` +
        `p50=${p50.toFixed(1)}ms · p95=${p95.toFixed(1)}ms · p99=${p99.toFixed(1)}ms — ${tail}`,
    );
  }

  console.log('[verify-clamav] all probes passed.');
  process.exit(0);
}

import { Readable } from 'node:stream';

function bufferToStream(buf: Buffer): Readable {
  return Readable.from(buf);
}

main().catch((err: unknown) => {
  console.error('[verify-clamav] unhandled error:', err);
  process.exit(1);
});
