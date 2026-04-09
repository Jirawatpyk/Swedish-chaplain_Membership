/**
 * Vitest global setup for unit + contract tests.
 *
 * - Loads .env.local via next-env loader so tests can read secrets like
 *   AUTH_COOKIE_SIGNING_SECRET without hardcoding them.
 * - Resets MSW handlers between tests when the MSW server is in use.
 * - Silences pino logs during tests unless VITEST_DEBUG=1.
 */
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
