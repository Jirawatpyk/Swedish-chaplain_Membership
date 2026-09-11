/**
 * F114 — Change-request aggregate types (data-model.md § 1, § 2, § 4, § 7).
 *
 * Hand-declared Domain types; the Drizzle-inferred row types stay in
 * Infrastructure (`schema-change-requests.ts`) and are mapped at the repo.
 *
 * State machine (§ 4):
 *   pending ─┬─ decide(all approved)    → decided / approved
 *            ├─ decide(some rejected)   → decided / partially_approved
 *            ├─ decide(all rejected)    → decided / rejected
 *            ├─ withdraw (member)       → withdrawn / member
 *            ├─ resubmit by same person → withdrawn / replaced (+ new pending)
 *            └─ erasure of the member   → withdrawn / erasure (system actor)
 *   decided | withdrawn are terminal.
 *
 * Pure TypeScript — no framework imports.
 */
import type { ContactId } from '../contact';
import type { UserId } from '../value-objects/user-id';
import type { MemberId, TenantId } from '../member';
import type {
  BillingAddress,
  ProposableFieldKey,
  ProposedFieldTarget,
  RegisteredAddress,
} from './proposable-fields';

export const CHANGE_REQUEST_STATES = ['pending', 'decided', 'withdrawn'] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

export const CHANGE_REQUEST_OUTCOMES = ['approved', 'partially_approved', 'rejected'] as const;
export type ChangeRequestOutcome = (typeof CHANGE_REQUEST_OUTCOMES)[number];

export const WITHDRAWN_REASONS = ['member', 'replaced', 'erasure'] as const;
export type WithdrawnReason = (typeof WITHDRAWN_REASONS)[number];

export const FIELD_OUTCOMES = ['approved', 'rejected'] as const;
export type FieldOutcome = (typeof FIELD_OUTCOMES)[number];

export const CHANGE_REQUEST_SCOPES = ['company', 'own_contact', 'mixed'] as const;
export type ChangeRequestScope = (typeof CHANGE_REQUEST_SCOPES)[number];

export const SUBMITTER_ROLES = ['primary', 'secondary'] as const;
export type SubmitterRole = (typeof SUBMITTER_ROLES)[number];

/** Opaque id of a change request (uuid). */
export type ChangeRequestId = string & { readonly __brand: 'ChangeRequestId' };

/**
 * A proposed / seen value: a scalar for every key except the two address
 * groups, which carry the whole address object. `null` = the field is (or is
 * proposed to be) empty. Stored as `jsonb` (data-model § 2).
 */
export type ProposedValue = string | null | RegisteredAddress | BillingAddress;

/** One row of `member_change_request_fields` (data-model.md § 2). */
export type ProposedField = {
  readonly key: ProposableFieldKey;
  readonly target: ProposedFieldTarget;
  /** The value the member saw at submission. */
  readonly seen: ProposedValue;
  /** The value the member proposes; `null` = clear (nullable fields only). */
  readonly proposed: ProposedValue;
  /** Computed at submit (FR-019); see `affectsTaxDocuments`. */
  readonly affectsTaxDocuments: boolean;
  readonly outcome: FieldOutcome | null;
  readonly appliedAt: Date | null;
};

/** One row of `member_change_requests` with its field rows (data-model.md § 1). */
export type ChangeRequest = {
  readonly id: ChangeRequestId;
  readonly tenantId: TenantId;
  readonly memberId: MemberId;
  readonly submittedByUserId: UserId;
  readonly submittedByContactId: ContactId;
  readonly submitterRoleAtSubmission: SubmitterRole;
  readonly scope: ChangeRequestScope;
  readonly state: ChangeRequestState;
  readonly outcome: ChangeRequestOutcome | null;
  readonly withdrawnReason: WithdrawnReason | null;
  readonly replacedByRequestId: ChangeRequestId | null;
  readonly submittedAt: Date;
  /** Last staff notification for this submitter; inherited on a coalesced replacement (R8). */
  readonly staffNotifiedAt: Date | null;
  readonly decidedAt: Date | null;
  readonly decidedByUserId: UserId | null;
  readonly decisionReason: string | null;
  readonly decisionNote: string | null;
  readonly withdrawnAt: Date | null;
  /** Set when the submitting person dismisses the shown decision (FR-010). */
  readonly outcomeAcknowledgedAt: Date | null;
  readonly fields: readonly ProposedField[];
};

