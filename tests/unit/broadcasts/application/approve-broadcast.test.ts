/**
 * T096 โ€” Unit tests for `approve-broadcast.ts` Application use-case.
 *
 * Wave 6 GREEN โ€” covers two paths (send_now + schedule), schedule lead
 * defence (โฅ5min), state-check (5 invalid statuses), concurrency, and
 * server_error catch-all. Resend Broadcasts API is NOT touched here โ€”
 * dispatch is deferred to the cron worker (Ultraplan AD1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { approveBroadcast } from '@/modules/broadcasts/application/use-cases/approve-broadcast';
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
  subject: string;
  templateKey: string;
  payload: Record<string, unknown>;
  locale: string;
  txWasSupplied: boolean;
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
      async sendMemberEmail(_ctx, input: SendEmailInput, tx) {
        if (opts.shouldThrow) {
          throw new Error('outbox INSERT failed');
        }
        memberCalls.push({
          to: input.to,
          subject: input.subject,
          templateKey: input.templateKey,
          payload: input.payload,
          locale: input.locale,
          txWasSupplied: tx !== null && tx !== undefined,
        });
      },
    },
  };
}

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/approve-broadcast.ts',
);
const tenant: TenantContext = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');
const broadcastId = asBroadcastId('33333333-3333-3333-3333-333333333333');

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

interface RepoOpts {
  readonly lockedStatus?: BroadcastStatus | null;
  readonly applyTransitionThrows?: boolean;
  readonly refreshAfterRace?: Broadcast | null;
  readonly withTxThrows?: Error | string;
}

function makeBroadcast(
  status: BroadcastStatus,
  fields: Partial<Broadcast> = {},
): Broadcast {
  return {
    tenantId: 'test-tenant',
    broadcastId,
    requestedByMemberId: 'm-1',
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
    manualRetryCount: 0,
    partialDeliveryAcceptedAt: null,
    partialDeliveryAcceptedByUserId: null,
    startedFromTemplateId: null,
    templateNameSnapshot: null,
    createdAt: FROZEN_NOW,
    updatedAt: FROZEN_NOW,
    ...fields,
  };
}

function makeRepo(opts: RepoOpts): {
  port: BroadcastsRepo;
  transitions: Array<{ status: string; fields: unknown }>;
} {
  const transitions: Array<{ status: string; fields: unknown }> = [];
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
        return opts.refreshAfterRace ?? null;
      },
      async lockForUpdate() {
        return opts.lockedStatus ?? null;
      },
      async applyTransition(_tx, _t, _b, status, fields) {
        transitions.push({ status, fields });
        if (opts.applyTransitionThrows) {
          throw new BroadcastConcurrentMutationError(
            'test-tenant',
            broadcastId,
            'cancelled',
          );
        }
        return makeBroadcast(status as BroadcastStatus, fields as Partial<Broadcast>);
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

const baseInput = {
  broadcastId,
  actorUserId: 'admin-7',
  decision: { mode: 'send_now' as const },
  requestId: 'req-1',
};

const clock = { now: (): Date => FROZEN_NOW };

beforeEach(() => vi.useFakeTimers({ now: FROZEN_NOW }));
afterEach(() => vi.useRealTimers());

describe('approve-broadcast โ€” Wave 6 GREEN (T100)', () => {
  // ===== D1 closure (verify-fix 2026-05-02) โ€” G2 notification tests =====

  it('D1 G2: emailTransactional.sendMemberEmail enqueued IN-TX with correct payload + locale', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    const result = await approveBroadcast(
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
    expect(call.to).toBe('me@example.com'); // replyToEmail snapshot
    expect(call.templateKey).toBe('broadcast_approved');
    expect(call.locale).toBe('th');
    expect(call.payload['broadcastId']).toBe(broadcastId);
    expect(call.payload['broadcastSubject']).toBe('Welcome');
    expect(call.payload['scheduledForIso']).toBe(FROZEN_NOW.toISOString());
  });

  it('D1 G2: notificationLocale defaults to "en" when input field omitted', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    await approveBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
      },
      baseInput, // no notificationLocale
    );
    expect(email.memberCalls[0]?.locale).toBe('en');
  });

  it('D1 G2: emailTransactional throws โ’ audit + transition still complete (best-effort guard)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail({ shouldThrow: true });
    const result = await approveBroadcast(
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
    expect(audit.emits.find((e) => e.eventType === 'broadcast_approved')).toBeDefined();
    expect(repo.transitions[0]?.status).toBe('approved');
  });

  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // ===== R5 verify-fix Tests-H5 (2026-05-02) โ€” locale chain =====
  // Spec: `memberPreferred ?? input.notificationLocale ?? 'en'`.
  // Locks the per-recipient locale resolution that motivated the
  // entire Types-#6 OPTION B chain (F3 schema โ’ bridge โ’ use-case).

  it('locale chain: memberPreferred WINS over input.notificationLocale', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi.fn().mockResolvedValue('sv'),
    } as unknown as NonNullable<Parameters<typeof approveBroadcast>[0]['membersBridge']>;
    await approveBroadcast(
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
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi.fn().mockResolvedValue(null),
    } as unknown as NonNullable<Parameters<typeof approveBroadcast>[0]['membersBridge']>;
    await approveBroadcast(
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
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi.fn().mockResolvedValue(null),
    } as unknown as NonNullable<Parameters<typeof approveBroadcast>[0]['membersBridge']>;
    await approveBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
        membersBridge,
      },
      baseInput, // no notificationLocale
    );
    expect(email.memberCalls[0]?.locale).toBe('en');
  });

  it('locale chain: bridge throw is logged + falls through to input.notificationLocale (R5 Errors-H3)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi
        .fn()
        .mockRejectedValue(new Error('bridge boom')),
    } as unknown as NonNullable<Parameters<typeof approveBroadcast>[0]['membersBridge']>;
    const result = await approveBroadcast(
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
    expect(email.memberCalls[0]?.locale).toBe('sv'); // input fallback
  });

  // ---- send_now path ---------------------------------------------------

  it('happy send_now: applyTransition(approved, scheduledFor=now) + audit broadcast_approved', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(repo.transitions).toHaveLength(1);
    expect(repo.transitions[0]?.status).toBe('approved');
    const fields = repo.transitions[0]?.fields as {
      approvedAt: Date;
      approvedByUserId: string;
      scheduledFor: Date;
    };
    expect(fields.approvedAt).toEqual(FROZEN_NOW);
    expect(fields.approvedByUserId).toBe('admin-7');
    expect(fields.scheduledFor).toEqual(FROZEN_NOW);
    if (result.ok) {
      expect(result.value.status).toBe('approved');
      expect(result.value.scheduledFor).toEqual(FROZEN_NOW);
    }
  });

  it('audit broadcast_approved payload (send_now) contains decision="send_now" + scheduledFor=now ISO', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_approved');
    expect(evt).toBeDefined();
    expect(evt?.payload).toMatchObject({
      broadcastId,
      approvedByUserId: 'admin-7',
      decision: 'send_now',
      scheduledFor: FROZEN_NOW.toISOString(),
      approvedAt: FROZEN_NOW.toISOString(),
    });
    expect(evt?.summary).toContain('send_now');
  });

  // ---- schedule path ---------------------------------------------------

  it('happy schedule: scheduledFor = future timestamp; transition uses provided value', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const future = new Date(FROZEN_NOW.getTime() + 60 * 60 * 1000); // +1h
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, decision: { mode: 'schedule', scheduledFor: future } },
    );
    expect(result.ok).toBe(true);
    const fields = repo.transitions[0]?.fields as { scheduledFor: Date };
    expect(fields.scheduledFor).toEqual(future);
    if (result.ok) expect(result.value.scheduledFor).toEqual(future);
  });

  it('audit broadcast_approved payload (schedule) contains decision="schedule" + future scheduledFor', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const future = new Date(FROZEN_NOW.getTime() + 30 * 60 * 1000); // +30min
    await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, decision: { mode: 'schedule', scheduledFor: future } },
    );
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_approved');
    expect((evt?.payload as { decision: string }).decision).toBe('schedule');
    expect((evt?.payload as { scheduledFor: string }).scheduledFor).toBe(
      future.toISOString(),
    );
  });

  // ---- Schedule defence (Ultraplan AD8) -------------------------------

  it('rejects schedule < now+5min โ’ broadcast_schedule_too_soon', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const tooSoon = new Date(FROZEN_NOW.getTime() + 4 * 60 * 1000); // +4min
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, decision: { mode: 'schedule', scheduledFor: tooSoon } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_schedule_too_soon');
      if (result.error.kind === 'broadcast_schedule_too_soon') {
        expect(result.error.scheduledFor).toEqual(tooSoon);
      }
    }
    expect(repo.transitions).toHaveLength(0);
  });

  it('rejects schedule in the past โ’ broadcast_schedule_too_soon', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const past = new Date(FROZEN_NOW.getTime() - 60 * 1000);
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, decision: { mode: 'schedule', scheduledFor: past } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_schedule_too_soon');
  });

  it('accepts schedule at exactly now+5min boundary', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const boundary = new Date(FROZEN_NOW.getTime() + 5 * 60 * 1000);
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, decision: { mode: 'schedule', scheduledFor: boundary } },
    );
    expect(result.ok).toBe(true);
  });

  // ---- State-check -----------------------------------------------------

  it.each<BroadcastStatus>([
    'draft',
    'approved',
    'sending',
    'sent',
    'cancelled',
    'rejected',
    'failed_to_dispatch',
  ])('rejects when status=%s โ’ broadcast_invalid_state_transition', async (s) => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: s });
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_invalid_state_transition');
      if (result.error.kind === 'broadcast_invalid_state_transition') {
        expect(result.error.observedStatus).toBe(s);
      }
    }
    expect(repo.transitions).toHaveLength(0);
  });

  it('rejects when broadcast not found โ’ broadcast_not_found', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: null });
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_not_found');
  });

  // ---- Concurrency ----------------------------------------------------

  it('applyTransition throws โ’ broadcast_concurrent_action_blocked', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'submitted',
      applyTransitionThrows: true,
      refreshAfterRace: makeBroadcast('cancelled'),
    });
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_concurrent_action_blocked');
      if (result.error.kind === 'broadcast_concurrent_action_blocked') {
        expect(result.error.observedStatus).toBe('cancelled');
      }
    }
  });

  it('concurrent: refresh returns null โ’ observedStatus="unknown"', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'submitted',
      applyTransitionThrows: true,
      refreshAfterRace: null,
    });
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    if (!result.ok && result.error.kind === 'broadcast_concurrent_action_blocked') {
      expect(result.error.observedStatus).toBe('unknown');
    }
  });

  // ---- Server error catch-all ----------------------------------------

  it('repo throw inside withTx โ’ approve.server_error', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ withTxThrows: new Error('db down') });
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('approve.server_error');
      if (result.error.kind === 'approve.server_error') {
        expect(result.error.message).toBe('db down');
      }
    }
  });

  it('non-Error thrown โ’ approve.server_error with "unknown error" message', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ withTxThrows: 'string-error' });
    const result = await approveBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    if (!result.ok && result.error.kind === 'approve.server_error') {
      expect(result.error.message).toBe('unknown error');
    }
  });

  // ---- Atomic guarantees --------------------------------------------

  it('audit emit happens INSIDE the same withTx as applyTransition', async () => {
    const audit = makeAudit();
    let txOpened = false;
    let txClosed = false;
    let auditWasInsideTx = false;
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const wrappedRepo: BroadcastsRepo = {
      ...repo.port,
      async withTx(fn) {
        txOpened = true;
        const r = await fn(null);
        txClosed = true;
        return r;
      },
    };
    const wrappedAudit: AuditPort = {
      async emit(_tx, e) {
        auditWasInsideTx = txOpened && !txClosed;
        audit.emits.push(e);
      },
    };
    await approveBroadcast(
      { tenant, broadcastsRepo: wrappedRepo, audit: wrappedAudit, clock },
      baseInput,
    );
    expect(auditWasInsideTx).toBe(true);
  });
});
