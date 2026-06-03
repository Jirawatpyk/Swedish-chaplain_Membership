/**
 * Run EVERY `RUN_PERF=1`-gated integration suite (the `describe.skipIf(!RUN_PERF)`
 * / `it.skipIf(!RUN_PERF)` branches only execute when this env flag is set).
 * Cross-platform wrapper (no cross-env dep) — spawns vitest with the env flag set.
 *
 * This is the go/no-go perf gate (`docs/go-live-readiness.md` § 7): a missed SLO
 * budget here fails the pipeline (exit code propagates). The list below is the
 * single registry of perf suites — every suite carrying a numeric p95/wall-clock
 * SLO CP MUST appear here, or its budget is silently never enforced. Keep it in
 * sync: a perf suite that exists but is absent from this list is a coverage hole
 * (the 2026-06-03 Stage-5 audit found 13 such un-wired suites across F3/F7/F8/F9).
 *
 * Invocation:
 *   pnpm test:perf
 *
 * CI wiring: add a nightly job that exports DATABASE_URL (live Neon
 * Singapore) + the other env vars from `.env.local.example`, then
 * `pnpm install && pnpm test:perf`. Exit code propagates so a missed
 * budget fails the pipeline.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, '..');

const perfSuites = [
  // --- F4 Invoicing (Phase 10) ---
  'tests/integration/invoicing/pdf-render-benchmark.test.ts', // T110  p95 < 800 ms
  'tests/integration/invoicing/invoice-list-perf.test.ts', //     T110a p95 < 500 ms @ 5k×2 rows
  'tests/integration/invoicing/seq-number-atomicity.test.ts', //  T111  50-writer concurrent seq < 30 s
  // --- F3 Members ---
  'tests/integration/members/search-perf.test.ts', //            SC-002 member search p95
  'tests/integration/members/timeline-perf.test.ts', //          member timeline p95
  // --- F5 async receipt PDF ---
  'tests/integration/perf/webhook-async-pdf-benchmark.test.ts', // webhook p95 (async receipt path)
  // --- F6 EventCreate ---
  'tests/integration/perf/csv-import-perf.test.ts', //           SC-006 CSV import 1k rows < 60 s + heap < 500 MiB
  // --- F7 Broadcasts ---
  'tests/integration/broadcasts/benefits-page-perf.test.ts', //  benefits page compose p95
  'tests/integration/broadcasts/snapshot-template-perf.test.ts', // template snapshot p95
  // --- F8 Renewals ---
  'tests/integration/perf/renewals-pipeline-perf.test.ts', //    SC-003 / FR-046 pipeline p95 < 500 ms
  'tests/integration/perf/renewals-cron-5k.test.ts', //          cron dispatch @ 5k members
  'tests/integration/renewals/pipeline-perf.test.ts', //         pipeline component p95
  'tests/integration/renewals/at-risk-recompute-perf.test.ts', // FR-036 / SC-005 at-risk recompute ≤ 60 s @ 5k
  'tests/integration/renewals/cron-dispatch-perf.test.ts', //    dispatch coordinator p95
  'tests/integration/renewals/renewal-confirm-perf.test.ts', //  member renewal-confirm p95
  'tests/integration/renewals/tier-upgrade-evaluate-perf.test.ts', // FR-057 tier-upgrade evaluate ≤ 30 s @ 5k
  // --- F9 Insights (Stage-5 audit 2026-06-03 — was missing, the documented gap) ---
  'tests/integration/insights/dashboard-perf.test.ts', //        SC-002 dashboard render p95 < 1.5 s @ 5k members
  'tests/integration/insights/audit-perf.test.ts', //            audit viewer p95 < 1 s @ 50k events
];

const child = spawn(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.integration.config.ts',
    '--passWithNoTests',
    ...perfSuites,
  ],
  {
    cwd: repoRoot,
    env: { ...process.env, RUN_PERF: '1' },
    stdio: 'inherit',
    // `shell: true` is REQUIRED on Windows: Node ≥ 18.20/20.12/22 refuses to
    // spawn a `.cmd`/`.bat` (`pnpm.cmd`) directly without a shell (CVE-2024-27980
    // mitigation) — `spawn('pnpm.cmd', …)` throws `EINVAL` on Node 22. Routing
    // through the shell lets it resolve `pnpm` via PATHEXT on win32 and via
    // `/bin/sh` on posix. Our argv is fixed (no spaces / no interpolation) so
    // shell quoting is not a concern.
    shell: true,
  },
);

child.on('error', (err) => {
  // Fires when spawn itself fails (e.g. `pnpm` not on PATH on a fresh
  // CI box). `exit` would otherwise fire with code=null and the poor
  // message would obscure the real cause.
  console.error('run-perf-tests: failed to spawn pnpm exec vitest:', err);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
