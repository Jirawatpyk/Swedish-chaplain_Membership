/**
 * ClamAV connectivity self-test (T007, F7.1a US2 dependency).
 *
 * Option D (2026-05-22): probes the HTTPS scan-wrapper
 * (`infra/clamav/scan-server.mjs`) at `env.clamav.scanUrl`, the same
 * transport the production adapter uses. Because it exercises the
 * public HTTPS endpoint, running this from a laptop OR from a Vercel
 * preview is a TRUE end-to-end reachability test (no `fly proxy`
 * tunnel needed anymore):
 *
 *   1. /healthz GET — fails fast if the wrapper/clamd is down.
 *   2. POST the canonical EICAR test signature → expect `infected`.
 *   3. POST an empty/clean buffer → expect `clean`.
 *   4. Latency benchmark — 5× clean POSTs, report p50/p95/p99 vs the
 *      SC-005 budget (p95 ≤ 500 ms for files ≤2 MB).
 *
 * Exits:
 *   0  all probes passed
 *   1  connectivity / scan failure
 *   2  not configured (empty CLAMAV_SCAN_URL) — distinct so callers can
 *      tell "scanner not deployed yet" from "scanner deployed but broken".
 *
 * Run: `pnpm verify:clamav`
 *
 * (Do NOT run via bare `pnpm tsx scripts/verify-clamav-connectivity.ts`
 * — that does NOT load `.env.local`, so `src/lib/env.ts` validation
 * fails on DATABASE_URL/RESEND_API_KEY/etc BEFORE the ClamAV probe.
 * The `verify:clamav` npm script wraps it with
 * `node --env-file=.env.local --import tsx`.)
 *
 * Required env (`.env.local` for dev, Vercel env for prod):
 *   CLAMAV_SCAN_URL=https://clamav-swecham.fly.dev/scan
 *   CLAMAV_SCAN_SECRET=<bearer token, matches the Fly app secret>
 *   CLAMAV_TIMEOUT_MS=50000   # optional
 *
 * Dev: build + run the wrapper image locally —
 *   docker build infra/clamav -t clamav-local
 *   docker run -d -p 8080:8080 -e CLAMAV_SCAN_SECRET=dev-secret-at-least-32-bytes-pad clamav-local
 *   CLAMAV_SCAN_URL=http://localhost:8080/scan
 */
import { env } from '../src/lib/env';

// EICAR Anti-Virus Test File — the canonical 68-byte string that every
// signature-based scanner must detect. NOT a real virus. Split into two
// literals so repo-side scanners don't flag this source file itself.
const EICAR_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}' + '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const LATENCY_SAMPLES = 5;
const SC_005_BUDGET_MS = 500;

interface ScanVerdict {
  readonly verdict?: string;
  readonly signature?: string;
  readonly reason?: string;
  readonly durationMs?: number;
}

function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q));
  return sortedAsc[idx] ?? 0;
}

async function scan(bytes: Buffer): Promise<ScanVerdict> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.clamav.timeoutMs);
  try {
    const resp = await fetch(env.clamav.scanUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.clamav.scanSecret}`,
        'content-type': 'application/octet-stream',
      },
      body: Uint8Array.from(bytes),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`wrapper returned HTTP ${resp.status}`);
    }
    return (await resp.json()) as ScanVerdict;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  if (!env.clamav.scanUrl) {
    console.error(
      '\n[verify-clamav] CLAMAV_SCAN_URL is empty.\n' +
        '  → Dev:  docker build infra/clamav -t clamav-local &&\n' +
        '          docker run -d -p 8080:8080 -e CLAMAV_SCAN_SECRET=dev-secret-at-least-32-bytes-pad clamav-local\n' +
        '          then set CLAMAV_SCAN_URL="http://localhost:8080/scan" + CLAMAV_SCAN_SECRET in .env.local.\n' +
        '  → Prod: deploy via infra/clamav/README.md and set\n' +
        '          CLAMAV_SCAN_URL="https://clamav-swecham.fly.dev/scan" + CLAMAV_SCAN_SECRET in Vercel env.\n',
    );
    process.exit(2);
  }
  if (!env.clamav.scanSecret) {
    console.error('[verify-clamav] CLAMAV_SCAN_SECRET is empty — wrapper will 401. Set it first.');
    process.exit(2);
  }

  const scanOrigin = new URL(env.clamav.scanUrl).origin;
  console.log(`[verify-clamav] target ${env.clamav.scanUrl} (timeout ${env.clamav.timeoutMs}ms)…`);

  // 1) /healthz — surfaces "daemon down" before we waste a scan.
  try {
    const health = await fetch(`${scanOrigin}/healthz`);
    if (!health.ok) {
      console.error(`[verify-clamav] /healthz returned HTTP ${health.status} — clamd not ready.`);
      process.exit(1);
    }
    console.log('[verify-clamav] healthz OK');
  } catch (err) {
    console.error('[verify-clamav] /healthz unreachable:', err);
    process.exit(1);
  }

  // 2) EICAR — must come back `infected`.
  try {
    const r = await scan(Buffer.from(EICAR_SIGNATURE, 'utf8'));
    if (r.verdict !== 'infected') {
      console.error(
        `[verify-clamav] FAIL: EICAR scanned as "${r.verdict}" (expected infected). ` +
          'Signature DB likely failed to load. Check fly logs for freshclam errors.',
      );
      process.exit(1);
    }
    console.log(`[verify-clamav] EICAR detected: ${r.signature ?? 'unknown'}`);
  } catch (err) {
    console.error('[verify-clamav] EICAR scan threw:', err);
    process.exit(1);
  }

  // 3) Clean buffer — must come back `clean`.
  try {
    const r = await scan(Buffer.from('hello chamber-os', 'utf8'));
    if (r.verdict !== 'clean') {
      console.error(`[verify-clamav] FAIL: clean buffer scanned as "${r.verdict}".`);
      process.exit(1);
    }
    console.log('[verify-clamav] clean scan OK');
  } catch (err) {
    console.error('[verify-clamav] clean scan threw:', err);
    process.exit(1);
  }

  // 4) Latency benchmark — observational, not a hard gate.
  const latencies: number[] = [];
  for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
    const t0 = performance.now();
    try {
      await scan(Buffer.from(`benchmark-${i}`, 'utf8'));
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

main().catch((err: unknown) => {
  console.error('[verify-clamav] unhandled error:', err);
  process.exit(1);
});
