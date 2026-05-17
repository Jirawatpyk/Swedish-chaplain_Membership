/**
 * R9 / B.3 — F6 perf-bench JSON-capture orchestrator.
 *
 * Runs all 4 F6 perf benches in sequence (parallelism risks Neon-pool
 * exhaustion on shared `ap-southeast-1` connections + skews timing
 * results), captures each script's stdout JSON, augments with run
 * metadata + SLO target comparison, and writes one aggregate JSON to:
 *
 *   specs/012-eventcreate-integration/perf-results/{env}-{YYYYMMDD-HHMMSS}.json
 *
 * Use cases:
 *   - Local baseline capture before pushing perf-sensitive changes
 *     (e.g., schema migration, hot-path refactor).
 *   - T152 staging-gate operator handoff — single command instead of
 *     5 manual stdout redirects (was the missing piece for ship-day).
 *   - CI gate (future) — exits non-zero if any bench misses its SLO,
 *     gateable in a `pnpm perf:f6:strict` script.
 *
 * Environment variables:
 *   - BENCH_ENV (default: 'local') — labels the output file + JSON.
 *     Set to 'staging' when running against staging Neon DB.
 *   - STRICT (default: 'false') — exits non-zero if any sloMet=false.
 *     Set to 'true' for CI gates.
 *   - All env vars required by individual scripts (DATABASE_URL,
 *     CRON_SECRET, etc.) — orchestrator passes through unchanged.
 *
 * Run:
 *   pnpm perf:f6                              # local baseline
 *   BENCH_ENV=staging STRICT=true pnpm perf:f6  # staging gate
 *
 * The 5th script `webhook-idempotency-soak.ts` is a SOAK/probe, not a
 * benchmark — it emits text-only output (not JSON) and runs against a
 * long-running test. It is intentionally EXCLUDED from this orchestrator
 * and should be run separately on a dedicated staging soak window.
 *
 * Why 0 new npm deps: Constitution Principle X (Simplicity) +
 * project memory `feedback_no_repeated_test_runs.md`. Uses Node
 * stdlib `child_process.spawnSync` + `fs`. Same pattern as the F8
 * cron-coordinator scripts.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface BenchSpec {
  /** Filename under `scripts/perf/` (excluding extension). */
  readonly script: string;
  /** Human-readable benchmark name (matches `report.bench` from script). */
  readonly bench: string;
  /** SLO target value (numeric — see field for unit). */
  readonly sloTargetValue: number;
  /** Unit for `sloTargetValue` (informational). */
  readonly sloTargetUnit: string;
  /**
   * Function that takes the script's stdout report object and returns
   * { observedValue, sloMet }. Per-script because each bench has a
   * different `sloMet` semantic (p95 latency vs heap peak vs match-rate).
   */
  readonly sloCheck: (report: Record<string, unknown>) => {
    observedValue: number | string;
    sloMet: boolean;
  };
}

/**
 * SLO target catalogue. Values mirror `docs/observability.md` § SLO
 * targets for F6. Update both files together if SLOs are renegotiated.
 */
const BENCHES: ReadonlyArray<BenchSpec> = [
  {
    script: 'eventcreate-webhook-ingest-latency',
    bench: 'webhook-ingest-latency',
    sloTargetValue: 300,
    sloTargetUnit: 'ms (p95)',
    sloCheck: (r) => ({
      observedValue: (r['p95Ms'] as number) ?? -1,
      sloMet: ((r['p95Ms'] as number) ?? Infinity) < 300,
    }),
  },
  {
    script: 'eventcreate-events-list-render',
    bench: 'events-list-render',
    sloTargetValue: 500,
    sloTargetUnit: 'ms (p95 @ 100 events)',
    sloCheck: (r) => ({
      observedValue: (r['p95Ms'] as number) ?? -1,
      sloMet: ((r['p95Ms'] as number) ?? Infinity) < 500,
    }),
  },
  {
    script: 'eventcreate-csv-import-memory',
    bench: 'csv-import-memory',
    sloTargetValue: 500,
    sloTargetUnit: 'MiB (peak heap @ 5k rows)',
    sloCheck: (r) => ({
      observedValue: 'see samples',
      sloMet: r['allUnderTarget'] === true,
    }),
  },
  {
    script: 'eventcreate-attendee-fuzzy-match',
    bench: 'attendee-fuzzy-match',
    sloTargetValue: 50,
    sloTargetUnit: 'ms (p95 per-match @ 500 members)',
    sloCheck: (r) => ({
      observedValue: (r['p95Ms'] as number) ?? -1,
      sloMet: ((r['p95Ms'] as number) ?? Infinity) < 50,
    }),
  },
];

interface BenchResult {
  readonly bench: string;
  readonly status: 'ok' | 'failed_to_run' | 'failed_to_parse';
  readonly sloTargetValue: number;
  readonly sloTargetUnit: string;
  readonly observedValue: number | string;
  readonly sloMet: boolean;
  readonly durationMs: number;
  readonly rawReport?: Record<string, unknown>;
  readonly errorMessage?: string;
}

interface AggregateReport {
  readonly runStartedAt: string;
  readonly runCompletedAt: string;
  readonly environment: string;
  readonly gitSha: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly results: ReadonlyArray<BenchResult>;
  readonly allSlosMet: boolean;
}

