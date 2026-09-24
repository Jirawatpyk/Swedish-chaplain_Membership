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
import {
  makeFakeBroadcastImagesRepo,
  makeFakeEblastOutbox,
  makeFakeMarketingDirectory,
} from '../../../helpers/eblast-approval-fakes';
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
    // T086 — the Contacts-Import build (migration 0298). Absent on every fixture written before it.
    audienceImportId: null,
    audienceImportSubmittedAt: null,
    audienceImportCompletedAt: null,
    resendBroadcastId: null,
    retentionYears: 5,
    manualRetryCount: 0,
    partialDeliveryAcceptedAt: null,
    partialDeliveryAcceptedByUserId: null,
    templateProvenance: null,
    proposedSendAt: null,
    stageEnteredAt: new Date('2026-01-01T00:00:00Z'),
    currentRound: 0,
    approvedVersionId: null,
    memberReminderStage: 0,
    memberExpiryNotifiedAt: null,
    createdAt: FROZEN_NOW,
    updatedAt: FROZEN_NOW,
  };
}

interface RepoOpts {
  readonly existing?: Broadcast | null;
  readonly applyTransitionThrows?: boolean;
  readonly refreshAfterRace?: Broadcast | null;
  readonly withTxThrows?: Error | string;
  /**
   * Bug #5 — observe whether the withTx callback committed (returned) or
   * rolled back (threw). Mirrors db.transaction semantics so a test can prove
   * the concurrency path forces a ROLLBACK rather than committing partial
   * batch halts.
   */
  readonly onTxOutcome?: (outcome: 'committed' | 'rolled_back') => void;
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
        // Mimic db.transaction: commit on normal return, rollback + rethrow
        // on throw. Lets the bug #5 test distinguish the two outcomes.
        try {
          const result = await fn(null);
          opts.onTxOutcome?.('committed');
          return result;
        } catch (e) {
          opts.onTxOutcome?.('rolled_back');
          throw e;
        }
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
      // Round-4 B5 — the non-locking pre-read the locale read keys on.
      async findById() {
        return opts.existing ?? null;
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
      async attachBroadcastId() {},
      async attachAudienceId() {},
      // Phase 9b (T147) — unused here; present so the stub still satisfies
      // BroadcastsRepo.
      // T086 — unused here; present so the stub still satisfies BroadcastsRepo.
      async attachAudienceImport() {},
      async markAudienceImportCompleted() {},
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
        return { prunedDrafts: [] };
      },
    async listInFlightOwnedByMember() { return []; },
    async scrubContentForMemberInTx() { return { scrubbedCount: 0 }; },
    async tombstoneDeliveriesForMemberInTx() { return { tombstonedCount: 0 }; },
    async listMemberResendAudienceContactsInTx() { return []; },
    async redactMemberEmailFromCustomRecipientsInTx() { return { redactedCount: 0 }; },
    async listTerminalBroadcastsWithLiveAudience() { throw new Error('not used in cancel-broadcast fixture'); },
    async markAudienceDeletedInTx() { throw new Error('not used in cancel-broadcast fixture'); },
    async existingBroadcastIds() { throw new Error('not used in cancel-broadcast fixture'); },
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
  actorRole: 'admin',
  cancellationReason: 'Wrong send list',
  requestId: 'req-1',
} as const;

