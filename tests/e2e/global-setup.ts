/**
 * Playwright global setup.
 *
 * Runs ONCE before any test starts. Clears the Upstash rate-limit
 * buckets so a prior run's residue doesn't trip the 5/15-min sign-in
 * limit on the dedicated test users.
 *
 * Registered via `globalSetup` in `playwright.config.ts`.
 */
import { clearE2ERateLimits } from './helpers/rate-limit';

async function globalSetup(): Promise<void> {
  try {
    await clearE2ERateLimits();
    console.log('[e2e global setup] cleared Upstash rate-limit buckets');
  } catch (error) {
    // Don't fail the entire run if Upstash is unreachable — individual
    // specs can still handle rate-limit responses on their own.
    console.warn('[e2e global setup] rate-limit clear failed:', String(error));
  }
}

export default globalSetup;
