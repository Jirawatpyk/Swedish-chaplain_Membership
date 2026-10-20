/**
 * Spec 122 US12c-1 follow-up (maintainer, 20 Oct) — the "whose turn" bar
 * under the staff detail header, as boards `Admin-broadcast-review`,
 * `Admin-eblast-design`, `-awaiting-member`, `-changes-requested` and
 * `-member-approved` draw it: one line saying who acts next and what.
 */
import { describe, expect, it } from 'vitest';
import { turnBar } from '@/app/(staff)/admin/broadcasts/[id]/_components/turn-bar';

const entered = new Date('2026-09-26T03:05:00Z');
const now = new Date('2026-10-01T00:00:00Z');
const base = { round: 0, memberApprovalOn: true, stageEnteredAt: entered, proposedSendAt: null, now } as const;

describe('turnBar', () => {
  it('submitted: marketing reviews it; the formatted-version option only while the approval round is on', () => {
    expect(turnBar({ ...base, status: 'submitted' })).toEqual({ kind: 'review', canFormat: true });
    expect(turnBar({ ...base, status: 'submitted', memberApprovalOn: false })).toEqual({ kind: 'review', canFormat: false });
  });

  it('in design: marketing finishes the formatted version', () => {
    expect(turnBar({ ...base, status: 'in_design', round: 1 })).toEqual({ kind: 'design' });
  });

  it("awaiting the member: the version sent, when, and the request's 30-day expiry", () => {
    expect(turnBar({ ...base, status: 'awaiting_member_approval', round: 2 })).toEqual({
      kind: 'awaitingMember',
      version: 2,
      sentAt: entered,
      expiresAt: new Date('2026-10-26T03:05:00Z'),
    });
  });

  it('awaiting the member past the 30 days (the closing job not run yet): says it has expired, not a past date', () => {
    expect(turnBar({ ...base, status: 'awaiting_member_approval', round: 1, now: new Date('2026-10-26T03:05:00Z') })).toEqual({
      kind: 'awaitingMemberExpired',
      version: 1,
      sentAt: entered,
    });
  });

  it('changes requested: marketing starts the next formatted version', () => {
    expect(turnBar({ ...base, status: 'changes_requested', round: 1 })).toEqual({ kind: 'changesRequested', nextVersion: 2 });
  });

  it("member approved: marketing confirms the send time, quoting the member's proposal when there is one", () => {
    const proposed = new Date('2026-10-02T02:00:00Z');
    expect(turnBar({ ...base, status: 'member_approved', round: 1, proposedSendAt: proposed })).toEqual({
      kind: 'confirmSchedule',
      proposedAt: proposed,
    });
    expect(turnBar({ ...base, status: 'member_approved', round: 1 })).toEqual({ kind: 'confirmSchedule', proposedAt: null });
  });

  it('nobody acts next once approved, sending or closed: no bar', () => {
    for (const status of ['approved', 'sending', 'sent', 'rejected', 'cancelled', 'failed_to_dispatch'] as const) {
      expect(turnBar({ ...base, status, round: 1 }), status).toBeNull();
    }
  });
});
