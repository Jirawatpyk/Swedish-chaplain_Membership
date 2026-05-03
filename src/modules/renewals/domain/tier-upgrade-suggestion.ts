/**
 * T035 (F8 Phase 2 Wave D) — `TierUpgradeSuggestion` aggregate.
 *
 * Domain shape of `tier_upgrade_suggestions` (data-model.md § 2.6;
 * migration 0091). 6-state machine extended at /speckit.clarify Q5
 * round 2.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

declare const SuggestionIdBrand: unique symbol;
export type SuggestionId = string & {
  readonly [SuggestionIdBrand]: true;
};

const RE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SuggestionIdError = {
  readonly kind: 'invalid_suggestion_id';
  readonly raw: string;
};

export function asSuggestionId(raw: string): SuggestionId {
  return raw as SuggestionId;
}

export function parseSuggestionId(
  raw: string,
): Result<SuggestionId, SuggestionIdError> {
  if (typeof raw !== 'string' || !RE_UUID.test(raw)) {
    return err({ kind: 'invalid_suggestion_id', raw });
  }
  return ok(raw as SuggestionId);
}

export const TIER_UPGRADE_STATUSES = [
  'open',
  'accepted_pending_apply',
  'applied',
  'dismissed',
  'superseded',
  'auto_resolved',
] as const;

export type TierUpgradeStatus = (typeof TIER_UPGRADE_STATUSES)[number];

export const TERMINAL_TIER_UPGRADE_STATUSES = [
  'applied',
  'dismissed',
  'superseded',
  'auto_resolved',
] as const satisfies readonly TierUpgradeStatus[];

export type TerminalTierUpgradeStatus =
  (typeof TERMINAL_TIER_UPGRADE_STATUSES)[number];

export const TIER_UPGRADE_REASON_CODES = [
  'declared_turnover_above_threshold',
  'paid_invoice_volume_above_threshold',
  'multi_signal',
] as const;

export type TierUpgradeReasonCode =
  (typeof TIER_UPGRADE_REASON_CODES)[number];

export interface TierUpgradeEvidence {
  readonly turnoverThb?: number;
  readonly invoiceVolumeThb?: number;
  readonly thresholdMetAt?: string;
  readonly [key: string]: unknown;
}

export interface TierUpgradeSuggestion {
  readonly tenantId: string;
  readonly suggestionId: SuggestionId;
  readonly memberId: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;
  readonly reasonCode: TierUpgradeReasonCode;
  readonly evidence: TierUpgradeEvidence;
  readonly status: TierUpgradeStatus;
  readonly suppressedUntil: string | null;
  readonly dismissedReason: string | null;

  // Pending-apply lifecycle (Q5 round 2).
  readonly acceptedAt: string | null;
  readonly acceptedByUserId: string | null;
  readonly targetApplyAtCycleId: string | null;
  readonly appliedAt: string | null;
  readonly appliedAtInvoiceId: string | null;
  readonly memberNotifiedAt: string | null;
  readonly adminVerificationTaskId: string | null;

  readonly createdAt: string;
  readonly closedAt: string | null;
}

export type TierUpgradeInvariantError =
  | { readonly kind: 'accepted_missing_anchors'; readonly status: TierUpgradeStatus }
  | { readonly kind: 'applied_missing_anchors'; readonly status: TierUpgradeStatus }
  | { readonly kind: 'dismissed_missing_anchors'; readonly status: TierUpgradeStatus }
  | { readonly kind: 'terminal_missing_closed_at'; readonly status: TierUpgradeStatus }
  | { readonly kind: 'dismissed_reason_too_long'; readonly length: number }
  | { readonly kind: 'open_has_closed_at' };

/**
 * Mirrors the migration 0091 status-lifecycle CHECK constraints. Useful
 * for in-memory adapters / tests that bypass the DB layer.
 */
export function assertSuggestionInvariants(
  s: TierUpgradeSuggestion,
): Result<void, TierUpgradeInvariantError> {
  if (s.dismissedReason != null && s.dismissedReason.length > 500) {
    return err({
      kind: 'dismissed_reason_too_long',
      length: s.dismissedReason.length,
    });
  }
  if (s.status === 'open' && s.closedAt != null) {
    return err({ kind: 'open_has_closed_at' });
  }
  if (s.status === 'accepted_pending_apply') {
    if (
      s.acceptedAt == null ||
      s.acceptedByUserId == null ||
      s.targetApplyAtCycleId == null
    ) {
      return err({ kind: 'accepted_missing_anchors', status: s.status });
    }
  }
  if (s.status === 'applied') {
    if (
      s.appliedAt == null ||
      s.appliedAtInvoiceId == null ||
      s.closedAt == null
    ) {
      return err({ kind: 'applied_missing_anchors', status: s.status });
    }
  }
  if (s.status === 'dismissed') {
    if (s.dismissedReason == null || s.closedAt == null) {
      return err({ kind: 'dismissed_missing_anchors', status: s.status });
    }
  }
  if (s.status === 'superseded' || s.status === 'auto_resolved') {
    if (s.closedAt == null) {
      return err({ kind: 'terminal_missing_closed_at', status: s.status });
    }
  }
  return ok(undefined);
}

export function isTerminalTierUpgradeStatus(
  status: TierUpgradeStatus,
): status is TerminalTierUpgradeStatus {
  return (TERMINAL_TIER_UPGRADE_STATUSES as readonly string[]).includes(status);
}
