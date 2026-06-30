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
  FEATURE_F4_INVOICING: 'true',
  // F8 Renewals — match canonical post-flag-flip production state so
  // the test environment exercises the same wiring as prod (notably
  // `onPaidCallbacks` injection in F5 webhook + confirm-payment deps).
  // Without this, CI without `.env.local` would default to false and
  // diverge from the local-dev/prod-with-flag-on shape.
  FEATURE_F8_RENEWALS: 'true',
  RENEWAL_LINK_TOKEN_SECRET_PRIMARY:
    'test-renewal-link-token-secret-32-chars-min-padding',
  // F6 EventCreate — admin route handlers (T060) gate on the global
  // flag for the same surface-disclosure pattern as F8's dashboard
  // 404. Phase 3 webhook route uses tenant-config gating instead, so
  // before Phase 4 the flag had no effect on the test environment.
  //
  // **Side-effect note** (verify-finding F6, 2026-05-12): with the
  // flag forced to 'true' in the unit/contract suite, any future test
  // that wants to assert the kill-switch-OFF behaviour MUST override
  // it via `vi.stubEnv('FEATURE_F6_EVENTCREATE','false')` (or pass it
  // through `process.env` BEFORE `import 'src/lib/env'` resolves).
  // The schema's transform-time validation reads from `process.env` at
  // module load, so a runtime `delete process.env[…]` after env.ts
  // imports has no effect.
  FEATURE_F6_EVENTCREATE: 'true',
  EVENTCREATE_PII_PSEUDONYM_SALT:
    'dGVzdC1mNi1zYWx0LXBsYWNlaG9sZGVyLWF0LWxlYXN0LTMyLWJ5dGVzLWxvbmctZW5vdWdoLWFhYQo=',
};

for (const [key, value] of Object.entries(TEST_PLACEHOLDERS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

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
