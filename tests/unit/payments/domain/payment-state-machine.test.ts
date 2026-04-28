/**
 * T051 — Payment status transition policy unit tests.
 *
 * Exhaustive coverage of the 6×6 transition matrix (36 cells), paired
 * with fast-check properties that prove terminal states never advance
 * and that `isLegalTransition` mirrors `canTransition.ok`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isLegalTransition,
} from '@/modules/payments/domain/policies/payment-status-transitions';
import {
  PAYMENT_STATUSES,
  TERMINAL_PAYMENT_STATUSES,
  isTerminalPaymentStatus,
  type PaymentStatus,
} from '@/modules/payments/domain/payment';

const LEGAL: ReadonlyArray<readonly [PaymentStatus, PaymentStatus]> = [
  ['pending', 'succeeded'],
  ['pending', 'failed'],
  ['pending', 'canceled'],
  ['succeeded', 'partially_refunded'],
  ['succeeded', 'refunded'],
  ['partially_refunded', 'partially_refunded'],
  ['partially_refunded', 'refunded'],
];

describe('payment-status-transitions — full 6×6 matrix', () => {
  for (const from of PAYMENT_STATUSES) {
    for (const to of PAYMENT_STATUSES) {
      const isLegal = LEGAL.some(([f, t]) => f === from && t === to);
      it(`${from} → ${to} is ${isLegal ? 'LEGAL' : 'ILLEGAL'}`, () => {
        const result = canTransition(from, to);
        expect(result.ok).toBe(isLegal);
        expect(isLegalTransition(from, to)).toBe(isLegal);
      });
    }
  }
});

describe('payment-status-transitions — error kinds', () => {
  it('returns terminal_state for transitions out of failed', () => {
    const r = canTransition('failed', 'succeeded');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('terminal_state');
  });

  it('returns terminal_state for transitions out of canceled', () => {
    const r = canTransition('canceled', 'pending');
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('terminal_state');
  });

  it('returns terminal_state for transitions out of refunded', () => {
    const r = canTransition('refunded', 'partially_refunded');
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('terminal_state');
  });

  it('returns illegal_transition with from+to when source has successors', () => {
    const r = canTransition('pending', 'refunded');
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('illegal_transition');
    if (r.error.kind !== 'illegal_transition') throw new Error('unreachable');
    expect(r.error.from).toBe('pending');
    expect(r.error.to).toBe('refunded');
  });

  it('returns illegal_transition from succeeded to non-refund states', () => {
    const r = canTransition('succeeded', 'failed');
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('illegal_transition');
  });
});

describe('payment-status-transitions — properties', () => {
  const anyStatus = fc.constantFrom(...PAYMENT_STATUSES);

  it('terminal states reject every destination (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TERMINAL_PAYMENT_STATUSES),
        anyStatus,
        (terminal, dest) => {
          const r = canTransition(terminal, dest);
          return r.ok === false && r.error.kind === 'terminal_state';
        },
      ),
      { numRuns: 30 },
    );
  });

  it('isLegalTransition === canTransition.ok for every pair (property)', () => {
    fc.assert(
      fc.property(anyStatus, anyStatus, (from, to) => {
        return isLegalTransition(from, to) === canTransition(from, to).ok;
      }),
      { numRuns: 50 },
    );
  });

  it('isTerminalPaymentStatus aligns with TERMINAL_PAYMENT_STATUSES', () => {
    fc.assert(
      fc.property(anyStatus, (s) => {
        return (
          isTerminalPaymentStatus(s) ===
          (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(s)
        );
      }),
      { numRuns: 20 },
    );
  });
});
