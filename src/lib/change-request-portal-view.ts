/**
 * F114 — the portal `ChangeRequestView` (contracts/portal-change-requests-api.md
 * § ChangeRequestView), shared by the portal API routes and the portal pages
 * (pending banner, edit page, history).
 *
 * The portal NEVER exposes the reviewer's identity: `decidedBy` is the
 * literal `"organisation"` (FR-029), and no `*UserId` column reaches the
 * wire or the page. Timestamps are UTC ISO-8601; the client formats (BE for
 * `th-TH`, display-only). Pure — no framework imports — so it is safe in
 * client components too.
 */
import type { ChangeRequest, ProposedField } from '@/modules/members';

export interface PortalSubmitter {
  readonly contactId: string;
  readonly displayName: string;
  readonly isMe: boolean;
}

export interface ChangeRequestFieldView {
  readonly key: ProposedField['key'];
  readonly target: ProposedField['target'];
  readonly seen: ProposedField['seen'];
  readonly proposed: ProposedField['proposed'];
  readonly affectsTaxDocuments: boolean;
  readonly outcome: ProposedField['outcome'];
  readonly appliedAt: string | null;
}

export interface ChangeRequestView {
  readonly id: string;
  readonly memberId: string;
  readonly scope: ChangeRequest['scope'];
  readonly state: ChangeRequest['state'];
  readonly outcome: ChangeRequest['outcome'];
  readonly withdrawnReason: ChangeRequest['withdrawnReason'];
  readonly submittedAt: string;
  readonly submittedBy: PortalSubmitter;
  readonly decidedAt: string | null;
  readonly decidedBy: 'organisation';
  readonly decisionReason: string | null;
  readonly outcomeAcknowledgedAt: string | null;
  readonly fields: readonly ChangeRequestFieldView[];
}

export function serialiseField(f: ProposedField): ChangeRequestFieldView {
  return {
    key: f.key,
    target: f.target,
    seen: f.seen,
    proposed: f.proposed,
    affectsTaxDocuments: f.affectsTaxDocuments,
    outcome: f.outcome,
    appliedAt: f.appliedAt?.toISOString() ?? null,
  };
}

export function serialiseChangeRequestForPortal(
  request: ChangeRequest,
  submittedBy: PortalSubmitter,
): ChangeRequestView {
  return {
    id: request.id,
    memberId: request.memberId,
    scope: request.scope,
    state: request.state,
    outcome: request.outcome,
    withdrawnReason: request.withdrawnReason,
    submittedAt: request.submittedAt.toISOString(),
    submittedBy,
    decidedAt: request.decidedAt?.toISOString() ?? null,
    decidedBy: 'organisation',
    decisionReason: request.decisionReason,
    outcomeAcknowledgedAt: request.outcomeAcknowledgedAt?.toISOString() ?? null,
    fields: request.fields.map(serialiseField),
  };
}
