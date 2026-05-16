/**
 * T105 — Refund domain unit tests.
 *
 * Coverage targets:
 *   - 100% line coverage on `refund.ts` (state machine + completeness invariant)
 *   - Exhaustive 3×3 transition matrix
 *   - Branded id parser positive + negative cases
 *   - All 5 RefundCompletenessReason branches
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  REFUND_STATUSES,
  TERMINAL_REFUND_STATUSES,
  asRefundId,
  parseRefundId,
  isTerminalRefundStatus,
  canTransitionRefund,
  isLegalRefundTransition,
  assertRefundComplete,
  type Refund,
  type RefundStatus,
} from '@/modules/payments/domain/refund';
import { asPaymentId } from '@/modules/payments/domain/payment';

const LEGAL: ReadonlyArray<readonly [RefundStatus, RefundStatus]> = [
  ['pending', 'succeeded'],
  ['pending', 'failed'],
];

describe('refund: state machine — full 3×3 matrix', () => {
  for (const from of REFUND_STATUSES) {
    for (const to of REFUND_STATUSES) {
      const isLegal = LEGAL.some(([f, t]) => f === from && t === to);
      it(`${from} → ${to} is ${isLegal ? 'LEGAL' : 'ILLEGAL'}`, () => {
        const result = canTransitionRefund(from, to);
        expect(result.ok).toBe(isLegal);
        expect(isLegalRefundTransition(from, to)).toBe(isLegal);
      });
    }
  }

  it('terminal_state error: succeeded + failed have empty allowed sets', () => {
    for (const term of TERMINAL_REFUND_STATUSES) {
      for (const to of REFUND_STATUSES) {
        const r = canTransitionRefund(term, to);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.kind).toBe('terminal_state');
          if (r.error.kind === 'terminal_state') {
            expect(r.error.from).toBe(term);
          }
        }
      }
    }
  });

  it('illegal_transition error encodes from + to', () => {
    // pending → pending is illegal (not in allowed set, but from is non-terminal)
    const r = canTransitionRefund('pending', 'pending');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('illegal_transition');
      if (r.error.kind === 'illegal_transition') {
        expect(r.error.from).toBe('pending');
        expect(r.error.to).toBe('pending');
      }
    }
  });
});

describe('refund: isTerminalRefundStatus', () => {
  it('returns true for succeeded and failed', () => {
    expect(isTerminalRefundStatus('succeeded')).toBe(true);
    expect(isTerminalRefundStatus('failed')).toBe(true);
  });
  it('returns false for pending', () => {
    expect(isTerminalRefundStatus('pending')).toBe(false);
  });
});

describe('refund: branded id helpers', () => {
  it('asRefundId is an unchecked brand cast', () => {
    const id = asRefundId('rfnd_01JABCDEFGHIJKLMNOPQRSTUV');
    expect(id).toBe('rfnd_01JABCDEFGHIJKLMNOPQRSTUV');
  });

  it('parseRefundId accepts ULID-like strings 20–40 chars', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z_]{20,40}$/),
        (raw) => {
          const r = parseRefundId(raw);
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(r.value).toBe(raw);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('parseRefundId rejects too-short input', () => {
    const r = parseRefundId('short');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_refund_id');
      expect(r.error.raw).toBe('short');
    }
  });

  it('parseRefundId rejects forbidden Crockford chars (I, L, O, U)', () => {
    expect(parseRefundId('rfnd_IIIIIIIIIIIIIIII').ok).toBe(false);
    expect(parseRefundId('rfnd_LLLLLLLLLLLLLLLL').ok).toBe(false);
    expect(parseRefundId('rfnd_OOOOOOOOOOOOOOOO').ok).toBe(false);
    expect(parseRefundId('rfnd_UUUUUUUUUUUUUUUU').ok).toBe(false);
  });

  it('parseRefundId rejects too-long input (> 40)', () => {
    expect(parseRefundId('rfnd_' + 'A'.repeat(40)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Completeness invariant — every reason exercised
// ---------------------------------------------------------------------------

function makeRefund(overrides: Partial<Refund>): Refund {
  return {
    id: asRefundId('rfnd_01JREFUND0BASEFIXTUREXYZ'),
    tenantId: 'tnt-1',
    paymentId: asPaymentId('pmt_01JABCDEFGHIJKLMNOPQRSTUV'),
    invoiceId: 'inv-1',
    amountSatang: asSatang(350_000n),
    reason: 'tier downgrade',
    status: 'pending',
    processorRefundId: null,
    failureReasonCode: null,
    creditNoteId: null,
    initiatedAt: new Date('2026-05-15T03:14:22.456Z'),
    completedAt: null,
    initiatorUserId: 'user-admin-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('refund: assertRefundComplete', () => {
  it('pending + completedAt=null → ok', () => {
    expect(assertRefundComplete(makeRefund({ status: 'pending' })).ok).toBe(true);
  });

  it('pending + completedAt non-null → pending_unexpected_completed_at', () => {
    const r = assertRefundComplete(
      makeRefund({ status: 'pending', completedAt: new Date() }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('pending_unexpected_completed_at');
  });

  it('terminal + completedAt=null → terminal_missing_completed_at', () => {
    const r = assertRefundComplete(
      makeRefund({
        status: 'succeeded',
        completedAt: null,
        processorRefundId: 're_3R',
        creditNoteId: 'cn_1',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('terminal_missing_completed_at');
  });

  it('succeeded missing processorRefundId → succeeded_missing_processor_refund_id', () => {
    const r = assertRefundComplete(
      makeRefund({
        status: 'succeeded',
        completedAt: new Date(),
        processorRefundId: null,
        creditNoteId: 'cn_1',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('succeeded_missing_processor_refund_id');
  });

  it('succeeded missing creditNoteId → succeeded_missing_credit_note_id', () => {
    const r = assertRefundComplete(
      makeRefund({
        status: 'succeeded',
        completedAt: new Date(),
        processorRefundId: 're_3R',
        creditNoteId: null,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('succeeded_missing_credit_note_id');
  });

  it('succeeded fully populated → ok', () => {
    expect(
      assertRefundComplete(
        makeRefund({
          status: 'succeeded',
          completedAt: new Date(),
          processorRefundId: 're_3R',
          creditNoteId: 'cn_1',
        }),
      ).ok,
    ).toBe(true);
  });

  it('failed missing failureReasonCode → failed_missing_failure_reason_code', () => {
    const r = assertRefundComplete(
      makeRefund({
        status: 'failed',
        completedAt: new Date(),
        failureReasonCode: null,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('failed_missing_failure_reason_code');
  });

  it('failed with reasonCode → ok', () => {
    expect(
      assertRefundComplete(
        makeRefund({
          status: 'failed',
          completedAt: new Date(),
          failureReasonCode: 'card_declined',
        }),
      ).ok,
    ).toBe(true);
  });
});
