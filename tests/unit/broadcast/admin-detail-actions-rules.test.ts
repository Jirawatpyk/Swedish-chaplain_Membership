/**
 * Spec 122 US12c-1 follow-up (maintainer, 20 Oct) — which controls the staff
 * E-Blast detail offers, in ONE place. The page and the preview harness both
 * read it, so the parity screenshots show what the page shows: the harness
 * had its own shorter copy of these rules and drew member approved and held
 * without Start formatted version and Change schedule.
 */
import { describe, expect, it } from 'vitest';
import { detailActions } from '@/app/(staff)/admin/broadcasts/[id]/_components/detail-actions';

const base = { canWrite: true, canSend: true, memberApprovalOn: true, bodyRenderFailed: false } as const;

describe('detailActions', () => {
  it('submitted: Approve, Reject, Cancel, and Start that asks first (approval round on)', () => {
    const a = detailActions({ ...base, status: 'submitted', round: 0 });
    expect(a).toMatchObject({ showApprove: true, showReject: true, isCancellable: true, showStart: true, startConfirm: 'leaves_submitted', showSchedule: false, showActionRow: true });
  });

  it('submitted with the approval round off: no Start', () => {
    expect(detailActions({ ...base, memberApprovalOn: false, status: 'submitted', round: 0 }).showStart).toBe(false);
  });

  it('submitted whose body could not be rendered: no Approve', () => {
    expect(detailActions({ ...base, bodyRenderFailed: true, status: 'submitted', round: 0 }).showApprove).toBe(false);
  });

  it('changes requested: Start runs on the click', () => {
    expect(detailActions({ ...base, status: 'changes_requested', round: 1 })).toMatchObject({ showStart: true, startConfirm: 'none', showSchedule: false });
  });

  it('member approved after a round: Confirm schedule, and Start that voids the approval', () => {
    expect(detailActions({ ...base, status: 'member_approved', round: 1 })).toMatchObject({ showStart: true, startConfirm: 'voids_approval', showSchedule: true, showReject: true });
  });

  it('approved after a round (held included): Change schedule and Start that voids the approval; no Reject', () => {
    expect(detailActions({ ...base, status: 'approved', round: 1 })).toMatchObject({ showStart: true, startConfirm: 'voids_approval', showSchedule: true, showReject: false, isCancellable: true });
  });

  it('approved as submitted (no round): neither Start nor a schedule change', () => {
    expect(detailActions({ ...base, status: 'approved', round: 0 })).toMatchObject({ showStart: false, showSchedule: false });
  });

  it('without broadcasts.send the schedule control is absent; without broadcasts.write no action row at all', () => {
    expect(detailActions({ ...base, canSend: false, status: 'member_approved', round: 1 }).showSchedule).toBe(false);
    expect(detailActions({ ...base, canWrite: false, canSend: false, status: 'submitted', round: 0 })).toMatchObject({ showActionRow: false, showStart: false, showApprove: false, showReject: false });
  });

  it('sent: nothing to act on', () => {
    expect(detailActions({ ...base, status: 'sent', round: 1 })).toMatchObject({ showActionRow: false, isCancellable: false });
  });
});
