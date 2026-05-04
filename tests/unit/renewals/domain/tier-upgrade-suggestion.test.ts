/**
 * T035 spec — TierUpgradeSuggestion invariants.
 */
import { describe, expect, it } from 'vitest';
import {
  TIER_UPGRADE_STATUSES,
  TIER_UPGRADE_REASON_CODES,
  asSuggestionId,
  parseSuggestionId,
  assertSuggestionInvariants,
  isTerminalTierUpgradeStatus,
  type TierUpgradeSuggestion,
} from '@/modules/renewals/domain/tier-upgrade-suggestion';

const VALID_UUID = '00000000-0000-0000-0000-0000000000a1';

function buildSuggestion(
  overrides: Partial<TierUpgradeSuggestion> = {},
): TierUpgradeSuggestion {
  return {
    tenantId: 't',
    suggestionId: asSuggestionId(VALID_UUID),
    memberId: 'm',
    fromPlanId: '00000000-0000-0000-0000-0000000000aa',
    toPlanId: '00000000-0000-0000-0000-0000000000ab',
    reasonCode: 'declared_turnover_above_threshold' as const,
    evidence: { turnoverThb: 50_000_000 },
    status: 'open' as const,
    suppressedUntil: null,
    dismissedReason: null,
    acceptedAt: null,
    acceptedByUserId: null,
    targetApplyAtCycleId: null,
    appliedAt: null,
    appliedAtInvoiceId: null,
    memberNotifiedAt: null,
    adminVerificationTaskId: null,
    createdAt: '2026-05-01T00:00:00Z',
    closedAt: null,
    ...overrides,
  } as TierUpgradeSuggestion;
}

describe('SuggestionId brand', () => {
  it('asSuggestionId — unchecked cast', () => {
    expect(asSuggestionId('any')).toBe('any');
  });
  it('parseSuggestionId — accepts UUID', () => {
    expect(parseSuggestionId(VALID_UUID).ok).toBe(true);
  });
  it('parseSuggestionId — rejects malformed', () => {
    const r = parseSuggestionId('bad');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_suggestion_id');
  });
  it('parseSuggestionId — rejects non-string', () => {
    expect(parseSuggestionId(undefined as unknown as string).ok).toBe(false);
  });
});

describe('TIER_UPGRADE_STATUSES + REASON_CODES', () => {
  it('6-state machine + 3 reason codes', () => {
    expect(TIER_UPGRADE_STATUSES.length).toBe(6);
    expect(TIER_UPGRADE_REASON_CODES.length).toBe(3);
  });
});

describe('isTerminalTierUpgradeStatus', () => {
  it('true for applied/dismissed/superseded/auto_resolved', () => {
    expect(isTerminalTierUpgradeStatus('applied')).toBe(true);
    expect(isTerminalTierUpgradeStatus('dismissed')).toBe(true);
    expect(isTerminalTierUpgradeStatus('superseded')).toBe(true);
    expect(isTerminalTierUpgradeStatus('auto_resolved')).toBe(true);
  });
  it('false for open/accepted_pending_apply', () => {
    expect(isTerminalTierUpgradeStatus('open')).toBe(false);
    expect(isTerminalTierUpgradeStatus('accepted_pending_apply')).toBe(false);
  });
});

describe('assertSuggestionInvariants', () => {
  it('happy path — open suggestion', () => {
    expect(assertSuggestionInvariants(buildSuggestion()).ok).toBe(true);
  });

  // The 5 status-conditional invariants previously asserted at runtime
  // (open_has_closed_at, accepted_missing_anchors, applied_missing_anchors,
  // dismissed_missing_anchors, terminal_missing_closed_at) are now
  // enforced at COMPILE TIME by the TierUpgradeSuggestion discriminated
  // union. The happy-path cases below confirm the type-system permits
  // each valid combination.

  it('accepts accepted_pending_apply with full anchors', () => {
    expect(
      assertSuggestionInvariants(
        buildSuggestion({
          status: 'accepted_pending_apply',
          acceptedAt: '2026-05-01T00:00:00Z',
          acceptedByUserId: '00000000-0000-0000-0000-0000000000aa',
          targetApplyAtCycleId: VALID_UUID,
        }),
      ).ok,
    ).toBe(true);
  });

  it('accepts applied with full anchors', () => {
    expect(
      assertSuggestionInvariants(
        buildSuggestion({
          status: 'applied',
          acceptedAt: '2026-05-01T00:00:00Z',
          acceptedByUserId: '00000000-0000-0000-0000-0000000000aa',
          targetApplyAtCycleId: VALID_UUID,
          appliedAt: '2026-06-01T00:00:00Z',
          appliedAtInvoiceId: '00000000-0000-0000-0000-0000000000d1',
          closedAt: '2026-06-01T00:00:00Z',
        }),
      ).ok,
    ).toBe(true);
  });

  it('accepts dismissed with full anchors', () => {
    expect(
      assertSuggestionInvariants(
        buildSuggestion({
          status: 'dismissed',
          dismissedReason: 'no thanks',
          closedAt: '2026-05-01T00:00:00Z',
        }),
      ).ok,
    ).toBe(true);
  });

  it('accepts superseded with closed_at', () => {
    expect(
      assertSuggestionInvariants(
        buildSuggestion({ status: 'superseded', closedAt: '2026-06-01T00:00:00Z' }),
      ).ok,
    ).toBe(true);
  });

  it('compile-error: open with closedAt set', () => {
    // @ts-expect-error — open requires closedAt: null
    const _illegal: TierUpgradeSuggestion = {
      ...buildSuggestion(),
      status: 'open',
      closedAt: '2026-05-01T00:00:00Z',
    };
    expect(_illegal).toBeDefined();
  });

  it('compile-error: applied without acceptedAt anchor', () => {
    // @ts-expect-error — applied requires acceptedAt: string (NOT NULL)
    const _illegal: TierUpgradeSuggestion = {
      ...buildSuggestion(),
      status: 'applied',
      acceptedAt: null,
      appliedAt: '2026-06-01T00:00:00Z',
      appliedAtInvoiceId: 'inv-1',
      closedAt: '2026-06-01T00:00:00Z',
    };
    expect(_illegal).toBeDefined();
  });

  it('rejects dismissed_reason >500 chars', () => {
    const r = assertSuggestionInvariants(
      buildSuggestion({ dismissedReason: 'x'.repeat(501) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('dismissed_reason_too_long');
  });
});
