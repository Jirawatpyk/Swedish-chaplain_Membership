/**
 * F114 — the staff `StaffChangeRequestView` (contracts/admin-change-requests-
 * api.md), shared by the admin API routes and the staff pages (review page,
 * queue, member-record section).
 *
 * Unlike the portal view this one DOES carry the reviewer (`decidedBy` with
 * the "deactivated" marker, FR-026) and the submitter's display name, and the
 * staff-only `decisionNote`. Timestamps are UTC ISO-8601; the client formats
 * (BE for `th-TH`, display-only). Pure — no framework imports.
 */
import type { ChangeRequest, ChangeRequestListRow } from '@/modules/members';
import type { ChangeRequestReviewField, TaxHint } from '@/modules/members/application/use-cases/change-requests/get-change-request-review';
import { serialiseField, type ChangeRequestFieldView } from './change-request-portal-view';

export interface StaffChangeRequestView {
  readonly id: string;
  readonly memberId: string;
  readonly scope: ChangeRequest['scope'];
  readonly state: ChangeRequest['state'];
  readonly outcome: ChangeRequest['outcome'];
  readonly withdrawnReason: ChangeRequest['withdrawnReason'];
  readonly replacedByRequestId: string | null;
  readonly submittedAt: string;
  readonly staffNotifiedAt: string | null;
  readonly submittedBy: {
    readonly contactId: string;
    readonly displayName: string;
    readonly roleAtSubmission: ChangeRequest['submitterRoleAtSubmission'];
  };
  readonly decidedAt: string | null;
  readonly decidedBy: { readonly displayName: string; readonly deactivated: boolean } | null;
  readonly decisionReason: string | null;
  readonly decisionNote: string | null;
  readonly withdrawnAt: string | null;
  readonly outcomeAcknowledgedAt: string | null;
  readonly fields: readonly ChangeRequestFieldView[];
}

export interface ChangeRequestReviewFieldView extends ChangeRequestFieldView {
  readonly current: ChangeRequestFieldView['proposed'];
  readonly changedSinceSubmitted: boolean;
  readonly alreadyCurrent: boolean;
  readonly taxHint: TaxHint | null;
  readonly undecidable: 'contact_removed' | null;
}

export function serialiseChangeRequestForStaff(row: ChangeRequestListRow): StaffChangeRequestView {
  const r = row.request;
  return {
    id: r.id,
    memberId: r.memberId,
    scope: r.scope,
    state: r.state,
    outcome: r.outcome,
    withdrawnReason: r.withdrawnReason,
    replacedByRequestId: r.replacedByRequestId,
    submittedAt: r.submittedAt.toISOString(),
    staffNotifiedAt: r.staffNotifiedAt?.toISOString() ?? null,
    submittedBy: {
      contactId: r.submittedByContactId,
      displayName: row.submitter.displayName,
      roleAtSubmission: r.submitterRoleAtSubmission,
    },
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    decisionReason: r.decisionReason,
    decisionNote: r.decisionNote,
    withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
    outcomeAcknowledgedAt: r.outcomeAcknowledgedAt?.toISOString() ?? null,
    fields: r.fields.map(serialiseField),
  };
}

export function serialiseReviewField(f: ChangeRequestReviewField): ChangeRequestReviewFieldView {
  return {
    ...serialiseField(f),
    current: f.current,
    changedSinceSubmitted: f.changedSinceSubmitted,
    alreadyCurrent: f.alreadyCurrent,
    taxHint: f.taxHint,
    undecidable: f.undecidable,
  };
}
