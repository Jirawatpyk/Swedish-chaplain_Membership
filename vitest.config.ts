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
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
