/**
 * T038 — Unit tests for the F7 broadcast state machine.
 *
 * Verifies all 8 states + every legal/illegal transition per FR-004 +
 * FR-004a. Pairs with the DB-level state-machine trigger from migration
 * 0064 (defence-in-depth — both layers MUST agree).
 *
 * Note on TDD ordering: the Domain policy `broadcast-status-transitions.ts`
 * was authored in Phase 2 Batch A as part of the Domain skeleton. These
 * tests verify the existing implementation behaves per spec — Constitution
 * Principle II is satisfied by the test-authored-before-use-case ordering
 * for the Application layer (T064 submit-broadcast); Domain types are
 * authored together with their unit tests in Foundational scope.
 */
import { describe, expect, it } from 'vitest';
import {
  BROADCAST_STATUSES,
  BROADCAST_TRANSITIONS,
  canTransition,
  isTerminalStatus,
  transition,
  type BroadcastStatus,
} from '@/modules/broadcasts';

describe('BROADCAST_STATUSES', () => {
  it('contains all 10 lifecycle states (8 F7 MVP + 2 F71A US1)', () => {
    // Phase 3F.11.19 — F71A US1 added `partially_sent` +
    // `partial_delivery_accepted` (migration 0169 + 0173). The
    // BROADCAST_STATUSES tuple in `domain/value-objects/broadcast-status.ts`
    // grew from 8 → 10. State-machine matrix correctness for the new
    // states is covered by `cancel-cutoff-policy.test.ts` +
    // `broadcast-phase.test.ts`.
    expect(BROADCAST_STATUSES).toEqual([
      'draft',
      'submitted',
      'approved',
      'sending',
      'sent',
      'rejected',
      'cancelled',
      'failed_to_dispatch',
      'partially_sent',
      'partial_delivery_accepted',
    ]);
  });

  it('count matches data-model + DB enum (10 values after F71A US1)', () => {
    expect(BROADCAST_STATUSES).toHaveLength(10);
  });
});

describe('isTerminalStatus', () => {
  it.each([
    ['sent', true],
    ['rejected', true],
    ['cancelled', true],
    ['failed_to_dispatch', true],
    ['draft', false],
    ['submitted', false],
    ['approved', false],
    ['sending', false],
  ] as const)('isTerminalStatus(%s) === %s', (status, expected) => {
    expect(isTerminalStatus(status)).toBe(expected);
  });
});

describe('canTransition', () => {
  // Legal transitions per FR-004 + FR-004a (matches DB state-machine
  // trigger in migration 0064)
  // Domain layer (broadcast-status-transitions.ts) is more restrictive
  // than the DB state-machine trigger (migration 0064) — drafts go to
  // `submitted` only (drafts are DELETED via /api/broadcasts/draft/[id]
  // route rather than cancelled per Q10 cancel-cutoff); approved →
  // failed_to_dispatch is reachable only via DB trigger (cron path
  // recovers via Application bypassing the Domain transition() helper).
  const legalTransitions: ReadonlyArray<[BroadcastStatus, BroadcastStatus]> = [
    ['draft', 'submitted'],
    ['submitted', 'approved'],
    ['submitted', 'rejected'],
    ['submitted', 'cancelled'],
    ['approved', 'sending'],
    ['approved', 'cancelled'],
    ['sending', 'sent'],
    ['sending', 'failed_to_dispatch'],
  ];

  it.each(legalTransitions)('canTransition(%s, %s) is true', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  // Cherry-pick illegal transitions to keep the test set focused
  const illegalTransitions: ReadonlyArray<[BroadcastStatus, BroadcastStatus]> = [
    ['draft', 'approved'], // skip submission
    ['draft', 'sent'], // skip many states
    ['submitted', 'sending'], // skip approval
    ['approved', 'sent'], // skip sending
    ['sent', 'cancelled'], // terminal state
    ['sent', 'submitted'], // terminal state
    ['rejected', 'approved'], // terminal state
    ['cancelled', 'sending'], // terminal state
    ['failed_to_dispatch', 'sending'], // terminal state
  ];

  it.each(illegalTransitions)(
    'canTransition(%s, %s) is false',
    (from, to) => {
      expect(canTransition(from, to)).toBe(false);
    },
  );

  it('terminal states have empty outbound adjacency', () => {
    expect(BROADCAST_TRANSITIONS.sent).toEqual([]);
    expect(BROADCAST_TRANSITIONS.rejected).toEqual([]);
    expect(BROADCAST_TRANSITIONS.cancelled).toEqual([]);
    expect(BROADCAST_TRANSITIONS.failed_to_dispatch).toEqual([]);
  });
});

describe('transition', () => {
  it('returns ok with target status on legal transition', () => {
    const result = transition('draft', 'submitted');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('submitted');
  });

  it('returns terminal_state error from terminal state', () => {
    const result = transition('sent', 'cancelled');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'broadcast_status.terminal_state') {
      expect(result.error.status).toBe('sent');
    } else if (!result.ok) {
      throw new Error(
        `expected terminal_state variant, got: ${result.error.code}`,
      );
    }
  });

  it('returns invalid_transition for illegal non-terminal transition', () => {
    // 'submitted' is non-terminal so the error variant is
    // 'invalid_transition' (not 'terminal_state'). Use a non-terminal
    // origin to exercise the from/to fields specific to this branch.
    const result = transition('submitted', 'sending');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'broadcast_status.invalid_transition') {
      expect(result.error.from).toBe('submitted');
      expect(result.error.to).toBe('sending');
    } else if (!result.ok) {
      throw new Error(
        `expected invalid_transition variant, got: ${result.error.code}`,
      );
    }
  });

  it('handles all 4 terminal states uniformly', () => {
    for (const terminal of ['sent', 'rejected', 'cancelled', 'failed_to_dispatch'] as const) {
      const result = transition(terminal, 'submitted');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('broadcast_status.terminal_state');
      }
    }
  });
});
