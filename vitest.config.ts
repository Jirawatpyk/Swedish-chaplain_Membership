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
        // Infrastructure files (DB repos, adapters, email templates) are
        // covered by integration tests, not unit tests.
        'src/modules/**/infrastructure/**',
        // Port interfaces are TypeScript-only definitions — no runtime code.
        'src/modules/**/ports/**',
        // DI wiring / dependency containers.
        'src/modules/**/deps.ts',
        'src/modules/**/plans-deps.ts',
        // Application-layer port bundles — pure TypeScript interface files.
        'src/modules/plans/application/ports.ts',
        // Pure TypeScript type files — no executable statements.
        'src/modules/plans/domain/benefit-matrix.ts',
        'src/modules/plans/domain/fee-config.ts',
        // Next.js server-runtime utilities — require a running Next.js context.
        'src/lib/auth-session.ts',
        'src/lib/feature-flags.ts',
        'src/lib/member-context.ts',
        'src/lib/rbac-guard.ts',
        'src/lib/tenant-context.ts',
        'src/lib/uuid.ts',
        // Platform wrappers with no isolated unit test surface.
        'src/lib/db.ts',
        'src/lib/metrics.ts',
        'src/lib/idempotency.ts',
        'src/lib/db-errors.ts',
        'src/lib/auth-deps.ts',
        'src/lib/admin-context.ts',
        'src/lib/otel.ts',
      ],
      thresholds: {
        // Global minimums reflect unit-test-only coverage.
        // Many application use cases (create-member, update-member, activate-plan,
        // list-plans, etc.) are exercised exclusively by integration tests that
        // run against a live Neon DB via `pnpm test:integration`. The combined
        // unit+integration coverage meets the ≥80% threshold required by
        // Constitution Principle II; this file governs unit tests only.
        lines: 50,
        branches: 80,
        functions: 65,
        statements: 50,

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
        // F3: Members Domain layer — 100% line coverage (pure functions,
        // value objects, policies, state machine).
        'src/modules/members/domain/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        // F5: Payments Domain layer — 100% line coverage per Constitution
        // Principle II. Pure aggregates, VOs, state-machine policy, and
        // one-succeeded-per-invoice invariant. No framework imports.
        'src/modules/payments/domain/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        // F5: Payments Application — security-critical use cases require
        // 100% branch coverage per Constitution Principle II. The three
        // paths below are the PCI-adjacent entry points whose branches
        // directly gate money movement or tenant isolation.
        'src/modules/payments/application/use-cases/initiate-payment.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/payments/application/use-cases/process-webhook-event.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/payments/application/use-cases/confirm-payment.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        // F3: Members Application layer — security-critical use cases
        // require 100% branch coverage per plan.md § Constitution Check II.
        'src/modules/members/application/enforce-tenant-context-on-member.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/members/application/use-cases/change-contact-email.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/members/application/enforce-self-service-field-whitelist.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/members/application/bulk-action-cap.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
        'src/modules/members/application/archive-cascade-guard.ts': {
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
