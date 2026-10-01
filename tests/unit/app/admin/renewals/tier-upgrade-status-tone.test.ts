/**
 * Plan-change UX P4 — `tierUpgradeStatusTone` mapping.
 *
 * Pins the suggestion-status → AURA StatusPill tone contract (122 US7b-1,
 * T725) so a future status added to the state machine can't silently regress
 * the queue's colour cues.
 */
import { describe, expect, it } from 'vitest';
import { tierUpgradeStatusTone } from '@/app/(staff)/admin/renewals/tier-upgrades/_lib/tier-upgrade-status-tone';

describe('tierUpgradeStatusTone', () => {
  it.each([
    ['open', 'progress'],
    ['accepted_pending_apply', 'warning'],
    ['applied', 'ready'],
    ['auto_resolved', 'ready'],
    ['dismissed', 'neutral'],
    ['superseded', 'neutral'],
  ] as const)('maps %s → %s', (status, tone) => {
    expect(tierUpgradeStatusTone(status)).toBe(tone);
  });

  it('degrades an unknown status to neutral rather than throwing', () => {
    expect(tierUpgradeStatusTone('some_future_state')).toBe('neutral');
  });
});
