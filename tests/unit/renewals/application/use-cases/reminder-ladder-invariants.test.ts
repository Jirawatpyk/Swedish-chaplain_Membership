/**
 * REMINDER_LADDER invariant unit test — Round 5 staff-review (R005).
 *
 * Round 4 review-fix (R4-S4) originally enforced this invariant via a
 * module-load `for (const rung of REMINDER_LADDER) { if (...) throw }`
 * loop in `reconcile-pending-reactivations.ts`. R005 staff-review
 * (`/speckit.staff-review.run` Wave K23) flagged that pattern as
 * surprising: a future test that imports the module to mock something
 * unrelated would inherit the throw. Moved the assertion here so:
 *   - Test imports of the module are side-effect-free.
 *   - CI still catches a violation (this file runs in `pnpm test`).
 *   - The bound is unambiguous and grep-able.
 *
 * Invariant: every `REMINDER_LADDER[*].threshold` MUST be in
 * `[0, PENDING_TIMEOUT_DAYS=30)`. A rung at or above the timeout
 * boundary would be silently consumed by `processTimeout` before
 * the reminder loop in `reconcilePendingReactivations` fires.
 */
import { describe, it, expect } from 'vitest';
import {
  PENDING_TIMEOUT_DAYS,
  REMINDER_LADDER,
} from '@/modules/renewals/application/use-cases/reconcile-pending-reactivations';

describe('REMINDER_LADDER invariants (R4-S4 / R005 lock)', () => {
  it('every rung threshold is in [0, PENDING_TIMEOUT_DAYS)', () => {
    expect(PENDING_TIMEOUT_DAYS).toBe(30);
    for (const rung of REMINDER_LADDER) {
      expect(
        rung.threshold,
        `${rung.type} threshold ${rung.threshold} must be in [0, ${PENDING_TIMEOUT_DAYS})`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        rung.threshold,
        `${rung.type} threshold ${rung.threshold} must be < PENDING_TIMEOUT_DAYS=${PENDING_TIMEOUT_DAYS} (else processTimeout silently consumes it)`,
      ).toBeLessThan(PENDING_TIMEOUT_DAYS);
    }
  });

  it('thresholds are chronological (insertion order matters per decideRemindersToFire docstring)', () => {
    for (let i = 1; i < REMINDER_LADDER.length; i += 1) {
      const prev = REMINDER_LADDER[i - 1]!;
      const cur = REMINDER_LADDER[i]!;
      expect(
        cur.threshold,
        `${cur.type} (threshold ${cur.threshold}) must be > ${prev.type} (threshold ${prev.threshold}) for chronological emit order`,
      ).toBeGreaterThan(prev.threshold);
    }
  });

  it('shipped 3-rung ladder matches T-7 / T-3 / T-1 spec (FR-005c)', () => {
    expect(REMINDER_LADDER).toHaveLength(3);
    expect(REMINDER_LADDER.map((r) => r.threshold)).toEqual([23, 27, 29]);
    expect(REMINDER_LADDER.map((r) => r.type)).toEqual([
      'lapsed_member_admin_reactivation_reminder_t-7',
      'lapsed_member_admin_reactivation_reminder_t-3',
      'lapsed_member_admin_reactivation_reminder_t-1',
    ]);
  });
});
