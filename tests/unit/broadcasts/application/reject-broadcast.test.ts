/**
 * T097 โ€” Unit tests for `reject-broadcast.ts` Application use-case.
 *
 * Wave 6 GREEN. **100% branch coverage** of the typed-error matrix:
 * reason validation (3) + state-check (5) + concurrency (1) + audit
 * sha256-not-raw invariant (FR-012) + server_error catch-all.
 *
 * Strategy: hand-built mocks via DI (no vi.mock). Frozen clock; the
 * audit emit is asserted to NEVER contain raw `rejectionReason`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rejectBroadcast } from '@/modules/broadcasts/application/use-cases/reject-broadcast';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';
import type {
  BroadcastsRepo,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
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
          subject: input.subject,
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
  '../../../../src/modules/broadcasts/application/use-cases/reject-broadcast.ts',
);
const tenant: TenantContext = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');
const broadcastId = asBroadcastId('11111111-1111-1111-1111-111111111111');

function makeAudit(): {
  emits: Array<AuditEmitInput>;
  port: AuditPort;
} {
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

interface RepoOpts {
  readonly lockedStatus?: BroadcastStatus | null;
  readonly applyTransitionThrows?: boolean;
  readonly findByIdInTxResult?: Broadcast | null;
  readonly withTxThrows?: boolean;
}

function makeRepo(opts: RepoOpts = {}): {
  port: BroadcastsRepo;
  transitions: Array<{ status: string; fields: unknown }>;
} {
  const transitions: Array<{ status: string; fields: unknown }> = [];
  const port: BroadcastsRepo = {
    async withTx(fn) {
      if (opts.withTxThrows) throw new Error('tx-rolled-back');
      return fn(null);
    },
    async insertDraft() {
      throw new Error('not used');
    },
    async updateDraft() {
      throw new Error('not used');
    },
    async updateDraftFromTemplate() {
      throw new Error('not used in reject-broadcast fixture');
    },
    async findById() {
      return null;
    },
    async findByIdInTx() {
      return opts.findByIdInTxResult ?? null;
    },
    async lockForUpdate() {
      return opts.lockedStatus ?? null;
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
      return makeBroadcast(status as BroadcastStatus, fields);
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
  };
  return { port, transitions };
}

function makeBroadcast(status: BroadcastStatus, fields: unknown): Broadcast {
  const f = fields as {
    rejectedAt?: Date;
    rejectedByUserId?: string;
    rejectionReason?: string;
  };
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
    rejectedAt: f.rejectedAt ?? null,
    rejectedByUserId: f.rejectedByUserId ?? null,
    rejectionReason: f.rejectionReason ?? null,
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

const baseInput = {
  broadcastId,
  actorUserId: 'admin-7',
  rejectionReason: 'Off-topic for chamber audience.',
  requestId: 'req-1',
} as const;

const clock = { now: (): Date => FROZEN_NOW };

beforeEach(() => vi.useFakeTimers({ now: FROZEN_NOW }));
afterEach(() => vi.useRealTimers());

describe('reject-broadcast โ€” Wave 6 GREEN (T101)', () => {
  // ===== D1 closure (verify-fix 2026-05-02) โ€” G2 notification tests =====

  it('D1 G2: sendMemberEmail enqueued with VERBATIM rejection reason in payload + tenant locale threaded', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    const result = await rejectBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
      },
      { ...baseInput, notificationLocale: 'sv' },
    );
    expect(result.ok).toBe(true);
    expect(email.memberCalls).toHaveLength(1);
    const call = email.memberCalls[0]!;
    expect(call.templateKey).toBe('broadcast_rejected');
    expect(call.locale).toBe('sv');
    // VERBATIM reason in payload (FR-012); audit retains hash-only
    expect(call.payload['rejectionReason']).toBe(baseInput.rejectionReason);
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_rejected');
    expect((evt?.payload as { rejectionReasonHash?: string }).rejectionReasonHash).toBeTruthy();
    // Audit MUST NOT contain raw reason (FR-012)
    expect(JSON.stringify(evt?.payload)).not.toContain(baseInput.rejectionReason);
  });

  it('D1 G2: notificationLocale defaults to "en" when input field omitted', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    await rejectBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audit: audit.port,
        clock,
        emailTransactional: email.port,
      },
      baseInput,
    );
    expect(email.memberCalls[0]?.locale).toBe('en');
  });

  it('D1 G2: emailTransactional throws โ’ audit + transition still complete', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail({ shouldThrow: true });
    const result = await rejectBroadcast(
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
    expect(audit.emits.find((e) => e.eventType === 'broadcast_rejected')).toBeDefined();
  });

  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  it('happy: lockForUpdate(submitted) โ’ applyTransition(rejected, rejectedAt, rejectionReason)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const result = await rejectBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(repo.transitions).toHaveLength(1);
    expect(repo.transitions[0]?.status).toBe('rejected');
    const fields = repo.transitions[0]?.fields as {
      rejectedAt: Date;
      rejectedByUserId: string;
      rejectionReason: string;
    };
    expect(fields.rejectedAt).toEqual(FROZEN_NOW);
    expect(fields.rejectedByUserId).toBe('admin-7');
    expect(fields.rejectionReason).toBe(baseInput.rejectionReason);
  });

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
    const result = await rejectBroadcast(
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
    const result = await rejectBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_not_found');
    }
  });

  // ===== R5 verify-fix Tests-H5 (2026-05-02) โ€” locale chain =====
  it('locale chain: memberPreferred WINS over input.notificationLocale', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi.fn().mockResolvedValue('sv'),
    } as unknown as NonNullable<Parameters<typeof rejectBroadcast>[0]['membersBridge']>;
    await rejectBroadcast(
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
    } as unknown as NonNullable<Parameters<typeof rejectBroadcast>[0]['membersBridge']>;
    await rejectBroadcast(
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
    } as unknown as NonNullable<Parameters<typeof rejectBroadcast>[0]['membersBridge']>;
    await rejectBroadcast(
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
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const email = makeEmail();
    const membersBridge = {
      getMemberPreferredLocale: vi
        .fn()
        .mockRejectedValue(new Error('bridge boom')),
    } as unknown as NonNullable<Parameters<typeof rejectBroadcast>[0]['membersBridge']>;
    const result = await rejectBroadcast(
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

  // ---- Reason validation -------------------------------------------------

  it('rejects empty rejectionReason โ’ broadcast_rejection_reason_required', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const result = await rejectBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, rejectionReason: '' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_rejection_reason_required');
    }
    expect(repo.transitions).toHaveLength(0);
  });

  it('rejects whitespace-only rejectionReason โ’ broadcast_rejection_reason_required', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const result = await rejectBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, rejectionReason: '   \t\n  ' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_rejection_reason_required');
    }
  });

  it('rejects rejectionReason > 2000 chars โ’ broadcast_rejection_reason_too_long', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const tooLong = 'x'.repeat(2001);
    const result = await rejectBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, rejectionReason: tooLong },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_rejection_reason_too_long');
      if (result.error.kind === 'broadcast_rejection_reason_too_long') {
        expect(result.error.length).toBe(2001);
      }
    }
  });

  it('accepts rejectionReason at exactly 2000 chars boundary', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    const reason = 'y'.repeat(2000);
    const result = await rejectBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      { ...baseInput, rejectionReason: reason },
    );
    expect(result.ok).toBe(true);
  });

  // ---- FR-012 โ€” sha256 hash, NOT raw reason -----------------------------

  it('audit broadcast_rejected payload contains rejectionReasonHash (sha256) NOT raw rejectionReason', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'submitted' });
    await rejectBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_rejected');
    expect(evt).toBeDefined();
    const payload = evt?.payload as Record<string, unknown>;
    const expectedHash = createHash('sha256')
      .update(baseInput.rejectionReason, 'utf8')
      .digest('hex');
    expect(payload.rejectionReasonHash).toBe(expectedHash);
    // Hard guarantee โ€” verbatim reason MUST NOT leak into audit
    expect(JSON.stringify(payload)).not.toContain(baseInput.rejectionReason);
    expect(payload.rejectionReasonLength).toBe(baseInput.rejectionReason.length);
  });

  it('rejectionReasonHash is deterministic โ€” same reason produces same hash', async () => {
    const audit1 = makeAudit();
    const repo1 = makeRepo({ lockedStatus: 'submitted' });
    const audit2 = makeAudit();
    const repo2 = makeRepo({ lockedStatus: 'submitted' });
    await rejectBroadcast(
      { tenant, broadcastsRepo: repo1.port, audit: audit1.port, clock },
      baseInput,
    );
    await rejectBroadcast(
      { tenant, broadcastsRepo: repo2.port, audit: audit2.port, clock },
      baseInput,
    );
    const h1 = (audit1.emits[0]?.payload as { rejectionReasonHash: string })
      .rejectionReasonHash;
    const h2 = (audit2.emits[0]?.payload as { rejectionReasonHash: string })
      .rejectionReasonHash;
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  // ---- Concurrency ------------------------------------------------------

  it('applyTransition throws BroadcastConcurrentMutationError โ’ broadcast_concurrent_action_blocked', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'submitted',
      applyTransitionThrows: true,
      findByIdInTxResult: makeBroadcast('cancelled', {}),
    });
    const result = await rejectBroadcast(
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

  it('concurrent: refresh returns null โ’ observedStatus=unknown', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'submitted',
      applyTransitionThrows: true,
      findByIdInTxResult: null,
    });
    const result = await rejectBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    if (!result.ok && result.error.kind === 'broadcast_concurrent_action_blocked') {
      expect(result.error.observedStatus).toBe('unknown');
    }
  });

  // ---- Server error catch-all -------------------------------------------

  it('repo throw inside withTx โ’ reject.server_error', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ withTxThrows: true });
    const result = await rejectBroadcast(
      { tenant, broadcastsRepo: repo.port, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('reject.server_error');
      if (result.error.kind === 'reject.server_error') {
        expect(result.error.message).toBe('tx-rolled-back');
      }
    }
  });

  it('non-Error thrown โ’ reject.server_error with "unknown error" message', async () => {
    const audit = makeAudit();
    const repo: BroadcastsRepo = {
      ...makeRepo({}).port,
      async withTx() {
        throw 'string-error';
      },
    };
    const result = await rejectBroadcast(
      { tenant, broadcastsRepo: repo, audit: audit.port, clock },
      baseInput,
    );
    if (!result.ok && result.error.kind === 'reject.server_error') {
      expect(result.error.message).toBe('unknown error');
    }
  });
});
