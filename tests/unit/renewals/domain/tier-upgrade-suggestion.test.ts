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
    reasonCode: 'declared_turnover_above_threshold',
    evidence: { turnoverThb: 50_000_000 },
    status: 'open',
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
  };
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

  it('rejects open + closed_at set', () => {
    const r = assertSuggestionInvariants(
      buildSuggestion({ closedAt: '2026-05-01T00:00:00Z' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('open_has_closed_at');
  });

  it('rejects accepted_pending_apply without anchors', () => {
    const r = assertSuggestionInvariants(
      buildSuggestion({ status: 'accepted_pending_apply' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('accepted_missing_anchors');
  });

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

  it('rejects applied without anchors', () => {
    const r = assertSuggestionInvariants(
      buildSuggestion({ status: 'applied' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('applied_missing_anchors');
  });

  it('accepts applied with full anchors', () => {
    expect(
      assertSuggestionInvariants(
        buildSuggestion({
          status: 'applied',
          appliedAt: '2026-06-01T00:00:00Z',
          appliedAtInvoiceId: '00000000-0000-0000-0000-0000000000d1',
          closedAt: '2026-06-01T00:00:00Z',
        }),
      ).ok,
    ).toBe(true);
  });

  it('rejects dismissed without reason or closed_at', () => {
    const r1 = assertSuggestionInvariants(
      buildSuggestion({ status: 'dismissed', closedAt: '2026-05-01T00:00:00Z' }),
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.kind).toBe('dismissed_missing_anchors');

    const r2 = assertSuggestionInvariants(
      buildSuggestion({ status: 'dismissed', dismissedReason: 'no thanks' }),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.kind).toBe('dismissed_missing_anchors');
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

  it('rejects superseded/auto_resolved without closed_at', () => {
    expect(
      assertSuggestionInvariants(buildSuggestion({ status: 'superseded' })).ok,
    ).toBe(false);
    expect(
      assertSuggestionInvariants(buildSuggestion({ status: 'auto_resolved' })).ok,
    ).toBe(false);
  });

  it('accepts superseded with closed_at', () => {
    expect(
      assertSuggestionInvariants(
        buildSuggestion({ status: 'superseded', closedAt: '2026-06-01T00:00:00Z' }),
      ).ok,
    ).toBe(true);
  });

  it('rejects dismissed_reason >500 chars', () => {
    const r = assertSuggestionInvariants(
      buildSuggestion({ dismissedReason: 'x'.repeat(501) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('dismissed_reason_too_long');
  });
});
