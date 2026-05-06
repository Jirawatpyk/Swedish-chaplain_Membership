import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Load .env.local before defineConfig runs. Test files transitively
// import src/lib/env.ts which validates process.env at module-load
// time; by populating process.env here (in the config file's Node
// runtime, which runs before any test file is loaded) we guarantee the
// env.ts validation sees the secrets.
process.loadEnvFile?.('.env.local');

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