function captureGitSha(): string {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    return r.stdout?.trim() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function runBench(spec: BenchSpec): BenchResult {
  const startMs = Date.now();
  const scriptPath = path.join('scripts', 'perf', `${spec.script}.ts`);
  // R9.S1 security-review hardening — `shell: false` (default) instead
  // of `shell: true`. The script-path is currently hardcoded from the
  // BENCHES constant (no untrusted input), but disabling shell parsing
  // closes the attack surface for any future code change that might
  // introduce dynamic arguments. Defense-in-depth per Constitution X
  // (Simplicity — prefer the safer default).
  const r = spawnSync('pnpm', ['tsx', scriptPath], {
    encoding: 'utf8',
    shell: false,
    // The bench scripts may run long (idempotency-soak excluded);
    // give a generous 10-min ceiling per bench.
    timeout: 10 * 60 * 1000,
    env: process.env,
  });
  const durationMs = Date.now() - startMs;

  if (r.error || r.status === null || r.status !== 0) {
    return {
      bench: spec.bench,
      status: 'failed_to_run',
      sloTargetValue: spec.sloTargetValue,
      sloTargetUnit: spec.sloTargetUnit,
      observedValue: -1,
      sloMet: false,
      durationMs,
      errorMessage: `exit=${r.status} signal=${r.signal} ${
        r.error?.message ?? ''
      }\nstderr (last 2KB):\n${(r.stderr ?? '').slice(-2048)}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    // Scripts emit ONE pretty JSON to stdout — find the last `{` block.
    const stdout = (r.stdout ?? '').trim();
    const firstBrace = stdout.indexOf('{');
    if (firstBrace === -1) throw new Error('no JSON `{` found in stdout');
    parsed = JSON.parse(stdout.slice(firstBrace)) as Record<string, unknown>;
  } catch (e) {
    return {
      bench: spec.bench,
      status: 'failed_to_parse',
      sloTargetValue: spec.sloTargetValue,
      sloTargetUnit: spec.sloTargetUnit,
      observedValue: -1,
      sloMet: false,
      durationMs,
      errorMessage: `parse error: ${e instanceof Error ? e.message : String(e)}\nstdout (last 2KB):\n${(r.stdout ?? '').slice(-2048)}`,
    };
  }

  const { observedValue, sloMet } = spec.sloCheck(parsed);

  return {
    bench: spec.bench,
    status: 'ok',
    sloTargetValue: spec.sloTargetValue,
    sloTargetUnit: spec.sloTargetUnit,
    observedValue,
    sloMet,
    durationMs,
    rawReport: parsed,
  };
}

/**
 * Sanitise BENCH_ENV to prevent path-traversal in output filename.
 * R9.S1 security-review hardening — env vars are trusted in this
 * project's threat model (per security-review precedent), but
 * belt-and-braces: restrict to `[a-z0-9_-]+` (max 32 chars) so a
 * typo or shared-CI misconfig can't write JSON outside `perf-results/`.
 */
function sanitiseEnvLabel(raw: string | undefined): string {
  const v = (raw ?? 'local').replace(/[^a-z0-9_-]/gi, '_').slice(0, 32);
  return v.length > 0 ? v : 'local';
}

async function main(): Promise<void> {
  const environment = sanitiseEnvLabel(process.env['BENCH_ENV']);
  const strict = process.env['STRICT'] === 'true';
  const runStartedAt = new Date().toISOString();

  console.log(`[perf-orchestrator] environment=${environment} strict=${strict}`);
  console.log(`[perf-orchestrator] running ${BENCHES.length} benches...`);

  const results: BenchResult[] = [];
  for (const spec of BENCHES) {
    console.log(`\n[perf-orchestrator] >>> ${spec.bench} (${spec.script})`);
    const result = runBench(spec);
    console.log(
      `[perf-orchestrator] <<< ${spec.bench} status=${result.status} sloMet=${result.sloMet} duration=${result.durationMs}ms`,
    );
    if (result.status !== 'ok' && result.errorMessage) {
      console.error(`[perf-orchestrator] error: ${result.errorMessage}`);
    }
    results.push(result);
  }

  const runCompletedAt = new Date().toISOString();
  const allSlosMet = results.every((r) => r.sloMet);

  const aggregate: AggregateReport = {
    runStartedAt,
    runCompletedAt,
    environment,
    gitSha: captureGitSha(),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    results,
    allSlosMet,
  };

  // Emit aggregate JSON to perf-results/ — create dir if it does not
  // exist yet. File naming: `{env}-{timestamp}.json` so multiple runs
  // accumulate without overwrite + filesort yields chronological order.
  const outputDir = path.join(
    'specs',
    '012-eventcreate-integration',
    'perf-results',
  );
  mkdirSync(outputDir, { recursive: true });
  const timestamp = runStartedAt.replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outputDir, `${environment}-${timestamp}.json`);
  writeFileSync(outFile, JSON.stringify(aggregate, null, 2), 'utf8');

  console.log(`\n[perf-orchestrator] aggregate written: ${outFile}`);
  console.log(
    `[perf-orchestrator] allSlosMet=${allSlosMet} (${results.filter((r) => r.sloMet).length}/${results.length} benches met SLO)`,
  );

  if (strict && !allSlosMet) {
    console.error(
      `[perf-orchestrator] STRICT mode + SLO miss → exiting non-zero`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[perf-orchestrator] fatal:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
