/**
 * Vitest global setup for unit + contract tests.
 *
 * - Loads .env.local so transitively-imported `src/lib/env.ts` finds the
 *   secrets it validates at module load time. If .env.local is missing
 *   (CI without secrets), we inject placeholder values that satisfy the
 *   schema but cannot be used to talk to a real DB.
 * - Resets MSW handlers between tests when the MSW server is in use.
 * - Silences pino logs during tests unless VITEST_DEBUG=1.
 */

// --- Env loading (must run BEFORE any module that imports env.ts) ------------
// Top-level statements in vitest setupFiles run before the test file is
// imported, so module-level env validation in src/lib/env.ts sees these
// values when its import chain is evaluated.
try {
  process.loadEnvFile?.('.env.local');
} catch {
  // .env.local missing — fall through to placeholder injection
}

const TEST_PLACEHOLDERS: Record<string, string> = {
  NODE_ENV: process.env.NODE_ENV ?? 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test?sslmode=disable',
  KV_REST_API_URL: 'https://test.upstash.io',
  KV_REST_API_TOKEN: 'test-token-with-enough-length-for-zod-min-20',
  RESEND_API_KEY: 're_test_key_placeholder',
  RESEND_WEBHOOK_SIGNING_SECRET: 'whsec_test_placeholder',
  AUTH_COOKIE_SIGNING_SECRET: 'test-cookie-signing-secret-must-be-at-least-32-chars',
  APP_BASE_URL: 'http://localhost:3000',
  APP_ALLOWED_ORIGINS: 'http://localhost:3000',
  READ_ONLY_MODE: 'false',
  LOG_LEVEL: 'error',
};

for (const [key, value] of Object.entries(TEST_PLACEHOLDERS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

import { beforeAll, afterEach, afterAll, vi } from 'vitest';

// Fixed clock for deterministic TTL tests. Individual tests can override
// by calling `vi.setSystemTime(...)` themselves.
const FIXED_NOW = new Date('2026-04-09T12:00:00.000Z');

beforeAll(() => {
  vi.useFakeTimers({
    now: FIXED_NOW,
    shouldAdvanceTime: false,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });

  if (!process.env.VITEST_DEBUG) {
    // Pino writes to stdout/stderr via a stream — mute both for clean output
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
