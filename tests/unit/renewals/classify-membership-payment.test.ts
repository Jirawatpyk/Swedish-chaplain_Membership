import { describe, expect, it } from 'vitest';
import { classifyMembershipPayment } from '@/modules/renewals/domain/classify-membership-payment';

const open = (status: 'upcoming' | 'awaiting_payment', anchoredAt: string | null) =>
  ({ status, anchoredAt });

describe('classifyMembershipPayment', () => {
  it('erased member → not_applicable(erased) regardless of cycles', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 1, openCycle: open('upcoming', null), memberErased: true }),
    ).toEqual({ kind: 'not_applicable', reason: 'erased' });
  });
  it('zero cycles ever → heal_no_cycle', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 0, openCycle: null, memberErased: false }),
    ).toEqual({ kind: 'heal_no_cycle' });
  });
  it('only cycle ever, upcoming, unanchored → first_payment', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 1, openCycle: open('upcoming', null), memberErased: false }),
    ).toEqual({ kind: 'first_payment' });
  });
  it('only cycle ever, awaiting_payment (post-T-0 provisional), unanchored → first_payment', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 1, openCycle: open('awaiting_payment', null), memberErased: false }),
    ).toEqual({ kind: 'first_payment' });
  });
  it('open cycle already anchored → renewal', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 1, openCycle: open('upcoming', '2026-07-08T00:00:00Z'), memberErased: false }),
    ).toEqual({ kind: 'renewal' });
  });
  it('open cycle + predecessor cycles → renewal even when unanchored', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 3, openCycle: open('awaiting_payment', null), memberErased: false }),
    ).toEqual({ kind: 'renewal' });
  });
  it('cycles exist but none open (terminal only) → not_applicable(terminal_only)', () => {
    expect(
      classifyMembershipPayment({ cycleCountForMember: 2, openCycle: null, memberErased: false }),
    ).toEqual({ kind: 'not_applicable', reason: 'terminal_only' });
  });
});
