/**
 * F119 T054 — the member's decision on a version, and its reason rules
 * (FR-009, FR-010, FR-015a, FR-018; data-model §§ 2, 10, 12).
 *
 * The reason bounds mirror the one `broadcast_member_decisions` CHECK:
 *   - `approved`: optional note — **null, or 1–500 chars**. Never "0–500": an
 *     empty string would pass a `{ min: 0 }` Domain check and then be refused
 *     by `reason IS NULL OR char_length(reason) BETWEEN 1 AND 500`, i.e. a 500
 *     at runtime instead of a 422.
 *   - `changes_requested` / `approval_withdrawn`: mandatory, 1–2,000 chars.
 *
 * Lengths count Unicode code points, as Postgres `char_length` does — not
 * UTF-16 units, which would refuse 250 emoji as 500 "characters".
 *
 * A whitespace-only reason is refused as empty: it satisfies the CHECK but
 * says nothing, and a mandatory reason that says nothing is not one. This is
 * stricter than the DB, never looser.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { BroadcastId } from '../broadcast';

export const MEMBER_DECISION_KINDS = [
  'approved',
  'changes_requested',
  'approval_withdrawn',
] as const;

export type MemberDecisionKind = (typeof MEMBER_DECISION_KINDS)[number];

export interface MemberDecision {
  readonly id: string;
  readonly tenantId: string;
  readonly broadcastId: BroadcastId;
  readonly versionId: string;
  readonly round: number;
  readonly decision: MemberDecisionKind;
  readonly reason: string | null;
  readonly decidedByUserId: string;
  readonly decidedByContactId: string;
  readonly decidedAt: Date;
}

export interface ReasonBounds {
  readonly min: 1;
  readonly max: 500 | 2000;
  readonly nullable: boolean;
}

const APPROVAL_NOTE_BOUNDS: ReasonBounds = { min: 1, max: 500, nullable: true };
const MANDATORY_REASON_BOUNDS: ReasonBounds = { min: 1, max: 2000, nullable: false };

export function requiresReason(kind: MemberDecisionKind): boolean {
  return kind !== 'approved';
}

export function reasonBounds(kind: MemberDecisionKind): ReasonBounds {
  return requiresReason(kind) ? MANDATORY_REASON_BOUNDS : APPROVAL_NOTE_BOUNDS;
}

export type DecisionReasonError =
  | { readonly code: 'reason_required' }
  | { readonly code: 'reason_empty' }
  | { readonly code: 'reason_too_long'; readonly max: ReasonBounds['max'] };

/**
 * Validate a decision reason against `reasonBounds(kind)`. Returns the reason
 * unchanged on success (null only for an approval without a note).
 */
export function validateDecisionReason(
  kind: MemberDecisionKind,
  reason: string | null,
): Result<string | null, DecisionReasonError> {
  const bounds = reasonBounds(kind);
  if (reason === null) {
    return bounds.nullable ? ok(null) : err({ code: 'reason_required' });
  }
  if (reason.trim() === '') return err({ code: 'reason_empty' });
  if ([...reason].length > bounds.max) {
    return err({ code: 'reason_too_long', max: bounds.max });
  }
  return ok(reason);
}

/**
 * FR-018 — does the confirmed send time differ from the member's proposal?
 * Compared as instants. No proposal at all counts as a difference: the
 * member is told the confirmed time was not one they asked for.
 */
export function scheduleDiffers(proposed: Date | null, confirmed: Date): boolean {
  return proposed === null || proposed.getTime() !== confirmed.getTime();
}