/**
 * The state machine's two terminal shapes, as TYPES (round 6, types F6). The
 * flat `ChangeRequest` keeps every nullable column nullable — a full
 * discriminated union would force every fixture and serialiser to build one
 * variant at a time, so the invariants are instead PARSED once, at the DB →
 * Domain seam (`rowToDomain` throws on a row that contradicts them, exactly
 * as migration 0300's `outcome_iff_decided_ck` / `decision_iff_decided_ck` /
 * `reason_iff_withdrawn_ck` / `withdrawn_at_iff_withdrawn_ck` forbid one),
 * and narrowed once, here, so no consumer re-derives "decided ⇒ has an
 * outcome" with its own null checks and its own fallback.
 */
export type DecidedChangeRequest = ChangeRequest & {
  readonly state: 'decided';
  readonly outcome: ChangeRequestOutcome;
  readonly decidedAt: Date;
  readonly decidedByUserId: UserId;
};

export type WithdrawnChangeRequest = ChangeRequest & {
  readonly state: 'withdrawn';
  readonly withdrawnReason: WithdrawnReason;
  readonly withdrawnAt: Date;
};

export function isDecided(r: ChangeRequest): r is DecidedChangeRequest {
  return r.state === 'decided' && r.outcome !== null && r.decidedAt !== null && r.decidedByUserId !== null;
}

export function isWithdrawn(r: ChangeRequest): r is WithdrawnChangeRequest {
  return r.state === 'withdrawn' && r.withdrawnReason !== null && r.withdrawnAt !== null;
}

/**
 * The seam check: a row whose columns contradict its `state` is corrupt (the
 * DB CHECKs make it unreachable; this is what makes the guards above TOTAL).
 * Returns the message, or null when the row is consistent.
 */
export function changeRequestInvariantViolation(r: ChangeRequest): string | null {
  switch (r.state) {
    case 'pending':
      if (r.outcome !== null || r.decidedAt !== null || r.decidedByUserId !== null || r.withdrawnAt !== null || r.withdrawnReason !== null) {
        return `pending request ${r.id} carries decision / withdrawal columns`;
      }
      return null;
    case 'decided':
      if (!isDecided(r)) return `decided request ${r.id} lacks outcome / decidedAt / decidedByUserId`;
      if (r.withdrawnAt !== null || r.withdrawnReason !== null) return `decided request ${r.id} carries withdrawal columns`;
      return null;
    case 'withdrawn':
      if (!isWithdrawn(r)) return `withdrawn request ${r.id} lacks withdrawnReason / withdrawnAt`;
      if (r.outcome !== null || r.decidedAt !== null) return `withdrawn request ${r.id} carries decision columns`;
      return null;
    default: {
      const _exhaustive: never = r.state;
      void _exhaustive;
      return `request ${r.id} has an unknown state`;
    }
  }
}

/** Reason / note bounds (FR-014). Plain text, rendered escaped, never as markup. */
export const DECISION_REASON_MAX_LENGTH = 1000;
export const DECISION_NOTE_MAX_LENGTH = 1000;

/** FR-008 — the durable per-person cap, counted from the request history itself. */
export const SUBMISSIONS_PER_WINDOW_CAP = 10;
export const SUBMISSION_WINDOW_HOURS = 24;

/** FR-011 — no new staff email within this window of the last one for the same person. */
export const STAFF_NOTIFICATION_COALESCE_HOURS = 1;

/** FR-027 — a pending request older than this is visually flagged in the queue. */
export const OVERDUE_AFTER_DAYS = 3;
