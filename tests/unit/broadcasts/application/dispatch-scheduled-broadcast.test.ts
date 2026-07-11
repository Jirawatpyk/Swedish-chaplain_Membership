/**
 * Unit tests for `dispatch-scheduled-broadcast.ts` cron worker.
 *
 * Wave 6 GREEN โ€” covers the deferred-cron pattern (Ultraplan AD1):
 *   - lockForUpdate('approved') + recipient re-resolve
 *   - Resend Broadcasts API surface (createAudience + addContactsToAudience
 *     + createBroadcast + sendBroadcast with stable idempotency key)
 *   - attachResendIds + applyTransition('sending') + audit
 *   - Retryable failures (gateway throws {kind:'retryable'}) โ’ row stays
 *     'approved' (no transition, no audit)
 *   - Permanent failures โ’ applyTransition('failed_to_dispatch') + audit
 *   - Audience-empty-post-suppression branch
 *   - DB write failure AFTER Resend success โ’ kind='gateway_retryable'
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dispatchScheduledBroadcast } from '@/modules/broadcasts/application/use-cases/dispatch-scheduled-broadcast';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { ok, err } from '@/lib/result';
import {
  unsafeBrandEmailLower,
  type EmailLower,
} from '@/modules/broadcasts/domain/value-objects/email-lower';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';
import type {
  BroadcastsGatewayPort,
  AudienceContact,
} from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import type {
  MembersBridgePort,
  MemberRecipient,
} from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { MarketingUnsubscribesRepo } from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';
import type { EventAttendeesRepository } from '@/modules/broadcasts/application/ports/event-attendees-repository';
import type { PlansBridgePort } from '@/modules/broadcasts/application/ports/plans-bridge-port';
import type { EmailTransactionalPort } from '@/modules/broadcasts/application/ports/email-transactional-port';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import type { BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/dispatch-scheduled-broadcast.ts',
);
const tenant: TenantContext = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');
const broadcastId = asBroadcastId('44444444-4444-4444-4444-444444444444');

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

function makeBroadcast(status: BroadcastStatus = 'approved'): Broadcast {
  return {
    tenantId: 'test-tenant',
    broadcastId,
    requestedByMemberId: 'm-1',
    requestedByMemberPlanIdSnapshot: 'p',
    submittedByUserId: 'u-1',
    actorRole: 'member_self_service',
    subject: 'Welcome',
    bodyHtml: '<p>Hello world</p>',
    bodySource: 'plain',
    fromName: 'Test Chamber',
    replyToEmail: 'me@example.com',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 2,
    status,
    submittedAt: FROZEN_NOW,
    approvedAt: FROZEN_NOW,
    approvedByUserId: 'admin-7',
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    scheduledFor: FROZEN_NOW,
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
  readonly lockedStatus?: BroadcastStatus | null;
  readonly broadcast?: Broadcast | null;
  readonly applyTransitionThrowsOnFinal?: boolean;
}

function makeRepo(opts: RepoOpts): {
  port: BroadcastsRepo;
  transitions: Array<{ status: string; fields: unknown }>;
  attachCalls: Array<{ audienceId: string; broadcastId: string }>;
  attachAudienceCalls: Array<{ audienceId: string }>;
} {
  const transitions: Array<{ status: string; fields: unknown }> = [];
  const attachCalls: Array<{ audienceId: string; broadcastId: string }> = [];
  const attachAudienceCalls: Array<{ audienceId: string }> = [];
  return {
    transitions,
    attachCalls,
    attachAudienceCalls,
    port: {
      async withTx(fn) {
        return fn(null);
      },
      async insertDraft() {
        throw new Error('not used');
      },
      async updateDraft() {
        throw new Error('not used');
      },
      async updateDraftFromTemplate() {
        throw new Error('not used in dispatch-scheduled-broadcast fixture');
      },
      async findById() {
        return null;
      },
      async findByIdInTx() {
        return opts.broadcast ?? null;
      },
      async lockForUpdate() {
        return opts.lockedStatus ?? null;
      },
      async applyTransition(_tx, _t, _b, status, fields) {
        transitions.push({ status, fields });
        if (opts.applyTransitionThrowsOnFinal && status === 'sending') {
          throw new Error('db write failed after resend success');
        }
        return { ...(opts.broadcast as Broadcast), status };
      },
      async attachResendIds(_tx, _t, _b, audienceId, resendBroadcastId) {
        attachCalls.push({ audienceId, broadcastId: resendBroadcastId });
      },
      async attachAudienceId(_tx, _t, _b, audienceId) {
        attachAudienceCalls.push({ audienceId });
      },
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
    async scrubContentForMemberInTx() { return { scrubbedCount: 0 }; },
    async tombstoneDeliveriesForMemberInTx() { return { tombstonedCount: 0 }; },
    async listMemberResendAudienceContactsInTx() { return []; },
    async redactMemberEmailFromCustomRecipientsInTx() { return { redactedCount: 0 }; },
    async listTerminalBroadcastsWithLiveAudience() { throw new Error('not used in dispatch-scheduled-broadcast fixture'); },
    async markAudienceDeletedInTx() { throw new Error('not used in dispatch-scheduled-broadcast fixture'); },
    async existingBroadcastIds() { throw new Error('not used in dispatch-scheduled-broadcast fixture'); },
    },
  };
}

type ThrowSpec =
  | { kind: 'retryable' | 'permanent'; reason: string }
  | {
      kind: 'resource_missing';
      reason: string;
      resourceType: 'audience' | 'broadcast';
      resourceId: string;
    }
  // R7 staff-review HIGH-3 — idempotency_conflict thrown when a
  // concurrent worker raced through createAudience/createBroadcast.
  | { kind: 'idempotency_conflict'; reason: string };

interface GatewayOpts {
  readonly throwOnCreateAudience?: ThrowSpec;
  readonly throwOnCreateBroadcast?: ThrowSpec;
  readonly throwOnSend?: ThrowSpec;
  readonly errorAsPlainError?: boolean;
  /** Round-5 R5-T โ€” let tests synthesise audience-count drift on idempotency replay. */
  readonly audienceContactCount?: number | null;
  readonly throwOnGetAudienceContactCount?: ThrowSpec;
}