/** F119 T081 — the three deps the widened cancel adds (images, roster, eblast outbox). */
const t081Deps = () => ({
  imagesRepo: makeFakeBroadcastImagesRepo(),
  marketingDirectory: makeFakeMarketingDirectory([]),
  eblastOutbox: makeFakeEblastOutbox(),
});

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
        ...t081Deps(),
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
    // Whole-branch review LOW-5 — no template reads the prior stage; it lives
    // on the audit row (`previousStatus`), never in the notification payload.
    expect(call.payload).not.toHaveProperty('fromStatus');
  });

  it('T166 R-L3: a member withdrawal reads the roster BEFORE its tx and reports an empty one once, after the commit; a staff cancel reads none', async () => {
    const member = { kind: 'member', memberId: 'm-1', userId: 'u-1' } as const;
    const order: string[] = [];
    const repo = makeRepo({ existing: makeBroadcast('submitted', 'm-1') });
    const inner = repo.port.withTx.bind(repo.port);
    repo.port.withTx = (async (fn: (tx: unknown) => Promise<unknown>) => {
      order.push('withTx');
      return inner(fn as never);
    }) as BroadcastsRepo['withTx'];
    const directory = makeFakeMarketingDirectory([]);
    directory.readRoster.mockImplementation(async () => {
      order.push('readRoster');
      return [];
    });
    const deps = { ...t081Deps(), marketingDirectory: directory };
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...deps, audit: makeAudit().port, clock },
      { ...baseInput, actor: member, cancellationReason: null },
    );
    expect(result.ok).toBe(true);
    expect(directory.readRoster).toHaveBeenCalledTimes(1);
    expect(directory.listRecipients).not.toHaveBeenCalled();
    expect(directory.reportEmptyRoster).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['readRoster', 'withTx']);

    // A staff cancel is not a hand-off: no roster read at all.
    const staffDir = makeFakeMarketingDirectory([]);
    await cancelBroadcast(
      { tenant, broadcastsRepo: makeRepo({ existing: makeBroadcast('submitted') }).port, ...t081Deps(), marketingDirectory: staffDir, audit: makeAudit().port, clock },
      baseInput,
    );
    expect(staffDir.readRoster).not.toHaveBeenCalled();
    expect(staffDir.reportEmptyRoster).not.toHaveBeenCalled();
  });

  it('T166 R-L3: a member withdrawal refused inside its tx (not the owner) reads the roster but never reports it', async () => {
    const directory = makeFakeMarketingDirectory([]);
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: makeRepo({ existing: makeBroadcast('submitted', 'm-OTHER') }).port, ...t081Deps(), marketingDirectory: directory, audit: makeAudit().port, clock },
      { ...baseInput, actor: { kind: 'member', memberId: 'm-1', userId: 'u-1' }, cancellationReason: null },
    );
    expect(result.ok).toBe(false);
    expect(directory.reportEmptyRoster).not.toHaveBeenCalled();
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
        ...t081Deps(),
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
        ...t081Deps(),
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
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
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
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(true);
  });

  it('happy member-self: actor.memberId matches requestedByMemberId โ’ cancelled', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted', 'm-1') });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
      { ...baseInput, actor: memberActor },
    );
    expect(result.ok).toBe(true);
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_cancelled');
    expect((evt?.payload as { actorKind: string }).actorKind).toBe('member');
    expect((evt?.payload as { actorRole: string }).actorRole).toBe(
      'member_self_service',
    );
  });

  // ===== F119 round-4 B4 / B5 — the row lock and the pool reads ==========

  // B4 — a dispatcher attach that commits between an UNLOCKED read and the
  // status-only CAS let the row end `cancelled` with a Resend id set. The row
  // is locked before it is read, so `hasDispatchBegun` sees the attach.
  it('round-4 B4: the row is locked (lockForUpdate) inside the tx BEFORE it is read', async () => {
    const order: string[] = [];
    const repo = makeRepo({ existing: makeBroadcast('approved') });
    const lock = repo.port.lockForUpdate.bind(repo.port);
    const read = repo.port.findByIdInTx.bind(repo.port);
    repo.port.lockForUpdate = (async (...args: Parameters<BroadcastsRepo['lockForUpdate']>) => {
      order.push('lock');
      return lock(...args);
    }) as BroadcastsRepo['lockForUpdate'];
    repo.port.findByIdInTx = (async (...args: Parameters<BroadcastsRepo['findByIdInTx']>) => {
      order.push('read');
      return read(...args);
    }) as BroadcastsRepo['findByIdInTx'];
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: makeAudit().port, clock },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual(['lock', 'read']);
  });

  // B5 — the member's preferred locale is a members-bridge read on its OWN
  // pool connection; made inside the tx it held a second connection while
  // the row lock sat on the first (the R-L3 class).
  it('round-4 B5: the preferred locale is read with NO transaction open, for the owning member, and still used', async () => {
    let open = false;
    const repo = makeRepo({ existing: makeBroadcast('submitted', 'm-1') });
    const inner = repo.port.withTx.bind(repo.port);
    repo.port.withTx = (async (fn: (tx: unknown) => Promise<unknown>) =>
      inner(async (tx) => {
        open = true;
        try {
          return await fn(tx);
        } finally {
          open = false;
        }
      })) as BroadcastsRepo['withTx'];
    const seen: boolean[] = [];
    const membersBridge = {
      getMemberPreferredLocale: vi.fn(async () => {
        seen.push(open);
        return 'sv' as const;
      }),
    } as unknown as NonNullable<Parameters<typeof cancelBroadcast>[0]['membersBridge']>;
    const email = makeEmail();
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: makeAudit().port, clock, emailTransactional: email.port, membersBridge },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual([false]);
    expect(vi.mocked(membersBridge.getMemberPreferredLocale)).toHaveBeenCalledWith(tenant, 'm-1');
    expect(email.memberCalls[0]?.locale).toBe('sv');
  });

  it("round-4 B5: a member cancelling another member's E-Blast reads no locale for it (and still sees not found)", async () => {
    const membersBridge = {
      getMemberPreferredLocale: vi.fn(async () => 'sv' as const),
    } as unknown as NonNullable<Parameters<typeof cancelBroadcast>[0]['membersBridge']>;
    const result = await cancelBroadcast(
      {
        tenant,
        broadcastsRepo: makeRepo({ existing: makeBroadcast('submitted', 'm-other') }).port,
        ...t081Deps(),
        audit: makeAudit().port,
        clock,
        emailTransactional: makeEmail().port,
        membersBridge,
      },
      { ...baseInput, actor: memberActor, cancellationReason: null },
    );
    expect(result).toEqual({ ok: false, error: { kind: 'broadcast_not_found', broadcastId } });
    expect(vi.mocked(membersBridge.getMemberPreferredLocale)).not.toHaveBeenCalled();
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
        ...t081Deps(),
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
        ...t081Deps(),
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
        ...t081Deps(),
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
        ...t081Deps(),
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

  // F119 T081 — from `sending` onward the refusal is `sending_started`
  // (the send completes); the audit row is still `broadcast_cancel_too_late`.
  it.each<BroadcastStatus>(['sending', 'sent', 'partially_sent', 'partial_delivery_accepted'])(
    'rejects when status=%s → sending_started + broadcast_cancel_too_late audit, nothing transitioned',
    async (s) => {
      const audit = makeAudit();
      const repo = makeRepo({ existing: makeBroadcast(s) });
      const result = await cancelBroadcast(
        { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
        baseInput,
      );
      expect(result.ok ? null : result.error).toEqual({ kind: 'sending_started', observedStatus: s });
      expect(audit.emits.find((e) => e.eventType === 'broadcast_cancel_too_late')).toBeDefined();
      expect(repo.transitions).toHaveLength(0);
    },
  );

  // T166 R-H1, the cancel's share — `approved` but already handed over (the
  // dispatch leg commits its lock before calling Resend, so the status has not
  // moved yet). Every other exit from `approved` refuses here; a cancel that
  // did not would read `cancelled` and free the allowance while the email went
  // out. Same refusal + audit as the status cut-off, nothing written.
  it.each([
    { leg: 'legacy leg', ids: { resendBroadcastId: 'rb-live-1' } },
    { leg: 'import leg', ids: { audienceImportId: 'imp-live-1' } },
  ])('approved once dispatch has begun ($leg) → sending_started + broadcast_cancel_too_late audit, nothing transitioned', async ({ ids }) => {
    const audit = makeAudit();
    const images = makeFakeBroadcastImagesRepo();
    const repo = makeRepo({ existing: { ...makeBroadcast('approved'), ...ids } });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), imagesRepo: images, audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok ? null : result.error).toEqual({ kind: 'sending_started', observedStatus: 'approved' });
    expect(audit.emits.map((e) => e.eventType)).toEqual(['broadcast_cancel_too_late']);
    expect(repo.transitions).toHaveLength(0);
    expect(images.markDeletedByOwner).not.toHaveBeenCalled();
  });

  it.each<BroadcastStatus>([
    'rejected',
    'cancelled',
    'failed_to_dispatch',
    'expired_no_member_response',
    'draft',
  ])('rejects when status=%s โ’ broadcast_cancel_too_late + audit emitted', async (s) => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast(s) });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
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
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_not_found');
  });

  it("member-self trying to cancel another member's broadcast โ’ broadcast_not_found (no leak)", async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted', 'm-OTHER') });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
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
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
      { ...baseInput, cancellationReason: null },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects cancellationReason > 500 chars โ’ broadcast_cancel_reason_too_long', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ existing: makeBroadcast('submitted') });
    const tooLong = 'r'.repeat(501);
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
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
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
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
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
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
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
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
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
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
    const repo = makeRepo({ existing: makeBroadcast('rejected') });
    const auditPort: AuditPort = {
      async emit() {
        throw new Error('audit table down');
      },
      async emitTyped() {
        throw new Error('audit table down');
      },
    };
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: auditPort, clock },
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
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('cancel.server_error');
      if (result.error.kind === 'cancel.server_error') {
        // T166 R-M4 — the error CLASS, never the message.
        expect(result.error.errKind).toBe('Error');
        expect(JSON.stringify(result.error)).not.toContain('db down');
      }
    }
  });

  it('non-Error thrown โ’ cancel.server_error with "unknown error" message', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ withTxThrows: 'string-error' });
    const result = await cancelBroadcast(
      { tenant, broadcastsRepo: repo.port, ...t081Deps(), audit: audit.port, clock },
      baseInput,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'cancel.server_error', errKind: 'unknown' } });
  });
});
