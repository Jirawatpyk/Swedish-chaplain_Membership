/**
 * Round 5 review type-design — `phaseOf(broadcast)` discriminated-union view.
 *
 * The flat `Broadcast` interface stays for back-compat. `phaseOf` is the
 * opt-in narrowed view callers reach for when they need compile-time
 * non-null guarantees on lifecycle timestamps. These tests pin the
 * status → phase mapping and the invariant-violation throw paths so a
 * future schema drift doesn't silently weaken the narrowing contract.
 */
import { describe, expect, it } from 'vitest';
import { asBroadcastId, phaseOf, type Broadcast } from '@/modules/broadcasts';

const baseBroadcast: Broadcast = {
  tenantId: 'test',
  broadcastId: asBroadcastId('11111111-1111-4111-8111-111111111111'),
  requestedByMemberId: 'mem-1',
  requestedByMemberPlanIdSnapshot: 'plan-1',
  submittedByUserId: 'user-1',
  actorRole: 'member_self_service',
  subject: 's',
  bodyHtml: '<p>x</p>',
  bodySource: 'editor',
  fromName: 'F',
  replyToEmail: 'r@e',
  segmentType: 'all_members',
  segmentParams: null,
  customRecipientEmails: null,
  estimatedRecipientCount: 10,
  status: 'draft',
  submittedAt: null,
  approvedAt: null,
  approvedByUserId: null,
  rejectedAt: null,
  rejectedByUserId: null,
  rejectionReason: null,
  scheduledFor: null,
  sendingStartedAt: null,
  sentAt: null,
  cancelledAt: null,
  cancelledByUserId: null,
  cancellationReason: null,
  failedToDispatchAt: null,
  failureReason: null,
  quotaYearConsumed: null,
  quotaConsumedAt: null,
  resendAudienceId: null,
  resendBroadcastId: null,
  retentionYears: 5,
  // F7.1a US1 + US7 fields (Phase 2 + 3 B0 extension defaults).
  manualRetryCount: 0,
  partialDeliveryAcceptedAt: null,
  partialDeliveryAcceptedByUserId: null,
  startedFromTemplateId: null,
  templateNameSnapshot: null,
  templateProvenance: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('phaseOf', () => {
  it('draft status → kind=draft', () => {
    const phase = phaseOf(baseBroadcast);
    expect(phase.kind).toBe('draft');
    if (phase.kind === 'draft') {
      expect(phase.createdAt).toBeInstanceOf(Date);
    }
  });

  it('submitted status with non-null timestamps → kind=submitted', () => {
    const submittedAt = new Date('2026-02-01T00:00:00Z');
    const phase = phaseOf({ ...baseBroadcast, status: 'submitted', submittedAt });
    expect(phase.kind).toBe('submitted');
    if (phase.kind === 'submitted') {
      expect(phase.submittedAt).toBe(submittedAt);
    }
  });

  it('submitted status with null submittedAt → throws invariant violation', () => {
    expect(() =>
      phaseOf({ ...baseBroadcast, status: 'submitted', submittedAt: null }),
    ).toThrow(/BroadcastPhaseInvariantViolation/);
  });

  it('sent status with all required timestamps → kind=sent', () => {
    const phase = phaseOf({
      ...baseBroadcast,
      status: 'sent',
      submittedAt: new Date('2026-02-01T00:00:00Z'),
      approvedAt: new Date('2026-02-02T00:00:00Z'),
      sendingStartedAt: new Date('2026-02-03T00:00:00Z'),
      sentAt: new Date('2026-02-03T00:01:00Z'),
      quotaYearConsumed: 2026,
      quotaConsumedAt: new Date('2026-02-03T00:01:00Z'),
    });
    expect(phase.kind).toBe('sent');
    if (phase.kind === 'sent') {
      expect(phase.quotaYearConsumed).toBe(2026);
    }
  });

  it('sent status missing quotaYearConsumed → throws invariant violation', () => {
    expect(() =>
      phaseOf({
        ...baseBroadcast,
        status: 'sent',
        sentAt: new Date(),
        quotaYearConsumed: null,
        quotaConsumedAt: new Date(),
      }),
    ).toThrow(/BroadcastPhaseInvariantViolation/);
  });

  it('cancelled status surfaces cancellationReason in phase', () => {
    const phase = phaseOf({
      ...baseBroadcast,
      status: 'cancelled',
      cancelledAt: new Date(),
      cancellationReason: 'gdpr_erasure_request',
    });
    expect(phase.kind).toBe('cancelled');
    if (phase.kind === 'cancelled') {
      expect(phase.cancellationReason).toBe('gdpr_erasure_request');
    }
  });

  it('failed_to_dispatch surfaces failureReason in phase', () => {
    const phase = phaseOf({
      ...baseBroadcast,
      status: 'failed_to_dispatch',
      failedToDispatchAt: new Date(),
      failureReason: 'audience_post_suppression_empty',
    });
    expect(phase.kind).toBe('failed_to_dispatch');
    if (phase.kind === 'failed_to_dispatch') {
      expect(phase.failureReason).toBe('audience_post_suppression_empty');
    }
  });

  // R6 staff-review W-T5 fix — `approved` and `sending` phase coverage.
  // Both phases have non-null timestamp invariants that the prior
  // suite did not pin, leaving `phaseOf` regressions in those branches
  // undetected.
  it('approved status with all required timestamps → kind=approved', () => {
    const submittedAt = new Date('2026-02-01T00:00:00Z');
    const approvedAt = new Date('2026-02-02T00:00:00Z');
    const phase = phaseOf({
      ...baseBroadcast,
      status: 'approved',
      submittedAt,
      approvedAt,
      approvedByUserId: 'admin-1',
    });
    expect(phase.kind).toBe('approved');
    if (phase.kind === 'approved') {
      expect(phase.submittedAt).toBe(submittedAt);
      expect(phase.approvedAt).toBe(approvedAt);
      expect(phase.approvedByUserId).toBe('admin-1');
    }
  });

  it('approved status with null approvedAt → throws invariant violation', () => {
    expect(() =>
      phaseOf({
        ...baseBroadcast,
        status: 'approved',
        submittedAt: new Date(),
        approvedAt: null,
        approvedByUserId: 'admin-1',
      }),
    ).toThrow(/BroadcastPhaseInvariantViolation/);
  });

  it('approved status with null approvedByUserId → throws invariant violation', () => {
    expect(() =>
      phaseOf({
        ...baseBroadcast,
        status: 'approved',
        submittedAt: new Date(),
        approvedAt: new Date(),
        approvedByUserId: null,
      }),
    ).toThrow(/BroadcastPhaseInvariantViolation/);
  });

  it('sending status with sendingStartedAt + approvedAt → kind=sending', () => {
    const sendingStartedAt = new Date('2026-02-03T00:00:00Z');
    const approvedAt = new Date('2026-02-02T00:00:00Z');
    const phase = phaseOf({
      ...baseBroadcast,
      status: 'sending',
      submittedAt: new Date('2026-02-01T00:00:00Z'),
      approvedAt,
      approvedByUserId: 'admin-1',
      sendingStartedAt,
    });
    expect(phase.kind).toBe('sending');
    if (phase.kind === 'sending') {
      expect(phase.sendingStartedAt).toBe(sendingStartedAt);
      expect(phase.approvedAt).toBe(approvedAt);
    }
  });

  it('sending status with null sendingStartedAt → throws invariant violation', () => {
    expect(() =>
      phaseOf({
        ...baseBroadcast,
        status: 'sending',
        submittedAt: new Date(),
        approvedAt: new Date(),
        approvedByUserId: 'admin-1',
        sendingStartedAt: null,
      }),
    ).toThrow(/BroadcastPhaseInvariantViolation/);
  });

  it('sending status with null approvedAt → throws invariant violation', () => {
    expect(() =>
      phaseOf({
        ...baseBroadcast,
        status: 'sending',
        submittedAt: new Date(),
        approvedAt: null,
        approvedByUserId: 'admin-1',
        sendingStartedAt: new Date(),
      }),
    ).toThrow(/BroadcastPhaseInvariantViolation/);
  });
});
