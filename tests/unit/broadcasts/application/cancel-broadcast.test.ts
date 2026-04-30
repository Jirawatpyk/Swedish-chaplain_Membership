/**
 * Unit tests for `cancel-broadcast.ts` Application use-case (T103).
 *
 * Wave 6 GREEN — FR-004a / Q10 cancel cutoff at `sending`.
 *
 * Shared between member-self + admin paths via `actor` discriminator.
 * Member-self requesting another member's broadcast must surface
 * `broadcast_not_found` (no existence leak — security).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cancelBroadcast } from '@/modules/broadcasts/application/use-cases/cancel-broadcast';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import {
  BroadcastConcurrentMutationError,
  type BroadcastsRepo,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import type { BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/cancel-broadcast.ts',
);
const tenant: TenantContext = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');
const broadcastId = asBroadcastId('22222222-2222-2222-2222-222222222222');

function makeAudit(): { emits: Array<AuditEmitInput>; port: AuditPort } {
  const emits: Array<AuditEmitInput> = [];
  return {
    emits,
    port: {
      async emit(_tx, e) {
        emits.push(e);
      },
    },
  };
}

function makeBroadcast(
  status: BroadcastStatus,
  requestedByMemberId = 'm-1',
): Broadcast {
  return {
    tenantId: 'test-tenant',
    broadcastId,
    requestedByMemberId,
    requestedByMemberPlanIdSnapshot: 'p',
    submittedByUserId: 'u-1',
    actorRole: 'member_self_service',
    subject: 'Welcome',
    bodyHtml: '<p>x</p>',
    bodySource: 'plain',
    fromName: 'Chamber',
    replyToEmail: 'me@example.com',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 10,
    status,
    submittedAt: FROZEN_NOW,
    approvedAt: status === 'approved' ? FROZEN_NOW : null,
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
    createdAt: FROZEN_NOW,
    updatedAt: FROZEN_NOW,
  };
}

interface RepoOpts {
  readonly existing?: Broadcast | null;
  readonly applyTransitionThrows?: boolean;
  readonly refreshAfterRace?: Broadcast | null;
  readonly withTxThrows?: Error | string;
}

function makeRepo(opts: RepoOpts): {
  port: BroadcastsRepo;
  transitions: Array<{ status: string; fields: unknown }>;
} {
  const transitions: Array<{ status: string; fields: unknown }> = [];
  let findCallCount = 0;
  return {
    transitions,
    port: {
      async withTx(fn) {
        if (opts.withTxThrows) throw opts.withTxThrows;
        return fn(null);
      },
      async insertDraft() {
        throw new Error('not used');
      },
      async updateDraft() {
        throw new Error('not used');
      },
      async findById() {
        return null;
      },
      async findByIdInTx() {
        findCallCount += 1;
        if (findCallCount === 1) return opts.existing ?? null;
        return opts.refreshAfterRace ?? null;
      },
      async lockForUpdate() {
        return null;
      },
      async applyTransition(_tx, _t, _b, status, fields) {
        transitions.push({ status, fields });
        if (opts.applyTransitionThrows) {
          throw new BroadcastConcurrentMutationError(
            'test-tenant',
            broadcastId,
            'sending',
          );
        }
        return { ...(opts.existing as Broadcast), status };
      },
      async attachResendIds() {},
      async listByTenantStatus() {
        return { rows: [], nextCursor: null };
      },
      async countForMemberQuota() {
        return { submittedOrApproved: 0, sent: 0 };
      },
      async findByResendBroadcastIdBypassRls() {
        return null;
      },
    },
  };
}

const adminActor = { kind: 'admin', userId: 'admin-7' } as const;
const memberActor = {
  kind: 'member',
  memberId: 'm-1',
  userId: 'user-of-m-1',
} as const;

const baseInput = {
  broadcastId,
  actor: adminActor,
  cancellationReason: 'Wrong send list',
  requestId: 'req-1',
} as const;

const clock = { now: (): Date => FROZEN_NOW };

beforeEach(() => vi.useFakeTimers({ now: FROZEN_NOW }));
afterEach(() => vi.useRealTimers());

describe('cancel-broadcast — Wave 6 GREEN (T103)', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  it('happy admin: status=submitted → cancelled, audit broadcast_cancelled', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(repo.transitions[0]?.status).toBe('cancelled');
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_cancelled');
    expect(evt).toBeDefined();
    expect((evt?.payload as { actorRole: string }).actorRole).toBe('admin');
    expect((evt?.payload as { actorKind: string }).actorKind).toBe('admin');
  });

  it('happy admin: status=approved → cancelled (cutoff allows approved)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('approved') });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(true);
  });

  it('happy member-self: actor.memberId matches requestedByMemberId → cancelled', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted', 'm-1') });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, actor: memberActor },
    );
    expect(result.ok).toBe(true);
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_cancelled');
    expect((evt?.payload as { actorKind: string }).actorKind).toBe('member');
    expect((evt?.payload as { actorRole: string }).actorRole).toBe(
      'member_self_service',
    );
  });

  // ---- Cutoff (FR-004a) ------------------------------------------------

  it.each<BroadcastStatus>([
    'sending',
    'sent',
    'rejected',
    'cancelled',
    'failed_to_dispatch',
    'draft',
  ])('rejects when status=%s → broadcast_cancel_too_late + audit emitted', async (s) => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast(s) });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_cancel_too_late');
      if (result.error.kind === 'broadcast_cancel_too_late') {
        expect(result.error.observedStatus).toBe(s);
      }
    }
    const evt = audit.emits.find(
      (e) => e.eventType === 'broadcast_cancel_too_late',
    );
    expect(evt).toBeDefined();
    expect((evt?.payload as { observedStatus: string }).observedStatus).toBe(s);
    expect(repo.transitions).toHaveLength(0);
  });

  // ---- Existence + member-self isolation -------------------------------

  it('rejects when broadcast not found → broadcast_not_found', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: null });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_not_found');
  });

  it("member-self trying to cancel another member's broadcast → broadcast_not_found (no leak)", async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted', 'm-OTHER') });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, actor: memberActor },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_not_found');
    expect(repo.transitions).toHaveLength(0);
  });

  // ---- Reason validation -----------------------------------------------

  it('null cancellationReason allowed', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, cancellationReason: null },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects cancellationReason > 500 chars → broadcast_cancel_reason_too_long', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const tooLong = 'r'.repeat(501);
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, cancellationReason: tooLong },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_cancel_reason_too_long');
      if (result.error.kind === 'broadcast_cancel_reason_too_long') {
        expect(result.error.length).toBe(501);
      }
    }
  });

  it('accepts cancellationReason at exactly 500 chars boundary', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const reason = 'r'.repeat(500);
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, cancellationReason: reason },
    );
    expect(result.ok).toBe(true);
  });

  // ---- Concurrency -----------------------------------------------------

  it('applyTransition throws → broadcast_concurrent_action_blocked', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      existing: makeBroadcast('submitted'),
      applyTransitionThrows: true,
      refreshAfterRace: makeBroadcast('sending'),
    });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_concurrent_action_blocked');
      if (result.error.kind === 'broadcast_concurrent_action_blocked') {
        expect(result.error.observedStatus).toBe('sending');
      }
    }
  });

  it('concurrent: refresh returns null → observedStatus="unknown"', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      existing: makeBroadcast('submitted'),
      applyTransitionThrows: true,
      refreshAfterRace: null,
    });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    if (!result.ok && result.error.kind === 'broadcast_concurrent_action_blocked') {
      expect(result.error.observedStatus).toBe('unknown');
    }
  });

  // ---- Audit payload shape --------------------------------------------

  it('audit broadcast_cancelled payload contains broadcastId + actorKind + actorRole + cancellationReason + cancelledAt', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_cancelled');
    expect(evt?.payload).toMatchObject({
      broadcastId,
      actorKind: 'admin',
      actorRole: 'admin',
      cancellationReason: 'Wrong send list',
      cancelledAt: FROZEN_NOW.toISOString(),
    });
    expect(evt?.actorUserId).toBe('admin-7');
  });

  it('cancel_too_late audit best-effort — failed audit does NOT mask the error', async () => {
    const repo = makeRepo({ existing: makeBroadcast('sent') });
    const auditPort: AuditPort = {
      async emit() {
        throw new Error('audit table down');
      },
    };
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: auditPort, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_cancel_too_late');
  });

  // ---- Server error catch-all -----------------------------------------

  it('repo throw inside withTx → cancel.server_error', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ withTxThrows: new Error('db down') });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('cancel.server_error');
      if (result.error.kind === 'cancel.server_error') {
        expect(result.error.message).toBe('db down');
      }
    }
  });

  it('non-Error thrown → cancel.server_error with "unknown error" message', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ withTxThrows: 'string-error' });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    if (!result.ok && result.error.kind === 'cancel.server_error') {
      expect(result.error.message).toBe('unknown error');
    }
  });
});