function makeGateway(opts: GatewayOpts = {}): {
  port: BroadcastsGatewayPort;
  audienceCalls: Array<string>;
  contactsCalls: Array<{ audienceId: string; contacts: ReadonlyArray<AudienceContact> }>;
  createCalls: Array<{ audienceId: string; subject: string; broadcastNameForResendDashboard: string }>;
  sendCalls: Array<{ broadcastId: string; idempotencyKey: string }>;
} {
  const audienceCalls: Array<string> = [];
  const contactsCalls: Array<{
    audienceId: string;
    contacts: ReadonlyArray<AudienceContact>;
  }> = [];
  const createCalls: Array<{ audienceId: string; subject: string; broadcastNameForResendDashboard: string }> = [];
  const sendCalls: Array<{ broadcastId: string; idempotencyKey: string }> = [];
  function maybeThrow(spec?: ThrowSpec): void {
    if (!spec) return;
    if (opts.errorAsPlainError) {
      throw new Error(spec.reason);
    }
    throw spec;
  }
  return {
    audienceCalls,
    contactsCalls,
    createCalls,
    sendCalls,
    port: {
      async createAudience(name) {
        audienceCalls.push(name);
        maybeThrow(opts.throwOnCreateAudience);
        return { audienceId: 'aud-fake-1' };
      },
      async addContactsToAudience(audienceId, contacts) {
        contactsCalls.push({ audienceId, contacts });
      },
      async createBroadcast(input) {
        createCalls.push({ audienceId: input.audienceId, subject: input.subject, broadcastNameForResendDashboard: input.broadcastNameForResendDashboard });
        maybeThrow(opts.throwOnCreateBroadcast);
        return { broadcastId: 'bcast-fake-1' };
      },
      async sendBroadcast(rid, key) {
        sendCalls.push({ broadcastId: rid, idempotencyKey: key });
        maybeThrow(opts.throwOnSend);
      },
      async retrieveBroadcast() {
        return { kind: 'not_found' as const };
      },
      async getAudienceContactCount() {
        if (opts.throwOnGetAudienceContactCount) {
          maybeThrow(opts.throwOnGetAudienceContactCount);
        }
        return {
          kind: 'present' as const,
          count: opts.audienceContactCount ?? 2,
        };
      },
      async removeContactFromAudience() {},
      async deleteAudience() {},
      async listAudiences() { return []; },
    },
  };
}

/**
 * Phase 8 Slice B helper โ€” `PlansBridgePort` stub returning a successful
 * plan lookup by default (matches the broadcast snapshot's planId so
 * the T171 expired-plan audit does NOT fire). Tests that want to
 * exercise the AS5 path override `planId` or set `lookupError`.
 */
function makePlansBridge(opts: {
  planId?: string;
  planCode?: string;
  eblastPerYear?: number;
  lookupError?:
    | { kind: 'plan_lookup.member_not_found'; memberId: string }
    | { kind: 'plan_lookup.member_no_plan'; memberId: string }
    | { kind: 'plan_lookup.plan_not_found'; planId: string };
  shouldThrow?: boolean;
} = {}): PlansBridgePort {
  return {
    async getPlanForMember() {
      if (opts.shouldThrow) {
        throw new Error('simulated plansBridge.getPlanForMember failure');
      }
      if (opts.lookupError) {
        return err(opts.lookupError);
      }
      return ok({
        planId: opts.planId ?? 'p',
        planCode: opts.planCode ?? 'P',
        eblastPerYear: opts.eblastPerYear ?? 5,
      });
    },
  };
}

/**
 * Phase 8 Slice E helper โ€” `EmailTransactionalPort` stub recording all
 * `sendMemberEmail` calls so tests can assert the dispatch-failure
 * notification was enqueued (or NOT enqueued) at the right path. Stub
 * may be configured to throw to exercise the best-effort error path.
 */
