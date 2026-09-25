/**
 * F7 retention sweep (migration 0310) — which column anchors the retention
 * clock of a closed E-Blast.
 *
 * The anchor is the moment the row reached its terminal status, never
 * `updated_at` (a redaction or an audience clean-up touches that, and would
 * restart the clock). The clock itself (`anchor + retention_years`, the
 * `stage_entered_at` fallback, 10-year rows, non-terminal rows never
 * matching) is evaluated in SQL and proven on live Neon in
 * `tests/integration/broadcasts/broadcast-retention-sweep.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { RETENTION_ANCHOR_FIELD } from '@/modules/broadcasts/domain/retention/broadcast-retention';
import { TERMINAL_BROADCAST_STATUSES } from '@/modules/broadcasts/domain/value-objects/broadcast-status';

describe('RETENTION_ANCHOR_FIELD', () => {
  it('names an anchor for exactly the terminal statuses', () => {
    expect(Object.keys(RETENTION_ANCHOR_FIELD).sort()).toEqual([...TERMINAL_BROADCAST_STATUSES].sort());
  });

  it('never anchors on updated_at', () => {
    expect(Object.values(RETENTION_ANCHOR_FIELD)).not.toContain('updatedAt');
  });

  it.each([
    ['sent', 'sentAt'],
    ['partial_delivery_accepted', 'partialDeliveryAcceptedAt'],
    ['failed_to_dispatch', 'failedToDispatchAt'],
    ['rejected', 'rejectedAt'],
    ['cancelled', 'cancelledAt'],
    // The day-30 close stamps no column of its own.
    ['expired_no_member_response', 'stageEnteredAt'],
  ] as const)('%s → %s', (status, field) => {
    expect(RETENTION_ANCHOR_FIELD[status]).toBe(field);
  });
});
