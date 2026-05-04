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

/**
 * Evidence shape — closed discriminated union by `reasonCode`. Each
 * arm pairs the reason with the metric(s) that justify it, so a future
 * emit site can't write `{ turnoverThb: 50_000_000 }` against a
 * `paid_invoice_volume_above_threshold` reason (silent forensic drift).
 *
 * Open index signature was previously permitted (`[key: string]:
 * unknown`) — a deliberate Round 3 tightening: every arm is now
 * exhaustive, and consumers that need additional fields must amend the
 * union explicitly.
 */
export type TierUpgradeEvidence =
  | {
      readonly reasonCode: 'declared_turnover_above_threshold';
      readonly turnoverThb: number;
      readonly thresholdMetAt: string;
    }
  | {
      readonly reasonCode: 'paid_invoice_volume_above_threshold';
      readonly invoiceVolumeThb: number;
      readonly thresholdMetAt: string;
    }
  | {
      readonly reasonCode: 'multi_signal';
      readonly turnoverThb: number;
      readonly invoiceVolumeThb: number;
      readonly thresholdMetAt: string;
    };

/**
 * Common fields across every tier-upgrade lifecycle state.
 *
 * Round 4: `reasonCode` and `evidence.reasonCode` are tied via the
 * generic parameter `R extends TierUpgradeReasonCode` + `Extract<>`.
 * This prevents the previously-allowed incoherent state
 * `{ reasonCode: 'multi_signal', evidence: { reasonCode: 'declared_turnover_above_threshold', ... } }`
 * — the compiler now requires both discriminators to agree.
 */
interface TierUpgradeSuggestionBase<R extends TierUpgradeReasonCode = TierUpgradeReasonCode> {
  readonly tenantId: string;
  readonly suggestionId: SuggestionId;
  readonly memberId: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;
  readonly reasonCode: R;
  readonly evidence: Extract<TierUpgradeEvidence, { reasonCode: R }>;
  readonly suppressedUntil: string | null;
  readonly memberNotifiedAt: string | null;
  readonly adminVerificationTaskId: string | null;
  readonly createdAt: string;
}

/** Open: no admin action yet. No accept/apply/close anchors set. */
interface OpenTierUpgradeFields {
  readonly status: 'open';
  readonly acceptedAt: null;
  readonly acceptedByUserId: null;
  readonly targetApplyAtCycleId: null;
  readonly appliedAt: null;
  readonly appliedAtInvoiceId: null;
  readonly dismissedReason: null;
  readonly closedAt: null;
}

/** Admin accepted; waiting for next cycle to apply. */
interface AcceptedPendingApplyFields {
  readonly status: 'accepted_pending_apply';
  readonly acceptedAt: string;
  readonly acceptedByUserId: string;
  readonly targetApplyAtCycleId: string;
  readonly appliedAt: null;
  readonly appliedAtInvoiceId: null;
  readonly dismissedReason: null;
  readonly closedAt: null;
}

/** Terminal — successfully applied at next renewal. */
interface AppliedTierUpgradeFields {
  readonly status: 'applied';
  readonly acceptedAt: string;
  readonly acceptedByUserId: string;
  readonly targetApplyAtCycleId: string;
  readonly appliedAt: string;
  readonly appliedAtInvoiceId: string;
  readonly dismissedReason: null;
  readonly closedAt: string;
}

/** Terminal — admin dismissed. */
interface DismissedTierUpgradeFields {
  readonly status: 'dismissed';
  readonly acceptedAt: null;
  readonly acceptedByUserId: null;
  readonly targetApplyAtCycleId: null;
  readonly appliedAt: null;
  readonly appliedAtInvoiceId: null;
  readonly dismissedReason: string;
  readonly closedAt: string;
}

/**
 * Terminal — admin manually changed plan via F2 before rollover, while
 * the suggestion was still `open` (no admin commitment). Pre-acceptance
 * supersede.
 */
interface SupersededFromOpenFields {
  readonly status: 'superseded';
  readonly supersededFrom: 'open';
  readonly acceptedAt: null;
  readonly acceptedByUserId: null;
  readonly targetApplyAtCycleId: null;
  readonly appliedAt: null;
  readonly appliedAtInvoiceId: null;
  readonly dismissedReason: null;
  readonly closedAt: string;
}

/**
 * Terminal — admin manually changed plan via F2 AFTER accepting the
 * suggestion. Post-acceptance supersede; admin work was invalidated.
 * Forensics matter: the audit trail must show admin previously
 * accepted (acceptedByUserId) so reviewers can understand why a
 * pending tier-upgrade was dropped.
 */
interface SupersededFromAcceptedFields {
  readonly status: 'superseded';
  readonly supersededFrom: 'accepted_pending_apply';
  readonly acceptedAt: string;
  readonly acceptedByUserId: string;
  readonly targetApplyAtCycleId: string;
  readonly appliedAt: null;
  readonly appliedAtInvoiceId: null;
  readonly dismissedReason: null;
  readonly closedAt: string;
}

/** Terminal — member reached target tier via other path. */
interface AutoResolvedTierUpgradeFields {
  readonly status: 'auto_resolved';
  readonly acceptedAt: null;
  readonly acceptedByUserId: null;
  readonly targetApplyAtCycleId: null;
  readonly appliedAt: null;
  readonly appliedAtInvoiceId: null;
  readonly dismissedReason: null;
  readonly closedAt: string;
}

/**
 * `TierUpgradeSuggestion` distributes across reason codes so each
 * suggestion's `reasonCode` is tied to its `evidence.reasonCode` via
 * the `R` parameter on the base. Each lifecycle arm composes with all
 * 3 reason codes, yielding 3×7 = 21 valid concrete shapes.
 */
export type TierUpgradeSuggestion = {
  [R in TierUpgradeReasonCode]: TierUpgradeSuggestionBase<R> &
    (
      | OpenTierUpgradeFields
      | AcceptedPendingApplyFields
      | AppliedTierUpgradeFields
      | DismissedTierUpgradeFields
      | SupersededFromOpenFields
      | SupersededFromAcceptedFields
      | AutoResolvedTierUpgradeFields
    );
}[TierUpgradeReasonCode];

export type TierUpgradeInvariantError = {
  readonly kind: 'dismissed_reason_too_long';
  readonly length: number;
};

/**
 * Runtime invariants the type system can't express. Status-conditional
 * anchor invariants (accepted_missing_anchors, applied_missing_anchors,
 * dismissed_missing_anchors, terminal_missing_closed_at,
 * open_has_closed_at) are enforced at compile time by the
 * `TierUpgradeSuggestion` discriminated union.
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
  return ok(undefined);
}

export function isTerminalTierUpgradeStatus(
  status: TierUpgradeStatus,
): status is TerminalTierUpgradeStatus {
  return (TERMINAL_TIER_UPGRADE_STATUSES as readonly string[]).includes(status);
}