function makeEmailTransactional(opts: {
  shouldThrow?: boolean;
} = {}): {
  port: EmailTransactionalPort;
  memberCalls: Array<{
    to: string;
    templateKey: string;
    payload: Record<string, unknown>;
    locale: string;
  }>;
} {
  const memberCalls: Array<{
    to: string;
    templateKey: string;
    payload: Record<string, unknown>;
    locale: string;
  }> = [];
  return {
    memberCalls,
    port: {
      async sendAdminNotification() {},
      async sendMemberEmail(_ctx, input) {
        if (opts.shouldThrow) {
          throw new Error('simulated emailTransactional.sendMemberEmail failure');
        }
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

function makeMembersBridge(opts: {
  recipients?: ReadonlyArray<MemberRecipient>;
  primaryContact?: string | null;
}): MembersBridgePort {
  return {
    async getMembersBySegment() {
      return opts.recipients ?? [];
    },
    async getMemberPrimaryContact() {
      return opts.primaryContact !== undefined && opts.primaryContact !== null
        ? unsafeBrandEmailLower(opts.primaryContact)
        : null;
    },
    async lookupContactEmailInTenant() {
      return null;
    },
    async lookupMemberPrimaryContactEmailInTenant() {
      return null;
    },
    async getMembersHaltedInTenant() {
      return [];
    },
    async setMemberHalt() {
      return ok(undefined);
    },
    async memberExistsInTenant() { return true; },
    async markBroadcastsAcknowledged() {
      return ok({ previouslyNull: true });
    },
    async getMemberPreferredLocale() { return null; },
  };
}

function makeMarketingUnsubscribes(
  suppressed: ReadonlySet<string> = new Set(),
): MarketingUnsubscribesRepo {
  return {
    async upsert() {
      throw new Error('not used');
    },
    async findByEmailLower() {
      return null;
    },
    async lookupBatch(_ctx, emails) {
      const out = new Set<EmailLower>();
      for (const e of emails) {
        if (suppressed.has(e as string)) out.add(e);
      }
      return out;
    },
    async setMemberIdNull() {
      return { affected: 0 };
    },
  };
}

function makeEventAttendees(): EventAttendeesRepository {
  return {
    async getLastNinetyDayAttendees() {
      return [];
    },
    async lookupAttendeeEmailInTenant() {
      return null;
    },
  };
}

function recipient(memberId: string, email: string): MemberRecipient {
  return {
    memberId,
    displayName: memberId,
    primaryContactEmail: unsafeBrandEmailLower(email),
    tierCode: null,
    broadcastsHaltedUntilAdminReview: false,
  };
}

const baseInput = { broadcastId };

const clock = { now: (): Date => FROZEN_NOW };

beforeEach(() => vi.useFakeTimers({ now: FROZEN_NOW }));
afterEach(() => vi.useRealTimers());

describe('dispatch-scheduled-broadcast โ€” Wave 6 GREEN', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  it('happy: lock+resolve+createAudience+addContacts+createBroadcast+sendBroadcast โ’ applyTransition(sending) + audit broadcast_send_started', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [
            recipient('m-1', 'one@example.com'),
            recipient('m-2', 'two@example.com'),
          ],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(gw.audienceCalls).toHaveLength(1);
    expect(gw.contactsCalls).toHaveLength(1);
    expect(gw.createCalls).toHaveLength(1);
    expect(gw.sendCalls).toHaveLength(1);
    expect(repo.transitions[0]?.status).toBe('sending');
    expect(repo.attachCalls[0]).toEqual({
      audienceId: 'aud-fake-1',
      broadcastId: 'bcast-fake-1',
    });
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_send_started');
    expect(evt).toBeDefined();
    expect(
      (evt?.payload as { resendAudienceId: string }).resendAudienceId,
    ).toBe('aud-fake-1');
    expect(
      (evt?.payload as { resendBroadcastId: string }).resendBroadcastId,
    ).toBe('bcast-fake-1');
    // E1 closure (verify-fix 2026-05-02) โ€” AS1 spec.md L323 requires
    // the audit payload to carry `scheduled_for + actual_send_at +
    // delay_seconds` for SC-001 quartile analysis. Lock the field
    // shape so future refactors that drop them are caught at test time.
    const payload = evt?.payload as {
      scheduledFor?: string | null;
      actualSendAt?: string;
      delaySeconds?: number | null;
      sendingStartedAt?: string;
    };
    // makeBroadcast() seeds scheduledFor = FROZEN_NOW, so delay = 0
    expect(payload.scheduledFor).toBe(FROZEN_NOW.toISOString());
    expect(payload.actualSendAt).toBe(FROZEN_NOW.toISOString());
    expect(payload.delaySeconds).toBe(0);
    // sendingStartedAt retained for backward compatibility with the
    // existing US5 reconciliation summary email build helper.
    expect(payload.sendingStartedAt).toBe(FROZEN_NOW.toISOString());
  });

  it('idempotency key format: broadcast-{tenantId}-{broadcastId}', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(gw.sendCalls[0]?.idempotencyKey).toBe(
      `broadcast-test-tenant-${broadcastId as string}`,
    );
  });

  it('skips when locked status != approved โ’ broadcast_invalid_state_transition', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'sending',
      broadcast: makeBroadcast('sending'),
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({}),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_invalid_state_transition');
    }
    expect(gw.audienceCalls).toHaveLength(0);
  });

  it('skips when broadcast not found (lockForUpdate=null) โ’ broadcast_invalid_state_transition', async () => {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: null, broadcast: null });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({}),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_invalid_state_transition');
    }
  });

  // ---- Audience-empty-post-suppression --------------------------------

  it('audience evaporates after suppression filter โ’ applyTransition(failed_to_dispatch) + audit', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(
          new Set(['one@example.com']),
        ),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_audience_post_suppression_empty');
    }
    expect(gw.audienceCalls).toHaveLength(0);
    expect(
      repo.transitions.find((t) => t.status === 'failed_to_dispatch'),
    ).toBeDefined();
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_failed_to_dispatch'),
    ).toBeDefined();
  });

  // ---- Bug #13: audience grew past the cap since submit ----------------
  it('#13: audience grew past the 5,000 cap since submit → failed reason "audience_too_large" (NOT mislabelled empty)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    // 5,001 distinct recipients resolve now (e.g. a bulk member import landed
    // between submit and this dispatch tick) → resolveSegmentRecipients
    // returns broadcast_audience_too_large.
    const bigAudience = Array.from({ length: 5001 }, (_, i) =>
      recipient(`m-${i}`, `u${i}@example.com`),
    );
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: bigAudience,
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(new Set()),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Bug #13: previously ALL resolve failures returned
      // broadcast_audience_post_suppression_empty — mislabelling "too large".
      expect(result.error.kind).toBe('broadcast_failed_to_dispatch');
      if (result.error.kind === 'broadcast_failed_to_dispatch') {
        expect(result.error.reason).toBe('audience_too_large');
      }
    }
    expect(gw.audienceCalls).toHaveLength(0);
    // The audit payload reason reflects "too large", not "empty".
    const failAudit = audit.emits.find(
      (e) => e.eventType === 'broadcast_failed_to_dispatch',
    );
    expect(failAudit).toBeDefined();
    expect((failAudit?.payload as { reason?: string })?.reason).toBe(
      'audience_too_large',
    );
  });

  // ---- Bridge throw on requesting-member primary lookup (W2-05) ------

  it('getMemberPrimaryContact throws โ’ dispatch.server_error, no transition, no audit (retried next tick)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    // W2-05: a Neon/RLS/timeout throw from the requesting-member primary
    // lookup (use-case L467-470) must be caught and mapped to the typed
    // dispatch.server_error โ€” NOT escape the use-case. The broadcast must
    // stay 'approved' (no transition, no audit) so the next cron tick
    // retries it cleanly. Mock-only happy-path tests missed this throw path.
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: {
          ...makeMembersBridge({
            recipients: [recipient('m-1', 'one@example.com')],
            primaryContact: 'sender@example.com',
          }),
          async getMemberPrimaryContact() {
            throw new Error('neon connection reset');
          },
        },
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('dispatch.server_error');
    }
    // No createAudience call, no state transition, no audit โ€” the broadcast
    // is untouched at 'approved' for a clean retry on the next tick.
    expect(gw.audienceCalls).toHaveLength(0);
    expect(repo.transitions).toHaveLength(0);
    expect(audit.emits).toHaveLength(0);
  });

  // ---- Gateway retryable failures -----------------------------------

  it('gateway retryable on createAudience โ’ kind=gateway_retryable, no transition, no audit', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnCreateAudience: { kind: 'retryable', reason: 'rate_limited' },
    });
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('gateway_retryable');
      if (result.error.kind === 'gateway_retryable') {
        expect(result.error.reason).toBe('rate_limited');
      }
    }
    expect(
      repo.transitions.find((t) => t.status === 'failed_to_dispatch'),
    ).toBeUndefined();
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_failed_to_dispatch'),
    ).toBeUndefined();
  });

  it('gateway retryable on sendBroadcast โ’ kind=gateway_retryable', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnSend: { kind: 'retryable', reason: 'temporary_503' },
    });
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    if (!result.ok && result.error.kind === 'gateway_retryable') {
      expect(result.error.reason).toBe('temporary_503');
    }
  });

  // ---- Gateway permanent failures -----------------------------------

  it('gateway permanent error (plain Error) on createBroadcast โ’ applyTransition(failed_to_dispatch) + audit', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnCreateBroadcast: { kind: 'permanent', reason: 'invalid_subject' },
      errorAsPlainError: true,
    });
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_failed_to_dispatch');
      if (result.error.kind === 'broadcast_failed_to_dispatch') {
        expect(result.error.reason).toBe('invalid_subject');
      }
    }
    const transition = repo.transitions.find(
      (t) => t.status === 'failed_to_dispatch',
    );
    expect(transition).toBeDefined();
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_failed_to_dispatch'),
    ).toBeDefined();
  });

  // ---- Resource missing (404 from Resend) โ€” F7.1-T2 -----------------

  it('gateway resource_missing on createBroadcast โ’ emits broadcast_resend_resource_missing audit + transitions to failed_to_dispatch', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnCreateBroadcast: {
        kind: 'resource_missing',
        reason: 'audience not found',
        resourceType: 'audience',
        resourceId: 'aud-fake-1',
      },
    });
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_resend_resource_missing');
      if (result.error.kind === 'broadcast_resend_resource_missing') {
        expect(result.error.resourceType).toBe('audience');
        expect(result.error.resourceId).toBe('aud-fake-1');
      }
    }
    // Distinct audit event emitted (NOT broadcast_failed_to_dispatch)
    const resourceMissingAudit = audit.emits.find(
      (e) => e.eventType === 'broadcast_resend_resource_missing',
    );
    expect(resourceMissingAudit).toBeDefined();
    expect(resourceMissingAudit?.payload['resourceType']).toBe('audience');
    expect(resourceMissingAudit?.payload['resourceId']).toBe('aud-fake-1');
    // Row transitions to failed_to_dispatch (not stuck in approved)
    expect(
      repo.transitions.find((t) => t.status === 'failed_to_dispatch'),
    ).toBeDefined();
  });

  // ---- DB write failure AFTER Resend success -------------------------

  it('applyTransition(sending) throws AFTER Resend already succeeded โ’ kind=gateway_retryable (next tick re-dispatches with same idempotency key)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
      applyTransitionThrowsOnFinal: true,
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(gw.sendCalls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('gateway_retryable');
      if (result.error.kind === 'gateway_retryable') {
        expect(result.error.reason).toContain('db_write_after_resend_success');
      }
    }
  });

  // ---- Recipient self-exclusion (Q16) -------------------------------

  it('requesting member primary contact email is excluded from audience contacts', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [
            recipient('m-1', 'sender@example.com'),
            recipient('m-2', 'two@example.com'),
          ],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    const sentEmails = gw.contactsCalls[0]?.contacts.map((c) => c.emailLower);
    expect(sentEmails).not.toContain('sender@example.com');
    expect(sentEmails).toContain('two@example.com');
  });

  // ---- Audience name stability (orphan-prevention polish 2026-05-01) -

  it('audience name is deterministic per (tenantId, broadcastId) โ€” no timestamp suffix so retries reuse', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(gw.audienceCalls[0]).toContain(broadcastId as string);
    expect(gw.audienceCalls[0]).toContain('test-tenant');
    // No timestamp in name โ€” stability lets retries reuse the same audience
    // (orphan-prevention; persisted via attachAudienceId).
    expect(gw.audienceCalls[0]).not.toContain(String(FROZEN_NOW.getTime()));
  });

  it('reuses persisted resendAudienceId on retry instead of creating a new audience', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      // Simulate a prior dispatch attempt that already persisted an
      // audience id (post-staff-review polish 2026-05-01 orphan-prevention).
      broadcast: { ...makeBroadcast('approved'), resendAudienceId: 'aud-existing' },
    });
    const gw = makeGateway();
    await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    // createAudience MUST NOT be called when an existing audience id is present.
    expect(gw.audienceCalls.length).toBe(0);
    // attachAudienceId MUST NOT be called either (no new id to persist).
    expect(repo.attachAudienceCalls.length).toBe(0);
    // Subsequent calls (addContacts + createBroadcast + sendBroadcast)
    // use the existing audience id.
    expect(gw.contactsCalls[0]?.audienceId).toBe('aud-existing');
  });

  // ---- Name-cap gate (T2-M1) ------------------------------------------
  // Regression guard: the dispatch call-site MUST pass a
  // `broadcastNameForResendDashboard` that is ≤70 code points, produced
  // by `resendDashboardName(fromName, subject)`. A future revert of that
  // wiring (e.g. inline template-literal) would cause every dispatch to
  // fail with Resend's "Field `name` has a maximum of 70 items" error.
  // This test uses a fromName + subject that exceed 70 cp raw, so the
  // cap MUST be applied — an uncapped inline would fail this assertion.

  it('T2-M1: createBroadcast receives broadcastNameForResendDashboard ≤70 code points even when fromName+subject exceed 70 cp raw', async () => {
    const audit = makeAudit();
    // Build a broadcast with a long fromName (~53 cp, realistic for TSCC)
    // and a long subject (~60 cp) — their raw concatenation is well over 70.
    const longSubject = 'A'.repeat(60); // 60 cp subject
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: {
        ...makeBroadcast('approved'),
        fromName: 'Thailand-Sweden Chamber of Commerce via Test Chamber',
        subject: longSubject,
      },
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(gw.createCalls).toHaveLength(1);
    const capturedName = gw.createCalls[0]?.broadcastNameForResendDashboard ?? '';
    // The raw uncapped label would be:
    //   "Thailand-Sweden Chamber of Commerce via Test Chamber — " + "A"×60
    // which is 114 cp — well over 70.  The cap MUST bring it to ≤70.
    expect([...capturedName].length).toBeLessThanOrEqual(70);
    // Sanity: the raw uncapped form IS over 70 (otherwise the test proves nothing)
    const rawUncapped = `Thailand-Sweden Chamber of Commerce via Test Chamber — ${longSubject}`;
    expect([...rawUncapped].length).toBeGreaterThan(70);
  });

  it('persists resendAudienceId immediately after createAudience succeeds', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(repo.attachAudienceCalls.length).toBe(1);
    expect(repo.attachAudienceCalls[0]?.audienceId).toBe('aud-fake-1');
  });

  // ---- estimatedRecipientCount written back -----------------------

  it('applyTransition(sending) carries estimatedRecipientCount from resolved audience', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [
            recipient('m-1', 'one@example.com'),
            recipient('m-2', 'two@example.com'),
            recipient('m-3', 'three@example.com'),
          ],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    const sendingTransition = repo.transitions.find(
      (t) => t.status === 'sending',
    );
    expect(
      (sendingTransition?.fields as { estimatedRecipientCount: number })
        ?.estimatedRecipientCount,
    ).toBe(3);
  });

  // ---- Server error catch-all (lock lookup throws) ------------------

  it('repo throw inside lock-lookup withTx โ’ dispatch.server_error', async () => {
    const audit = makeAudit();
    const repo: BroadcastsRepo = {
      ...makeRepo({}).port,
      async withTx() {
        throw new Error('db down');
      },
    };
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({}),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('dispatch.server_error');
      if (result.error.kind === 'dispatch.server_error') {
        expect(result.error.message).toBe('db down');
      }
    }
  });

  // ---- F7.1-IMP5 / R5-T โ€” audience drift on idempotency replay -----

  it('idempotency_conflict on send + audience count mismatch โ’ broadcast_resend_audience_drift audit emitted, broadcast still advances to sending', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    // Gateway returns audience contact count of 1 but recipient list
    // has 2 โ€” mismatch triggers drift audit.
    const gw = makeGateway({
      throwOnSend: { kind: 'permanent', reason: 'idempotency_conflict' },
      // override kind in maybeThrow path: use real shape via plain throw
      // shape with kind:'idempotency_conflict' instead.
      audienceContactCount: 1,
    });
    // Override sendBroadcast to throw idempotency_conflict shape
    const gwPort = {
      ...gw.port,
      async sendBroadcast() {
        throw {
          kind: 'idempotency_conflict',
          reason: 'duplicate idempotency key',
        };
      },
    };
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gwPort,
        membersBridge: makeMembersBridge({
          recipients: [
            recipient('m-1', 'one@example.com'),
            recipient('m-2', 'two@example.com'),
          ],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    // Replay treated as success โ€” broadcast advances to 'sending'
    expect(result.ok).toBe(true);
    // Drift audit emitted with mismatched counts
    const driftEvent = audit.emits.find(
      (e) => e.eventType === 'broadcast_resend_audience_drift',
    );
    expect(driftEvent).toBeDefined();
    expect(driftEvent?.payload['expectedRecipientCount']).toBe(2);
    expect(driftEvent?.payload['actualRecipientCount']).toBe(1);
    expect(driftEvent?.payload['drift']).toBe(1);
  });

  it('R5-S1 โ€” getAudienceContactCount throws non-404 โ’ broadcast_resend_drift_check_unverifiable audit emitted', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    const gwPort = {
      ...gw.port,
      async sendBroadcast() {
        throw {
          kind: 'idempotency_conflict',
          reason: 'duplicate idempotency key',
        };
      },
      async getAudienceContactCount() {
        throw new Error('Resend 503 โ€” service unavailable');
      },
    };
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gwPort,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    // Replay still advances (Resend confirmed delivery on prior tick)
    expect(result.ok).toBe(true);
    // Unverifiable audit emitted (forensic record)
    const unverifiableEvent = audit.emits.find(
      (e) => e.eventType === 'broadcast_resend_drift_check_unverifiable',
    );
    expect(unverifiableEvent).toBeDefined();
    expect(unverifiableEvent?.payload['errorReason']).toContain('503');
  });

  it('TEST-G3 โ€” getAudienceContactCount returns {kind:"audience_missing"} โ’ drift check skipped (no audit, no crash)', async () => {
    // Round 3 review TYPES-2: getAudienceContactCount is a discriminated
    // union {kind:'present',count}|{kind:'audience_missing'}. Lock the
    // positive `audience_missing` outcome path: caller translates to
    // `actualCount = null`, drift-check branch is skipped (no
    // broadcast_resend_audience_drift OR broadcast_resend_drift_check_unverifiable
    // emitted), broadcast still advances to sending.
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    const gwPort = {
      ...gw.port,
      async sendBroadcast() {
        // Simulate idempotency replay so the count-check branch runs.
        throw {
          kind: 'idempotency_conflict',
          reason: 'duplicate idempotency key',
        };
      },
      async getAudienceContactCount() {
        return { kind: 'not_found' as const };
      },
    };
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gwPort,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
    // audience_missing means we cannot verify drift; this matches the
    // "actualCount === null" branch and SHOULD NOT emit either drift
    // audit. (The `unverifiable` audit only fires on a thrown error,
    // not on the discriminated union's missing branch.)
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_resend_audience_drift',
      ),
    ).toBeUndefined();
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_resend_drift_check_unverifiable',
      ),
    ).toBeUndefined();
  });

  // =====================================================================
  // Phase 8 โ€” Slice B (T171 / AS5): expired-plan audit
  // =====================================================================

  it('Phase 8 / T171 โ€” plan unchanged at dispatch โ’ no broadcast_sent_with_expired_member_plan audit', async () => {
    const audit = makeAudit();
    const broadcastRow = makeBroadcast('approved');
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: broadcastRow,
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        // Plan still matches snapshot's planId 'p' โ’ no expired-plan audit
        plansBridge: makePlansBridge({ planId: 'p' }),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_sent_with_expired_member_plan',
      ),
    ).toBeUndefined();
  });

  it('Phase 8 / T171 โ€” plan changed since submit โ’ broadcast_sent_with_expired_member_plan audit fires (dispatch still succeeds)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        // Snapshot is 'p'; current plan is 'p2' โ’ expired-plan audit fires
        plansBridge: makePlansBridge({ planId: 'p2' }),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
    const evt = audit.emits.find(
      (e) => e.eventType === 'broadcast_sent_with_expired_member_plan',
    );
    expect(evt).toBeDefined();
    expect(evt?.payload['planAtSubmit']).toBe('p');
    expect(evt?.payload['planAtDispatch']).toBe('p2');
    expect(evt?.payload['currentlyEntitled']).toBe(true);
  });

  it('Phase 8 / T171 โ€” current plan lookup error โ’ broadcast_sent_with_expired_member_plan audit fires with currentlyEntitled=false', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge({
          lookupError: { kind: 'plan_lookup.member_no_plan', memberId: 'm-1' },
        }),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
    const evt = audit.emits.find(
      (e) => e.eventType === 'broadcast_sent_with_expired_member_plan',
    );
    expect(evt).toBeDefined();
    expect(evt?.payload['currentlyEntitled']).toBe(false);
    expect(evt?.payload['planLookupError']).toBe('plan_lookup.member_no_plan');
  });

  it('Phase 8 / T171 โ€” plansBridge throws โ’ no audit, dispatch still succeeds (best-effort guard)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge({ shouldThrow: true }),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_sent_with_expired_member_plan',
      ),
    ).toBeUndefined();
  });

  // =====================================================================
  // Phase 8 โ€” Slice D (FR-021 / AS2): 1-hour retry budget
  // =====================================================================

  it('Phase 8 / Slice D โ€” retryable within budget (now < scheduled_for + 1h) โ’ row stays approved (gateway_retryable error returned)', async () => {
    const audit = makeAudit();
    // scheduled_for = FROZEN_NOW exactly, so elapsed = 0ms < 1h budget
    const broadcastRow = makeBroadcast('approved');
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: broadcastRow,
    });
    const gw = makeGateway({
      throwOnSend: { kind: 'retryable', reason: 'Resend 503 โ€” service unavailable' },
    });
    const email = makeEmailTransactional();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: email.port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('gateway_retryable');
    }
    // No transition to failed_to_dispatch (within budget)
    expect(repo.transitions.find((t) => t.status === 'failed_to_dispatch')).toBeUndefined();
    // No dispatch-failure email enqueued
    expect(email.memberCalls).toHaveLength(0);
    // No retry_budget_exhausted audit either
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_failed_to_dispatch'),
    ).toBeUndefined();
  });

  it('Phase 8 / Slice D โ€” retryable past budget (scheduled_for + 65min) โ’ terminal failed_to_dispatch + member email enqueued', async () => {
    const audit = makeAudit();
    // Set scheduled_for 65 min BEFORE FROZEN_NOW so elapsed > 1h budget
    const broadcastRow = {
      ...makeBroadcast('approved'),
      scheduledFor: new Date(FROZEN_NOW.getTime() - 65 * 60 * 1000),
    };
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: broadcastRow,
    });
    const gw = makeGateway({
      throwOnSend: { kind: 'retryable', reason: 'Resend 503 โ€” service unavailable' },
    });
    const email = makeEmailTransactional();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: email.port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_failed_to_dispatch');
      if (result.error.kind === 'broadcast_failed_to_dispatch') {
        expect(result.error.reason).toContain('retry_budget_exhausted_after_1h');
      }
    }
    // Transition to failed_to_dispatch DID happen
    expect(repo.transitions.find((t) => t.status === 'failed_to_dispatch')).toBeDefined();
    // Audit broadcast_failed_to_dispatch with budget reason
    const auditEvt = audit.emits.find(
      (e) => e.eventType === 'broadcast_failed_to_dispatch',
    );
    expect(auditEvt).toBeDefined();
    expect((auditEvt?.payload as Record<string, unknown>).reason).toContain(
      'retry_budget_exhausted_after_1h',
    );
    // Slice E โ€” dispatch-failure email enqueued
    expect(email.memberCalls).toHaveLength(1);
    expect(email.memberCalls[0]?.templateKey).toBe('broadcast_failed_to_dispatch');
    expect(email.memberCalls[0]?.to).toBe('sender@example.com');
    expect(email.memberCalls[0]?.payload['broadcastId']).toBe(broadcastId);
  });

  // =====================================================================
  // Phase 8 โ€” Slice E (FR-021 / AS2): dispatch-failure transactional email
  // =====================================================================

  it('Phase 8 / Slice E โ€” permanent failure path enqueues dispatch-failure email to member primary contact', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnSend: { kind: 'permanent', reason: 'Resend 422 โ€” invalid template' },
    });
    const email = makeEmailTransactional();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: email.port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    expect(email.memberCalls).toHaveLength(1);
    expect(email.memberCalls[0]?.templateKey).toBe('broadcast_failed_to_dispatch');
    expect(email.memberCalls[0]?.payload['tenantDisplayName']).toBe('Test Chamber');
    expect(email.memberCalls[0]?.payload['reason']).toContain('Resend 422');
  });

  it('Phase 8 / Slice E โ€” member has no primary contact email โ’ email skipped (logger warn), audit + transition still happen', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnSend: { kind: 'permanent', reason: 'Resend 422 โ€” invalid template' },
    });
    const email = makeEmailTransactional();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        // primaryContact: null โ’ membersBridge.getMemberPrimaryContact returns null
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: null,
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: email.port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    // Audit + transition still happened
    expect(repo.transitions.find((t) => t.status === 'failed_to_dispatch')).toBeDefined();
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_failed_to_dispatch'),
    ).toBeDefined();
    // BUT email NOT enqueued
    expect(email.memberCalls).toHaveLength(0);
  });

  it('Phase 8 / Slice E โ€” emailTransactional.sendMemberEmail throws โ’ audit + transition still complete (best-effort guard)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnSend: { kind: 'permanent', reason: 'Resend 422 โ€” invalid template' },
    });
    const email = makeEmailTransactional({ shouldThrow: true });
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: email.port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    // Audit + transition still happened (best-effort enqueue does NOT block)
    expect(repo.transitions.find((t) => t.status === 'failed_to_dispatch')).toBeDefined();
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_failed_to_dispatch'),
    ).toBeDefined();
  });

  it('Phase 8 / Slice E โ€” resource_missing (404) does NOT enqueue dispatch-failure email (different audit type)', async () => {
    // resource_missing is an ops-side issue (admin manually deleted Resend
    // resource); member notification is reserved for terminal-fail kinds
    // that map to broadcast_failed_to_dispatch audit. resource_missing
    // fires broadcast_resend_resource_missing audit instead.
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnSend: {
        kind: 'resource_missing',
        reason: 'Resend 404 โ€” broadcast not found',
        resourceType: 'broadcast',
        resourceId: 'bcast-fake-1',
      },
    });
    const email = makeEmailTransactional();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: email.port,
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    // resource_missing audit fires
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_resend_resource_missing',
      ),
    ).toBeDefined();
    // BUT no dispatch-failure email (different audit kind)
    expect(email.memberCalls).toHaveLength(0);
  });

  // =====================================================================
  // Verify-fix R3 โ€” Tests-Gap#2 (AS2 admin alert) + Errors-H3
  // (skipped-no-email audit) + Errors-C1 (idempotency_conflict_pre_send
  // distinct audit)
  // =====================================================================

  it('R3 Tests-Gap#2: AS2 past-budget emits broadcasts.dispatch_budget_exhausted metric (admin alert pipeline)', async () => {
    const audit = makeAudit();
    const broadcastRow = {
      ...makeBroadcast('approved'),
      scheduledFor: new Date(FROZEN_NOW.getTime() - 65 * 60 * 1000),
    };
    const repo = makeRepo({ lockedStatus: 'approved', broadcast: broadcastRow });
    const gw = makeGateway({
      throwOnSend: { kind: 'retryable', reason: 'Resend 503' },
    });
    const email = makeEmailTransactional();
    // Spy on the metric โ€” vi.spyOn safe because broadcastsMetrics is
    // a module-level singleton const.
    const { broadcastsMetrics } = await import('@/lib/metrics');
    const spy = vi.spyOn(broadcastsMetrics, 'dispatchBudgetExhausted');
    try {
      await dispatchScheduledBroadcast(
        {
          tenant,
          broadcastsRepo: repo.port,
          broadcastsGateway: gw.port,
          membersBridge: makeMembersBridge({
            recipients: [recipient('m-1', 'one@example.com')],
            primaryContact: 'sender@example.com',
          }),
          marketingUnsubscribes: makeMarketingUnsubscribes(),
          eventAttendees: makeEventAttendees(),
          audit: audit.port,
          clock,
          fromEmail: 'noreply@test.invalid-but-test-only',
          tenantDisplayName: 'Test Chamber',
          locale: 'en' as const,
          plansBridge: makePlansBridge(),
          emailTransactional: email.port,
        },
        baseInput,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(tenant.slug, expect.any(String));
    } finally {
      spy.mockRestore();
    }
  });

  it('R3 Errors-H3: skipped notification (member null primary email) emits broadcast_dispatch_failure_notif_skipped_no_email audit', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnSend: { kind: 'permanent', reason: 'Resend 422 โ€” invalid template' },
    });
    const email = makeEmailTransactional();
    await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        // primaryContact: null โ’ email skipped, audit MUST fire
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: null,
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: email.port,
      },
      baseInput,
    );
    // Email NOT enqueued
    expect(email.memberCalls).toHaveLength(0);
    // BUT durable audit row IS emitted (compliance trail)
    const skippedEvt = audit.emits.find(
      (e) =>
        e.eventType ===
        'broadcast_dispatch_failure_notif_skipped_no_email',
    );
    expect(skippedEvt).toBeDefined();
    expect((skippedEvt?.payload as Record<string, unknown>).memberId).toBe('m-1');
  });

  // R7 staff-review HIGH-3 fix — Errors-C1 distinct audit event was
  // declared in F7_AUDIT_EVENT_TYPES + production emit path at
  // dispatch-scheduled-broadcast.ts:703 but had no test pinning the
  // emission. The audit-event-type-emission grep test only checks
  // declarations, not emission paths in mock chains. A regression
  // that drops the `try/audit.emit` block at line 700–713 would
  // ship green.
  it('R3 Errors-C1: idempotency_conflict on createAudience (pre-send) → emits broadcast_dispatch_idempotency_conflict_pre_send audit', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    // Concurrent worker raced through createAudience first. Resend
    // returns 409 idempotency-key reuse — our wrapper surfaces this
    // as `kind: 'idempotency_conflict'` BEFORE we can call
    // sendBroadcast, so the use-case enters the `resendBroadcastId === ''`
    // branch and emits the distinct pre-send audit event.
    const gw = makeGateway({
      throwOnCreateAudience: {
        kind: 'idempotency_conflict',
        reason: 'idempotency_key_already_used',
      },
    });
    await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-1', 'one@example.com')],
          primaryContact: 'sender@example.com',
        }),
        marketingUnsubscribes: makeMarketingUnsubscribes(),
        eventAttendees: makeEventAttendees(),
        audit: audit.port,
        clock,
        fromEmail: 'noreply@test.invalid-but-test-only',
        tenantDisplayName: 'Test Chamber',
        locale: 'en' as const,
        plansBridge: makePlansBridge(),
        emailTransactional: makeEmailTransactional().port,
      },
      baseInput,
    );
    // Distinct pre-send audit MUST emit so on-call sees the
    // "two workers raced" forensic signal separate from a generic
    // permanent-error trail.
    const preSendAudit = audit.emits.find(
      (e) =>
        e.eventType === 'broadcast_dispatch_idempotency_conflict_pre_send',
    );
    expect(preSendAudit).toBeDefined();
    expect((preSendAudit?.payload as Record<string, unknown>).reason).toBe(
      'idempotency_key_already_used',
    );
    // The permanent-failure handler runs after the pre-send emit so
    // BOTH events together tell the full story — the test pins both
    // audit kinds to lock the documented "two events together"
    // contract from the production code's comment at line 698–699.
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_failed_to_dispatch'),
    ).toBeDefined();
  });
});
