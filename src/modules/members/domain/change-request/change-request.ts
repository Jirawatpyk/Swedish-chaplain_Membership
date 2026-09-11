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
