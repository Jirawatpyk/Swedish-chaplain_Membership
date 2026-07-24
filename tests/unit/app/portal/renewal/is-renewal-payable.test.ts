// tests/unit/app/portal/renewal/is-renewal-payable.test.ts
//
// 059-membership-suspension Task 9 item 4 — renewal-page payability gate.
// Extracted from `page.tsx` so the predicate that used to key ONLY on
// `summary.status === 'awaiting_payment'` (leaving the `upcoming`-but-expired
// cohort the suspension override rule creates on a dead-end "renewal window
// not yet open" card) is unit-testable in isolation. Mirrors the SAME
// predicate `deriveMembershipAccess` uses for the "upcoming/reminded past
// expiry → suspended" override — the confirm route already accepts this via
// its lazy `upcoming|reminded → awaiting_payment` self-transition
// (`confirm-renewal.ts`), so only the presentation gate was the dead end.
import { describe, expect, it } from 'vitest';
import { isRenewalPayable } from '@/app/(member)/portal/_lib/is-renewal-payable';

const NOW = new Date('2026-06-06T00:00:00.000Z');

describe('isRenewalPayable', () => {
  it('is payable when awaiting_payment, regardless of expiry (future)', () => {
    expect(isRenewalPayable('awaiting_payment', '2026-12-31T00:00:00.000Z', NOW)).toBe(true);
  });

  it('is payable when awaiting_payment, regardless of expiry (past)', () => {
    expect(isRenewalPayable('awaiting_payment', '2026-01-01T00:00:00.000Z', NOW)).toBe(true);
  });

  it('is NOT payable for an upcoming cycle whose period has not yet ended', () => {
    expect(isRenewalPayable('upcoming', '2026-12-31T00:00:00.000Z', NOW)).toBe(false);
  });

  it('IS payable for an upcoming cycle whose period has already ended (closes the 06:15-cron gap)', () => {
    expect(isRenewalPayable('upcoming', '2026-01-01T00:00:00.000Z', NOW)).toBe(true);
  });

  it('IS payable for a reminded cycle whose period has already ended', () => {
    expect(isRenewalPayable('reminded', '2026-01-01T00:00:00.000Z', NOW)).toBe(true);
  });

  it('is NOT payable for a reminded cycle still within its period', () => {
    expect(isRenewalPayable('reminded', '2026-12-31T00:00:00.000Z', NOW)).toBe(false);
  });

  it('is NOT payable for pending_admin_reactivation (separate gate branch)', () => {
    expect(isRenewalPayable('pending_admin_reactivation', '2026-01-01T00:00:00.000Z', NOW)).toBe(false);
  });

  it.each(['completed', 'lapsed', 'cancelled'] as const)(
    'is NOT payable for a terminal %s cycle',
    (status) => {
      expect(isRenewalPayable(status, '2026-01-01T00:00:00.000Z', NOW)).toBe(false);
    },
  );

  it('treats exactly-now expiry as NOT YET expired (strict less-than, matches deriveMembershipAccess)', () => {
    expect(isRenewalPayable('upcoming', NOW.toISOString(), NOW)).toBe(false);
  });
});
