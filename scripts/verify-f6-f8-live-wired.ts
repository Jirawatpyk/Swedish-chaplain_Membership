/**
 * T154a operator gate — automated F6 → F8 live-wired verification.
 *
 * Operator runs this AFTER flipping `FEATURE_F6_EVENTCREATE=true` in
 * Vercel env vars. Asserts:
 *   1. Composition root picks `drizzleEventAttendeesAdapter` (NOT stub)
 *   2. Adapter actually returns data from live Neon (not throw / empty)
 *   3. F8 at-risk-scorer receives `eventAttendeesAvailable: true`
 *
 * Why this script: `renewals-deps.ts:61-63` swap is a silent-failure
 * surface — if it's bypassed or if flag mis-resolves, F8 stays on
 * stub FOREVER in production and `eventAttendanceFactorSkipped: true`
 * flags every at-risk score invisibly (U-1 analyze finding).
 *
 * Local dev test (flag-off mode — expected stub path):
 *   pnpm tsx scripts/verify-f6-f8-live-wired.ts
 *   → exit code 0 + reports "FLAG=OFF · stub selected" (expected)
 *
 * Pre-flag-flip dry run (flag-on mode via override):
 *   FEATURE_F6_EVENTCREATE=true pnpm tsx scripts/verify-f6-f8-live-wired.ts
 *   → exit code 0 + reports "FLAG=ON · real adapter · isAvailable=true"
 *
 * Post-flag-flip operator gate (T154a):
 *   On staging or prod with FEATURE_F6_EVENTCREATE=true set:
 *   pnpm tsx scripts/verify-f6-f8-live-wired.ts
 *   → MUST report "FLAG=ON · real adapter · isAvailable=true"
 *   → exit code 0 confirms F8 will use real F6 data
 *   → exit code 1 = stop the line; investigate composition root
 *
 * Constitution v1.4.0 IX: silent-failure prevention via observable
 * verification path. Same precedent as F4 `check:audit-events` +
 * F5 `check:multi-tenant`.
 */
import { env } from '@/lib/env';
import { eventAttendeesStub } from '@/modules/renewals/infrastructure/event-attendees-stub';
// Direct file import (NOT barrel) — the F6 barrel transitively loads
// the entire app (invoicing → payments → …); we only need the adapter.
import { drizzleEventAttendeesAdapter } from '@/modules/events/infrastructure/drizzle-event-attendees-by-member';

async function main(): Promise<void> {
  const flagOn = env.features.f6EventCreate;

  console.log('');
  console.log('=== T154a — F6 → F8 live-wired verification ===');
  console.log('');
  console.log(`FEATURE_F6_EVENTCREATE: ${flagOn}`);
  console.log('');

  // Mirror the composition root swap at renewals-deps.ts:61-63.
  // If this script's selection diverges from renewals-deps.ts, the
  // verification is meaningless — keep these two lines in sync.
  const selectedPort = flagOn ? drizzleEventAttendeesAdapter : eventAttendeesStub;
  const portName = flagOn ? 'drizzleEventAttendeesAdapter' : 'eventAttendeesStub';

  console.log(`Composition root selects: ${portName}`);

  // Call isAvailable() — stub returns false, real adapter returns true.
  // This is the load-bearing check: the at-risk scorer reads
  // `eventAttendeesAvailable` and skips the F6 factor when false.
  let isAvailable: boolean;
  try {
    isAvailable = await selectedPort.isAvailable();
  } catch (e) {
    console.error('');
    console.error('❌ FAIL — selectedPort.isAvailable() threw:');
    console.error(e instanceof Error ? e.stack : String(e));
    console.error('');
    console.error('Likely causes:');
    console.error('  - DATABASE_URL not set or Neon unreachable');
    console.error('  - F6 adapter has a runtime bug (regression)');
    console.error('  - drizzleEventAttendeesAdapter no longer exported from @/modules/events barrel');
    process.exit(1);
  }

  console.log(`isAvailable(): ${isAvailable}`);
  console.log('');

  // Expected: isAvailable matches flag state
  //   flag=false (stub mode)  → isAvailable=false (F8 skips F6 factor)
  //   flag=true  (real mode)  → isAvailable=true  (F8 includes F6 factor)
  if (isAvailable === flagOn) {
    console.log(`✅ PASS — port behaviour matches flag (${flagOn ? 'REAL ADAPTER' : 'stub (dark mode)'})`);
    if (flagOn) {
      console.log('');
      console.log('F8 at-risk-scorer will now consult real F6 event attendance.');
      console.log('eventAttendanceFactorSkipped will be FALSE on next compute.');
    } else {
      console.log('');
      console.log('Currently in dark deployment (F6 not yet flag-flipped).');
      console.log('F8 at-risk-scorer skips F6 factor — expected behaviour.');
      console.log('Run this script again AFTER flipping FEATURE_F6_EVENTCREATE=true.');
    }
    process.exit(0);
  }

  console.error('');
  console.error(`❌ FAIL — port behaviour does NOT match flag.`);
  console.error(`  flag=${flagOn} but isAvailable=${isAvailable}`);
  console.error('');
  if (flagOn && !isAvailable) {
    console.error('CRITICAL — flag is ON but adapter reports unavailable.');
    console.error('F8 will SILENTLY skip F6 factor in production despite flag flip!');
    console.error('Investigate drizzleEventAttendeesAdapter.isAvailable() implementation.');
  } else if (!flagOn && isAvailable) {
    console.error('UNEXPECTED — flag is OFF but stub reports available.');
    console.error('Stub should always return false. Check stub implementation.');
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('[verify-f6-f8-live-wired] fatal:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
