/**
 * T050 — Integration test for FR-015a F6 EventAttendees stub-port.
 *
 * Verifies that `event_attendees_last_90d` segment resolves to `[]` until
 * F6 ships. Submission with this segment → rejected with
 * broadcast_empty_segment_blocked (since 0 recipients after resolution).
 *
 * Phase 2 batch ship contract: F7 + F6 release together (Clarifications Q5);
 * F6's `/speckit.implement` swaps the F7 stub for a real Drizzle adapter.
 *
 * Turns GREEN: T062 (event-attendees-stub Infrastructure adapter — F6
 * stub returning []) + T066 (resolve-segment-recipients.ts) + T076
 * (submit route) land.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const stubAdapterPath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/infrastructure/event-attendees-stub.ts',
);

describe('event-attendees-stub integration — RED skeleton (T050 — turns GREEN at T062 + T066 + T076)', () => {
  it('event-attendees stub adapter exists', async () => {
    await expect(access(stubAdapterPath)).resolves.toBeUndefined();
  });

  // FR-015a stub behaviour
  it.todo('stub.getLastNinetyDayAttendees returns empty array');
  it.todo('stub.lookupAttendeeEmailInTenant returns null for any input');

  // Submit-broadcast with event_attendees_last_90d segment
  it.todo('submit with segment_type=event_attendees_last_90d → segment resolves []');
  it.todo('empty segment after resolution → 422 broadcast_empty_segment_blocked');
  it.todo('audit broadcast_empty_segment_blocked emitted with segment_type=event_attendees_last_90d');

  // F6 swap-in contract (forward compat)
  it.todo('stub satisfies EventAttendeesRepository port interface (F6 swap-in compatible)');

  // Cleanup
  it.todo('afterAll cleans test tenant');
});
