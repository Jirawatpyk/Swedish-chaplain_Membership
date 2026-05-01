/**
 * Unit tests for `dispatch-scheduled-broadcast.ts` cron worker.
 *
 * Wave 6 GREEN — covers the deferred-cron pattern (Ultraplan AD1):
 *   - lockForUpdate('approved') + recipient re-resolve
 *   - Resend Broadcasts API surface (createAudience + addContactsToAudience
 *     + createBroadcast + sendBroadcast with stable idempotency key)
 *   - attachResendIds + applyTransition('sending') + audit
 *   - Retryable failures (gateway throws {kind:'retryable'}) → row stays
 *     'approved' (no transition, no audit)
 *   - Permanent failures → applyTransition('failed_to_dispatch') + audit
 *   - Audience-empty-post-suppression branch
 *   - DB write failure AFTER Resend success → kind='gateway_retryable'
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dispatchScheduledBroadcast } from '@/modules/broadcasts/application/use-cases/dispatch-scheduled-broadcast';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { ok } from '@/lib/result';
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
    };

interface GatewayOpts {
  readonly throwOnCreateAudience?: ThrowSpec;
  readonly throwOnCreateBroadcast?: ThrowSpec;
  readonly throwOnSend?: ThrowSpec;
  readonly errorAsPlainError?: boolean;
  /** Round-5 R5-T — let tests synthesise audience-count drift on idempotency replay. */
  readonly audienceContactCount?: number | null;
  readonly throwOnGetAudienceContactCount?: ThrowSpec;
}

function makeGateway(opts: GatewayOpts = {}): {
  port: BroadcastsGatewayPort;
  audienceCalls: Array<string>;
  contactsCalls: Array<{ audienceId: string; contacts: ReadonlyArray<AudienceContact> }>;
  createCalls: Array<{ audienceId: string; subject: string }>;
  sendCalls: Array<{ broadcastId: string; idempotencyKey: string }>;
} {
  const audienceCalls: Array<string> = [];
  const contactsCalls: Array<{
    audienceId: string;
    contacts: ReadonlyArray<AudienceContact>;
  }> = [];
  const createCalls: Array<{ audienceId: string; subject: string }> = [];
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
        createCalls.push({ audienceId: input.audienceId, subject: input.subject });
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

describe('dispatch-scheduled-broadcast — Wave 6 GREEN', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  it('happy: lock+resolve+createAudience+addContacts+createBroadcast+sendBroadcast → applyTransition(sending) + audit broadcast_send_started', async () => {
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
      },
      baseInput,
    );
    expect(gw.sendCalls[0]?.idempotencyKey).toBe(
      `broadcast-test-tenant-${broadcastId as string}`,
    );
  });

  it('skips when locked status != approved → broadcast_invalid_state_transition', async () => {
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
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_invalid_state_transition');
    }
    expect(gw.audienceCalls).toHaveLength(0);
  });

  it('skips when broadcast not found (lockForUpdate=null) → broadcast_invalid_state_transition', async () => {
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
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_invalid_state_transition');
    }
  });

  // ---- Audience-empty-post-suppression --------------------------------

  it('audience evaporates after suppression filter → applyTransition(failed_to_dispatch) + audit', async () => {
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

  // ---- Gateway retryable failures -----------------------------------

  it('gateway retryable on createAudience → kind=gateway_retryable, no transition, no audit', async () => {
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

  it('gateway retryable on sendBroadcast → kind=gateway_retryable', async () => {
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
      },
      baseInput,
    );
    if (!result.ok && result.error.kind === 'gateway_retryable') {
      expect(result.error.reason).toBe('temporary_503');
    }
  });

  // ---- Gateway permanent failures -----------------------------------

  it('gateway permanent error (plain Error) on createBroadcast → applyTransition(failed_to_dispatch) + audit', async () => {
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

  // ---- Resource missing (404 from Resend) — F7.1-T2 -----------------

  it('gateway resource_missing on createBroadcast → emits broadcast_resend_resource_missing audit + transitions to failed_to_dispatch', async () => {
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

  it('applyTransition(sending) throws AFTER Resend already succeeded → kind=gateway_retryable (next tick re-dispatches with same idempotency key)', async () => {
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
      },
      baseInput,
    );
    const sentEmails = gw.contactsCalls[0]?.contacts.map((c) => c.emailLower);
    expect(sentEmails).not.toContain('sender@example.com');
    expect(sentEmails).toContain('two@example.com');
  });

  // ---- Audience name stability (orphan-prevention polish 2026-05-01) -

  it('audience name is deterministic per (tenantId, broadcastId) — no timestamp suffix so retries reuse', async () => {
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
      },
      baseInput,
    );
    expect(gw.audienceCalls[0]).toContain(broadcastId as string);
    expect(gw.audienceCalls[0]).toContain('test-tenant');
    // No timestamp in name — stability lets retries reuse the same audience
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

  it('repo throw inside lock-lookup withTx → dispatch.server_error', async () => {
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

  // ---- F7.1-IMP5 / R5-T — audience drift on idempotency replay -----

  it('idempotency_conflict on send + audience count mismatch → broadcast_resend_audience_drift audit emitted, broadcast still advances to sending', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    // Gateway returns audience contact count of 1 but recipient list
    // has 2 — mismatch triggers drift audit.
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
      },
      baseInput,
    );
    // Replay treated as success — broadcast advances to 'sending'
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

  it('R5-S1 — getAudienceContactCount throws non-404 → broadcast_resend_drift_check_unverifiable audit emitted', async () => {
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
        throw new Error('Resend 503 — service unavailable');
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

  it('TEST-G3 — getAudienceContactCount returns {kind:"audience_missing"} → drift check skipped (no audit, no crash)', async () => {
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
});
