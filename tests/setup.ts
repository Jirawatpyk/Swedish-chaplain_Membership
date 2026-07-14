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
  // F4 Invoicing — required at boot by src/lib/env.ts (T004). Tests that
  // need live Blob / Cron behaviour override these locally.
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test_placeholder_token',
  CRON_SECRET: 'cron-secret-test-placeholder-16+',
  RENEWAL_LINK_TOKEN_SECRET_PRIMARY:
    'test-renewal-link-token-secret-32-chars-min-padding',
  // NOTE: FEATURE_F4_INVOICING / FEATURE_F8_RENEWALS / FEATURE_F6_EVENTCREATE
  // used to live here. They do NOT belong in a gap-filling map — see the
  // forced-flag block below the loop.
  EVENTCREATE_PII_PSEUDONYM_SALT:
    'dGVzdC1mNi1zYWx0LXBsYWNlaG9sZGVyLWF0LWxlYXN0LTMyLWJ5dGVzLWxvbmctZW5vdWdoLWFhYQo=',
};

for (const [key, value] of Object.entries(TEST_PLACEHOLDERS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

// --- Feature flags the suite PINS (forced, not gap-filled) -------------------
// These three were in TEST_PLACEHOLDERS above, which only fills a key that is
// ABSENT. That silently failed to do what its own comment claimed: a developer
// whose `.env.local` says `FEATURE_F6_EVENTCREATE=false` puts the *string*
// `'false'` into process.env — which is truthy — so the `'true'` placeholder
// was never applied and the flag stayed off.
//
// That is exactly what happened (2026-07-14): the flag was switched off locally
// while testing the nav gating work, and 41 events/cron tests went red on a
// clean checkout with no code change behind it. A test whose result depends on
// the contents of an individual developer's `.env.local` is not a test — it
// will disagree between CI and every machine.
//
// So: FORCE them, the way STRIPE_API_VERSION below already is. The suite
// asserts the flag-ON wiring; a test that wants the flag-OFF path mocks
// `@/lib/env` for itself (see tests/contract/events/admin-events-api.test.ts).
process.env['FEATURE_F4_INVOICING'] = 'true';
process.env['FEATURE_F8_RENEWALS'] = 'true';
process.env['FEATURE_F6_EVENTCREATE'] = 'true';

// Pin STRIPE_API_VERSION for unit/contract tests to match the
// fixture `PINNED_API_VERSION` in tests/contract/payments/*.
// Production .env.local may track a different pinned version;
// tests own their own fixture contract (Group B convention).
process.env['STRIPE_API_VERSION'] = '2024-06-20';

import { beforeAll, afterEach, afterAll, vi } from 'vitest';
// Staff-Review-2026-05-09 R2-S6: extend Vitest's expect with
// @testing-library/jest-dom matchers (`.toBeInTheDocument`,
// `.toHaveAccessibleName`, etc.) — DOM-aware assertions are the
// Testing Library convention and replace the looser `.toBeTruthy`
// pattern that passes for any non-null DOM reference.
import '@testing-library/jest-dom/vitest';

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
  // IMPORTANT: `clearAllMocks` (not `resetAllMocks`) — several contract
  // tests define `vi.mock(path, () => ({fn: vi.fn(async () => ({...}))}))`
  // factories with functional default implementations. `resetAllMocks`
  // would wipe those implementations back to `() => undefined`, breaking
  // every test that relies on the factory default. `clearAllMocks` only
  // clears `.calls` / `.results` while preserving implementations, which
  // matches what those factories expect. The `mockResolvedValueOnce`
  // leak that `resetAllMocks` would fix is a secondary symptom of the
  // import-hang root cause, which is addressed directly by the
  // `testTimeout: 10_000` bump in vitest.config.ts — hangs now fail
  // loud at 10s instead of cascading through unconsumed mock queues.
  //
  // R4.4 L-9 — interaction caveat for audit-event tests:
  // `clearAllMocks` does NOT consume queued `mockResolvedValueOnce` /
  // `mockRejectedValueOnce` entries. A test that primes one and never
  // calls the mock leaves the queue live for the next test in the
  // same file. The 4 tests under
  // `tests/unit/broadcasts/application/safe-audit-emit.test.ts` are
  // the most-exposed surface — they reset queues explicitly via
  // `mockReset()` inside `beforeEach` to defend against the queue-
  // leak class. New audit-event tests should follow the same pattern
  // when they enqueue per-test failure modes.
  //
  // `restoreAllMocks` (which DOES restore prototype-spy implementations
  // back to the original method) runs once in `afterAll` below — see
  // tests/unit/broadcasts/components/admin-template-edit-confirm-starter.test.tsx
  // for an example where the local `finally { spy.mockRestore() }`
  // IS the active per-test restore path (afterEach can't do it).
  vi.clearAllMocks();
  // NOTE: do NOT add vi.unstubAllGlobals() here — several suites (e.g. the cron
  // renewals coordinators) call vi.stubGlobal('fetch', …) at MODULE scope and
  // rely on it persisting across every test in the file; a global per-test
  // unstub would strip it after the first test. Per-test stubbers must unstub
  // themselves (try/finally).
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
