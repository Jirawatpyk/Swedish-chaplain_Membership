/**
 * F8-completion Slice 0 · Task 0.2 (G5a) — the two missing TRANSITIONS edges.
 *
 * The `TRANSITIONS` map was missing two edges that real writers produce:
 *   - `upcoming → completed`   — offline-mark of an `upcoming` cycle via
 *     `mark-paid-offline.ts` (its `PAYABLE_STATUSES` = {awaiting_payment,
 *     upcoming}, so an `upcoming` cycle is payable and flips straight to
 *     `completed`).
 *   - `pending_admin_reactivation → lapsed` — reconcile-timeout via
 *     `reconcile-pending-reactivations.ts` (a money-hold that times out
 *     passively expires to `lapsed`).
 *
 * These are declared in the map in Task 0.2 and ENFORCED in
 * `transitionStatus` in Task 0.3 — so the map MUST list them before the
 * enforcement lands (ordering is load-bearing).
 */
import { describe, expect, it } from 'vitest';
import { canTransition } from '@/modules/renewals/domain/value-objects/cycle-status';

describe('CycleStatus TRANSITIONS — Task 0.2 (G5a) missing edges', () => {
  it('allows upcoming → completed (offline-mark of an upcoming cycle)', () => {
    expect(canTransition('upcoming', 'completed')).toBe(true);
  });

  it('allows pending_admin_reactivation → lapsed (reconcile-timeout)', () => {
    expect(canTransition('pending_admin_reactivation', 'lapsed')).toBe(true);
  });

  // Controls — proving the two additions did not over-broaden the map.
  it('still rejects a nonsense edge (completed → upcoming)', () => {
    expect(canTransition('completed', 'upcoming')).toBe(false);
  });

  it('still rejects upcoming → pending_admin_reactivation', () => {
    expect(canTransition('upcoming', 'pending_admin_reactivation')).toBe(false);
  });
});
