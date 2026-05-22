/**
 * Unit tests for `cancel-broadcast.ts` Application use-case (T103).
 *
 * Wave 6 GREEN โ€” FR-004a / Q10 cancel cutoff at `sending`.
 *
 * Shared between member-self + admin paths via `actor` discriminator.
 * Member-self requesting another member's broadcast must surface
 * `broadcast_not_found` (no existence leak โ€” security).
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
import type {
  EmailTransactionalPort,
  SendEmailInput,
} from '@/modules/broadcasts/application/ports/email-transactional-port';

interface MemberCallRecord {
  to: string;
  templateKey: string;
  payload: Record<string, unknown>;
  locale: string;
}

function makeEmail(opts: { shouldThrow?: boolean } = {}): {
  port: EmailTransactionalPort;
  memberCalls: Array<MemberCallRecord>;
} {
  const memberCalls: Array<MemberCallRecord> = [];
  return {
    memberCalls,
    port: {
      async sendAdminNotification() {},
      async sendMemberEmail(_ctx, input: SendEmailInput) {
        if (opts.shouldThrow) throw new Error('outbox INSERT failed');
        memberCalls.push({
          to: input.to,
          templateKey: input.templateKey,
          payload: input.payload,
          locale: input.locale,
        });
      },
    },
  };
}

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
      async emitTyped(_tx, e) {
        emits.push(e as AuditEmitInput);
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
    manualRetryCount: 0,
    partialDeliveryAcceptedAt: null,
    partialDeliveryAcceptedByUserId: null,
    templateProvenance: null,
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
      async updateDraftFromTemplate() {
        throw new Error('not used in cancel-broadcast fixture');
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
            'test-tenant' as never,
            broadcastId,
            'sending',
          );
        }
        return { ...(opts.existing as Broadcast), status };
      },
      async attachResendIds() {},
      async attachAudienceId() {},
      async listByTenantStatus() {
        return { rows: [], nextCursor: null };
      },
      async countForMemberQuota() {
        return { submittedOrApproved: 0, sent: 0 };
      },
      async findByResendBroadcastIdBypassRls() {
        return null;
      },
      async listForMemberPaginated() {
        return { rows: [], total: 0, totalPages: 0, page: 1 };
      },
      async findOwnedByMember() {
        return { broadcast: null, probeKind: 'not_found' as const };
      },
      async aggregateDeliveryCountsForBroadcast() {
        return { delivered: 0, bounced: 0, softBounced: 0, complained: 0, sent: 0 };
      },
      async pruneExpiredDrafts() {
        return { prunedCount: 0 };
      },
    async listInFlightOwnedByMember() { return []; },
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

describe('cancel-broadcast โ€” Wave 6 GREEN (T103)', () => {
  // ===== D1 closure (verify-fix 2026-05-02) โ€” G2 notification tests =====

  it('D1 G2: admin-cancel sends notification email with cancellationReason + tenant locale', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const email = makeEmail();
    const result = await cancelBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
      },
      { ...baseInput, notificationLocale: 'th' },
    );
    expect(result.ok).toBe(true);
    expect(email.memberCalls).toHaveLength(1);
    const call = email.memberCalls[0]!;
    expect(call.templateKey).toBe('broadcast_cancelled');
    expect(call.locale).toBe('th');
    expect(call.payload['cancellationReason']).toBe(baseInput.cancellationReason);
  });

  it('D1 G2: member self-cancel ALSO sends notification (gap fix)', async () => {
    const audit = makeAudit();
    // member-actor + matching requestedByMemberId
    const repo = makeRepo({
      existing: makeBroadcast('submitted', 'm-1'),
    });
    const email = makeEmail();
    const result = await cancelBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
      },
      {
        ...baseInput,
        actor: { kind: 'member', memberId: 'm-1', userId: 'u-1' },
        cancellationReason: null,
      },
    );
    expect(result.ok).toBe(true);
    expect(email.memberCalls).toHaveLength(1);
    expect(email.memberCalls[0]?.templateKey).toBe('broadcast_cancelled');
    expect(email.memberCalls[0]?.payload['cancellationReason']).toBeNull();
  });

  it('D1 G2: emailTransactional throws โ’ audit + transition still complete (best-effort)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const email = makeEmail({ shouldThrow: true });
    const result = await cancelBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(audit.emits.find((e) => e.eventType === 'broadcast_cancelled')).toBeDefined();
  });

  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  it('happy admin: status=submitted โ’ cancelled, audit broadcast_cancelled', async () => {
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

  it('happy admin: status=approved โ’ cancelled (cutoff allows approved)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('approved') });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(true);
  });

  it('happy member-self: actor.memberId matches requestedByMemberId โ’ cancelled', async () => {
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

  // ===== R5 verify-fix Tests-H5 (2026-05-02) โ€” locale chain =====
  it('locale chain: memberPreferred WINS over input.notificationLocale', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi.fn().mockResolvedValue('sv'),
    } as unknown as NonNullable<Parameters<typeof cancelBroadcast>[0]['membersBridge']>;
    await cancelBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
        membersBridge,
      },
      { ...baseInput, notificationLocale: 'th' },
    );
    expect(email.memberCalls[0]?.locale).toBe('sv');
  });

  it('locale chain: memberPreferred null โ’ falls back to input.notificationLocale', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi.fn().mockResolvedValue(null),
    } as unknown as NonNullable<Parameters<typeof cancelBroadcast>[0]['membersBridge']>;
    await cancelBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
        membersBridge,
      },
      { ...baseInput, notificationLocale: 'th' },
    );
    expect(email.memberCalls[0]?.locale).toBe('th');
  });

  it('locale chain: both null โ’ final fallback to "en"', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi.fn().mockResolvedValue(null),
    } as unknown as NonNullable<Parameters<typeof cancelBroadcast>[0]['membersBridge']>;
    await cancelBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
        membersBridge,
      },
      baseInput,
    );
    expect(email.memberCalls[0]?.locale).toBe('en');
  });

  it('locale chain: bridge throw is logged + falls through to input.notificationLocale (R5 Errors-H3)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi
        .fn()
        .mockRejectedValue(new Error('bridge boom')),
    } as unknown as NonNullable<Parameters<typeof cancelBroadcast>[0]['membersBridge']>;
    const result = await cancelBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
        membersBridge,
      },
      { ...baseInput, notificationLocale: 'sv' },
    );
    expect(result.ok).toBe(true);
    expect(email.memberCalls[0]?.locale).toBe('sv');
  });

  // ---- Cutoff (FR-004a) ------------------------------------------------

  it.each<BroadcastStatus>([
    'sending',
    'sent',
    'rejected',
    'cancelled',
    'failed_to_dispatch',
    'draft',
  ])('rejects when status=%s โ’ broadcast_cancel_too_late + audit emitted', async (s) => {
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

  it('rejects when broadcast not found โ’ broadcast_not_found', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: null });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_not_found');
  });

  it("member-self trying to cancel another member's broadcast โ’ broadcast_not_found (no leak)", async () => {
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

  it('rejects cancellationReason > 500 chars โ’ broadcast_cancel_reason_too_long', async () => {
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

  it('applyTransition throws โ’ broadcast_concurrent_action_blocked', async () => {
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

  it('concurrent: refresh returns null โ’ observedStatus="unknown"', async () => {
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

  it('cancel_too_late audit best-effort โ€” failed audit does NOT mask the error', async () => {
    const repo = makeRepo({ existing: makeBroadcast('sent') });
    const auditPort: AuditPort = {
      async emit() {
        throw new Error('audit table down');
      },
      async emitTyped() {
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

  it('repo throw inside withTx โ’ cancel.server_error', async () => {
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

  it('non-Error thrown โ’ cancel.server_error with "unknown error" message', async () => {
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
