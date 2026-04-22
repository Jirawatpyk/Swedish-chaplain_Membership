/**
 * Run the F4 perf-gated integration suites with RUN_PERF=1 so the
 * `it.skipIf(!RUN_PERF)` branches actually execute. Cross-platform
 * wrapper (no cross-env dep) — spawns vitest with the env flag set.
 *
 * Included suites (Phase 10):
 *   - T110  pdf-render-benchmark.test.ts        (p95 < 800 ms budget)
 *   - T110a invoice-list-perf.test.ts           (p95 < 500 ms @ 5k×2 rows)
 *   - T111  seq-number-atomicity.test.ts        (50-writer concurrent seq, < 30 s)
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
  'tests/integration/invoicing/pdf-render-benchmark.test.ts',
  'tests/integration/invoicing/invoice-list-perf.test.ts',
  'tests/integration/invoicing/seq-number-atomicity.test.ts',
];

const child = spawn(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
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
  },
);

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
