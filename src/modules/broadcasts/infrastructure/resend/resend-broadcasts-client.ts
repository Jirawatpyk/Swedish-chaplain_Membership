/**
 * T105 — Resend Broadcasts SDK client singleton (F7 US2).
 *
 * Distinct from the F1 transactional Resend client
 * (`src/modules/auth/infrastructure/email/resend-client.ts`) — uses the
 * dedicated `RESEND_BROADCASTS_API_KEY` env var so:
 *   - Independent secret rotation
 *   - Separate auth domain on the Resend side
 *   - Distinct rate-limit + quota envelope
 *
 * Lazy-init pattern mirrors F5 `stripe-client.ts`:
 *   - First call constructs the SDK instance
 *   - Test harnesses can inject a fake via `_setTestOverride`
 */
import { Resend } from 'resend';
import { env } from '@/lib/env';

let _instance: Resend | null = null;
let _testOverride: Resend | null = null;

/**
 * Test-only injection hook. Pass a stub Resend client to short-circuit
 * the singleton constructor in unit tests without setting env vars.
 * Production code MUST never call this.
 */
export function _setTestOverride(client: Resend | null): void {
  _testOverride = client;
  _instance = null;
}

export function getResendBroadcastsClient(): Resend {
  if (_testOverride !== null) return _testOverride;
  if (_instance === null) {
    _instance = new Resend(env.broadcasts.apiKey);
  }
  return _instance;
}
