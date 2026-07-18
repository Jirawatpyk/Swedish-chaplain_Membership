import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Load .env.local before defineConfig runs. Test files transitively
// import src/lib/env.ts which validates process.env at module-load
// time; by populating process.env here (in the config file's Node
// runtime, which runs before any test file is loaded) we guarantee the
// env.ts validation sees the secrets.
//
// 2026-05-22 CI fix: `process.loadEnvFile` THROWS `ENOENT` when the
// file is absent, and `?.` only guards an undefined function (Node <20)
// — NOT a missing file. CI runners have no `.env.local` (env comes from
// real `process.env` / GitHub secrets), so the bare call crashed the
// integration config at load time, failing the multi-tenant-readiness
// workflow before any test ran. Wrap in try/catch: load when present
// (local dev), fall back to the ambient `process.env` when absent (CI).
try {
  process.loadEnvFile?.('.env.local');
} catch {
  // No .env.local (CI / sandbox) — env vars come from process.env.
}

/**
 * Integration test configuration.
 *
 * Runs tests that require a real Postgres instance. CI sets DATABASE_URL
 * to a Docker-provided test database; local runs expect either the same
 * or a Neon branch.
 *
 * If DATABASE_URL is missing, integration tests are skipped via the
 * per-file guard in tests/integration/helpers/require-db.ts (NOT by
 * bypassing the suite — so the skip is visible in the output).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/integration-setup.ts'],
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'tests/unit/**', 'tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests touch a real DB — run sequentially to avoid flakes.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // HARD dependency (pinned explicit, not left to the default): a per-file
    // module-registry reset. Under `singleFork` all integration files share one
    // OS process. `isolate: true` resets the module registry between files —
    // it does NOT reset `process.env`. The void-on-reissue integration test
    // mutates process.env.FEATURE_VOID_ON_REISSUE in `vi.hoisted`; that file's
    // own `afterAll` deletes the var so it doesn't leak into later files in
    // the same fork. Do NOT set `isolate: false` — module-registry isolation
    // is still needed independent of the env concern.
    isolate: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      // K11: see vitest.config.ts for rationale — `server-only` is a
      // Next.js compile-time virtual module; stub it for Vitest.
      'server-only': resolve(__dirname, './tests/stubs/server-only.ts'),
    },
  },
});
