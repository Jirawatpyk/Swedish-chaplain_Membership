/**
 * T041 — Unit tests for the 3 F7 Domain invariants.
 *
 * Each invariant is a pure `Result<true, InvariantError>` returning function
 * called by Application use-cases at boundary points (defence-in-depth
 * with DB triggers / RLS).
 *
 * Imports the invariants via deep paths because the broadcasts barrel
 * intentionally does NOT export invariant functions (they are internal
 * verification helpers per Constitution Principle III; only Domain types
 * + policies are exported via the public barrel).
 */
import { describe, expect, it } from 'vitest';
import { enforceQuotaCounterNonNegative } from '@/modules/broadcasts/domain/invariants/quota-counter-non-negative';
import { enforceOneActiveBroadcastState } from '@/modules/broadcasts/domain/invariants/one-active-broadcast-state';
import { enforceSuppressionTenantScoped } from '@/modules/broadcasts/domain/invariants/suppression-tenant-scoped';
import {
  asBroadcastId,
  type Broadcast,
} from '@/modules/broadcasts';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';

const baseBroadcast: Broadcast = {
  tenantId: 'test',
  broadcastId: asBroadcastId('11111111-1111-4111-8111-111111111111'),
  requestedByMemberId: 'mem',
  requestedByMemberPlanIdSnapshot: 'plan',
  submittedByUserId: 'user',
  actorRole: 'member_self_service',
  subject: 'Subject',
  bodyHtml: '<p>body</p>',
  bodySource: 'body',
  fromName: 'Member via Tenant',
  replyToEmail: 'a@example.com',
  segmentType: 'all_members',
  segmentParams: null,
  customRecipientEmails: null,
  estimatedRecipientCount: 0,
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
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// ===========================================================================
// quota-counter-non-negative (FR-008)
// ===========================================================================

describe('enforceQuotaCounterNonNegative', () => {
  it('ok on valid counter (used + reserved < cap)', () => {
    const result = enforceQuotaCounterNonNegative({
      used: 1,
      reserved: 1,
      remaining: 4,
      cap: 6,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects negative cap', () => {
    const result = enforceQuotaCounterNonNegative({
      used: 0,
      reserved: 0,
      remaining: 0,
      cap: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'quota.negative_field') {
      expect(result.error.field).toBe('cap');
    }
  });

  it('rejects negative used', () => {
    const result = enforceQuotaCounterNonNegative({
      used: -1,
      reserved: 0,
      remaining: 6,
      cap: 6,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'quota.negative_field') {
      expect(result.error.field).toBe('used');
    }
  });

  it('rejects over-subscription', () => {
    const result = enforceQuotaCounterNonNegative({
      used: 4,
      reserved: 4,
      remaining: -2,
      cap: 6,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('quota.over_subscription');
    }
  });

  it('rejects negative remaining (drift detection)', () => {
    const result = enforceQuotaCounterNonNegative({
      used: 0,
      reserved: 0,
      remaining: -1,
      cap: 6,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('quota.remaining_negative');
    }
  });
});

// ===========================================================================
// one-active-broadcast-state (FR-004 timestamp/status agreement)
// ===========================================================================

describe('enforceOneActiveBroadcastState', () => {
  it('ok on valid draft (no lifecycle timestamps set)', () => {
    const result = enforceOneActiveBroadcastState(baseBroadcast);
    expect(result.ok).toBe(true);
  });

  it('rejects draft with submitted_at set (forbidden)', () => {
    const result = enforceOneActiveBroadcastState({
      ...baseBroadcast,
      submittedAt: new Date(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast.state_timestamp_mismatch');
      expect(result.error.violations.length).toBeGreaterThan(0);
    }
  });

  it('rejects sent without quota_year_consumed (FR-007 violation)', () => {
    const result = enforceOneActiveBroadcastState({
      ...baseBroadcast,
      status: 'sent',
      submittedAt: new Date(),
      approvedAt: new Date(),
      sendingStartedAt: new Date(),
      sentAt: new Date(),
      // quotaYearConsumed left null (forbidden in 'sent' state per FR-007)
    });
    expect(result.ok).toBe(false);
  });

  it('ok on properly populated sent state', () => {
    const now = new Date();
    const result = enforceOneActiveBroadcastState({
      ...baseBroadcast,
      status: 'sent',
      submittedAt: now,
      approvedAt: now,
      sendingStartedAt: now,
      sentAt: now,
      quotaYearConsumed: 2026,
      quotaConsumedAt: now,
    });
    expect(result.ok).toBe(true);
  });

  it('ok on rejected state with rejection metadata', () => {
    const now = new Date();
    const result = enforceOneActiveBroadcastState({
      ...baseBroadcast,
      status: 'rejected',
      submittedAt: now,
      rejectedAt: now,
      rejectedByUserId: 'admin-user',
      rejectionReason: 'Off-topic',
    });
    expect(result.ok).toBe(true);
  });

  it('ok on cancelled state with cancellation metadata', () => {
    const now = new Date();
    const result = enforceOneActiveBroadcastState({
      ...baseBroadcast,
      status: 'cancelled',
      submittedAt: now,
      cancelledAt: now,
      cancelledByUserId: 'member-user',
    });
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// suppression-tenant-scoped (FR-018 + Q8)
// ===========================================================================

describe('enforceSuppressionTenantScoped', () => {
  const suppression = {
    tenantId: 'tenant-a',
    emailLower: unsafeBrandEmailLower('user@example.com'),
    memberId: null,
    reason: 'recipient_initiated' as const,
    reasonText: null,
    sourceBroadcastId: null,
    sourceTokenHash: null,
    unsubscribedAt: new Date(),
  };

  it('ok when tenantId matches expected', () => {
    const result = enforceSuppressionTenantScoped(suppression, 'tenant-a');
    expect(result.ok).toBe(true);
  });

  it('rejects cross-tenant mismatch', () => {
    const result = enforceSuppressionTenantScoped(suppression, 'tenant-b');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('suppression.tenant_mismatch');
      expect(result.error.recordTenantId).toBe('tenant-a');
      expect(result.error.expectedTenantId).toBe('tenant-b');
    }
  });
});
