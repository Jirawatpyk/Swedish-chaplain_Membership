/**
 * T181 (Phase 9 / perf.md CHK065) — F7 synthetic load script.
 *
 * Issues real HTTP requests against a target URL + asserts SC-010 / Q6
 * p95 budgets. Designed to run from CI on every PR (post deploy-preview)
 * and locally for ad-hoc perf investigations.
 *
 * Usage:
 *   pnpm tsx scripts/synthetic-load-broadcasts.ts \
 *     --target https://chamber-os-pr-99.vercel.app \
 *     --iterations 50
 *
 * Or via env:
 *   SYNTHETIC_LOAD_TARGET_URL=http://localhost:3100 pnpm tsx scripts/synthetic-load-broadcasts.ts
 *
 * Critical paths probed (read-only — no mutation, no auth required):
 *   1. /                            (homepage TTFB — sanity baseline)
 *   2. /forgot-password             (auth public surface — Tiptap-free baseline)
 *   3. /unsubscribe/probe-invalid   (SLO-F7-006 < 400 ms; intentionally
 *                                    invalid token to exercise the
 *                                    invalid-fallback render path; the
 *                                    page MUST still TTFB-budget)
 *
 * Authenticated paths (compose / submit / queue / approve) require
 * session + tenant fixtures and are skipped by the public-script
 * variant — they are exercised by the JCC-test-tenant fixture (T179).
 *
 * PR fails when any p95 exceeds budget × TOLERANCE (10% headroom).
 */

interface Probe {
  readonly slo: string;
  readonly path: string;
  readonly p95Ms: number;
  readonly url: string;
}

const TOLERANCE = 1.1; // CHK065: 10% headroom before PR fails
const ITERATIONS_DEFAULT = 30;

interface ParsedArgs {
  readonly target: string;
  readonly iterations: number;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
  };
  return {
    target: get('--target', process.env.SYNTHETIC_LOAD_TARGET_URL ?? ''),
    iterations: Number(get('--iterations', String(ITERATIONS_DEFAULT))),
  };
}

function p95(samples: ReadonlyArray<number>): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx]!;
}

function p50(samples: ReadonlyArray<number>): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function probeOnce(url: string): Promise<number> {
  const t0 = Date.now();
  // Discard body — we measure server response time. `redirect: 'manual'`
  // so 30x landing pages don't pollute TTFB with the redirected fetch.
  await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'user-agent': 'chamber-os-synthetic-load/1.0' },
  }).catch(() => undefined);
  return Date.now() - t0;
}

async function runProbe(probe: Probe, iterations: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    samples.push(await probeOnce(probe.url));
  }
  return samples;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.target === '') {
    console.error(
      'synthetic-load: SYNTHETIC_LOAD_TARGET_URL or --target required',
    );
    process.exitCode = 2;
    return;
  }

  const base = args.target.replace(/\/$/, '');
  const probes: ReadonlyArray<Probe> = [
    {
      slo: 'baseline',
      path: 'homepage',
      p95Ms: 1500,
      url: `${base}/`,
    },
    {
      slo: 'baseline',
      path: 'forgot-password',
      p95Ms: 1500,
      url: `${base}/forgot-password`,
    },
    {
      slo: 'SLO-F7-006',
      path: 'unsubscribe-invalid-token',
      p95Ms: 400,
      url: `${base}/unsubscribe/v1.invalid.invalid`,
    },
  ];

  console.log(
    `synthetic-load: target=${base} iterations=${args.iterations} probes=${probes.length}`,
  );

  let breached = false;
  for (const probe of probes) {
    const samples = await runProbe(probe, args.iterations);
    const p95Observed = p95(samples);
    const p50Observed = p50(samples);
    const ceiling = probe.p95Ms * TOLERANCE;
    const ok = p95Observed <= ceiling;
    if (!ok) breached = true;
    console.log(
      `[${probe.slo}] ${probe.path}: p50=${p50Observed}ms p95=${p95Observed}ms (budget=${probe.p95Ms}ms ceiling=${ceiling}ms) n=${samples.length} ${ok ? 'OK' : 'BREACH'}`,
    );
  }

  if (breached) {
    console.error('synthetic-load: one or more p95 budgets exceeded');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('synthetic-load: fatal', err);
  process.exitCode = 1;
});
