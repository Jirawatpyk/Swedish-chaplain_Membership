import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Unit test configuration (Vitest).
 *
 * Integration tests that hit a real database live in tests/integration/**
 * and are run via `pnpm test:integration` using vitest.integration.config.ts
 * so CI can skip them when DATABASE_URL is not set.
 *
 * Coverage thresholds match Constitution II + plan.md:
 *   - Domain layer: 100% lines (pure functions, no excuses)
 *   - Application layer: ≥80% lines + branches
 *   - Security-critical files: 100% branches
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/contract/**/*.test.ts'],
    exclude: [
      'node_modules',
      '.next',
      'tests/integration/**',
      'tests/e2e/**',
    ],
    // Raised from the 5s Vitest default because contract tests import
    // route handlers that transitively cold-load `@node-rs/argon2`
    // (native addon) + instantiate Upstash Redis clients at module
    // evaluation time. Under heavy parallel file load (~46 files on a
    // dev laptop), the serialized native-addon loader + HTTP client
    // construction can push a single `await import(...)` past the 5s
    // budget even though the test body itself is fully mocked and
    // finishes in <50 ms once imports resolve. 10s is comfortable
    // headroom without hiding genuinely slow tests. See QA
    // investigation notes in specs/002-membership-plans/qa/.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      include: ['src/modules/**/*.ts', 'src/lib/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/index.ts',
        'src/modules/**/infrastructure/db/schema.ts',
      ],
      thresholds: {
        // Global minimums (CI will fail on regression)
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,

        // Per-file overrides for security-critical paths
        'src/modules/auth/domain/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'src/modules/auth/application/sign-in.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/auth/application/sign-out.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/auth/application/change-password.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/auth/application/reset-password.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        // F2: Tenants cross-cutting Domain-only module — pure types,
        // constructor validator, branded types. 100% line coverage.
        'src/modules/tenants/domain/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        // F2: Plans Domain layer — 100% line coverage (pure functions).
        'src/modules/plans/domain/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        // F2: Plans Application layer — ≥80% line + 80% branch default,
        // 100% branch on security-critical use cases below.
        'src/modules/plans/application/update-plan.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/plans/application/clone-plans-to-year.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/plans/application/soft-delete-plan.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/plans/application/update-fee-config.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
