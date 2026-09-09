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
import { MEMBER_FACING_FAILURE_REASONS } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import {
  BroadcastConcurrentMutationError,
  BroadcastNotFoundError,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { logger } from '@/lib/logger';
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
    createdAt: FROZEN_NOW,
    updatedAt: FROZEN_NOW,
  };
}

interface RepoOpts {
  readonly lockedStatus?: BroadcastStatus | null;
  readonly broadcast?: Broadcast | null;
  readonly applyTransitionThrowsOnFinal?: boolean;
  /**
   * Round 4 L2 — make the audience-attach compare-and-set LOSE, with the status
   * the probe would have observed. Nothing could drive this before: the arm that
   * handles it had no test, and `grep -rl audience_attach_lost tests/` found
   * nothing, so the reclaim it performs would have shipped unexercised.
   */
  readonly attachAudienceIdLosesCasWithStatus?: BroadcastStatus;
  /**
   * Round 4 F2 / L6 — the erasure cascade removed the row between the claim
   * query and the post-send write. `attachResendIds` threw a BARE Error until
   * this round, so the `BroadcastNotFoundError` arm that handles it was
   * unreachable; this option is what makes the claim "that arm now runs"
   * checkable instead of asserted.
   */
  readonly attachResendIdsRowVanished?: boolean;
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
  // Phase 9b (T147) — the hand-off channel between the two `*/5` crons.
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
        if (opts.attachResendIdsRowVanished === true) {
          // What `throwConcurrentMutation`'s probe produces when the row is gone.
          throw new BroadcastNotFoundError(
            'test-tenant' as unknown as ConstructorParameters<
              typeof BroadcastNotFoundError
            >[0],
            _b,
          );
        }
      },
      async attachAudienceId(_tx, _t, _b, audienceId) {
        attachAudienceCalls.push({ audienceId });
        if (opts.attachAudienceIdLosesCasWithStatus !== undefined) {
          // Exactly what the repo does on a 0-row CAS: probe, then throw with
          // the status actually read. Not a bare Error — that distinction is
          // the whole point of the arm under test.
          throw new BroadcastConcurrentMutationError(
            'test-tenant' as unknown as ConstructorParameters<
              typeof BroadcastConcurrentMutationError
            >[0],
            _b,
            opts.attachAudienceIdLosesCasWithStatus,
          );
        }
      },
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
  /**
   * Round 4 (whole-branch review #2) — Resend's `has_more`, inverted. `false`
   * means the adapter read only PART of the audience, so the count is a lower
   * bound and a shortfall proves nothing about drift.
   */
  readonly audienceCountComplete?: boolean;
  readonly throwOnGetAudienceContactCount?: ThrowSpec;
  /** Round 4 L2 — the reclaim itself fails, which is the leak an operator must see. */
  readonly throwOnDeleteAudience?: boolean;
}

function makeGateway(opts: GatewayOpts = {}): {
  port: BroadcastsGatewayPort;
  audienceCalls: Array<string>;
  contactsCalls: Array<{ audienceId: string; contacts: ReadonlyArray<AudienceContact> }>;
  createCalls: Array<{ audienceId: string; subject: string; broadcastNameForResendDashboard: string }>;
  sendCalls: Array<{ broadcastId: string; idempotencyKey: string }>;
  /** Round 4 L2 — proves the CAS loser actually reclaims the audience it minted. */
  deleteAudienceCalls: Array<string>;
} {
  const deleteAudienceCalls: Array<string> = [];
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
    deleteAudienceCalls,
    port: {
      async createAudience(name) {
        audienceCalls.push(name);
        maybeThrow(opts.throwOnCreateAudience);
        return { audienceId: 'aud-fake-1' };
      },
      async addContactsToAudience(audienceId, contacts) {
        contactsCalls.push({ audienceId, contacts });
      },
      // T086 — unused by this fixture; present so the stub still satisfies
      // BroadcastsGatewayPort.
      async createContactImport() {
        throw new Error('not used');
      },
      async getContactImport() {
        throw new Error('not used');
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
          // Round 4 F1 residual — `complete` is Resend's `has_more`, inverted.
          complete: opts.audienceCountComplete ?? true,
        };
      },
      async removeContactFromAudience() {
      return { kind: 'detached' as const };},
      async deleteContactGlobally() {},
      async deleteAudience(audienceId: string) {
        deleteAudienceCalls.push(audienceId);
        if (opts.throwOnDeleteAudience === true) {
          throw new Error('Resend 500 on DELETE /audiences');
        }
      },
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
  preferredLocale?: 'en' | 'th' | 'sv' | null;
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
    async filterMarketingOptedOut() { return new Set(); },
    async getContactsBySegment() { return []; },
    async countOptedOutContactsBySegment() { return 0; },
    async getMemberPreferredLocale() { return opts.preferredLocale ?? null; },
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [
            recipient('m-r1', 'one@example.com'),
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
      recipient(`m-big-${i}`, `u${i}@example.com`),
    );
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
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

  // Review 2026-09-07 round 2 (C2 — five reviewers) — a `tier` row whose
  // `segment_params` lost its codes is a PERMANENT data defect, not a Neon
  // blip. It used to reach the resolver as `{ tier, [] }`: on the flag-OFF
  // leg the predicate dropped and every active member was addressed; on the
  // flag-ON leg the repo threw and the throw was reclassified as a transient
  // `resolve.server_error`, retried every tick forever with no budget. Now it
  // is refused at the boundary: terminal `failed_to_dispatch`, an honest
  // audit reason, and the resolver is never asked.
  it('a tier row with no codes is a TERMINAL failed_to_dispatch (malformed_segment) — the resolver is never called', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: {
        ...makeBroadcast('approved'),
        segmentType: 'tier',
        segmentParams: null,
      },
    });
    const gw = makeGateway();
    const bridge = makeMembersBridge({
      recipients: [recipient('m-2', 'b@example.com')],
      primaryContact: 'sender@example.com',
    });
    const segmentRead = vi.spyOn(bridge, 'getMembersBySegment');
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: bridge,
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
      expect(result.error.kind).toBe('broadcast_failed_to_dispatch');
      if (result.error.kind === 'broadcast_failed_to_dispatch') {
        expect(result.error.reason).toBe('malformed_segment');
      }
    }
    // Never "everyone", never a retry: no segment read, no Resend call.
    expect(segmentRead).not.toHaveBeenCalled();
    expect(gw.audienceCalls).toHaveLength(0);
    expect(repo.transitions.map((t) => t.status)).toContain('failed_to_dispatch');
    const failAudit = audit.emits.find(
      (e) => e.eventType === 'broadcast_failed_to_dispatch',
    );
    expect(failAudit).toBeDefined();
    expect(failAudit?.payload).toMatchObject({
      reason: 'malformed_segment',
      detail: 'tier_without_codes',
    });
  });

  // ---- Bridge throw on the member-leg read (W2-05; re-targeted by 108 PR-C —
  //      the requesting-member primary read that used to sit here is gone) ------

  it('the member-leg read (getMembersBySegment) throws โ’ dispatch.server_error, no transition, no audit (retried next tick)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway();
    // W2-05: a Neon/RLS/timeout throw from the requesting-member primary
    // (now: the member-leg read, since 108 PR-C removed the primary read) must be caught and mapped to the typed
    // dispatch.server_error โ€” NOT escape the use-case. The broadcast must
    // stay 'approved' (no transition, no audit) so the next cron tick
    // retries it cleanly. Mock-only happy-path tests missed this throw path.
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: {
          ...makeMembersBridge({
            recipients: [recipient('m-r1', 'one@example.com')],
            primaryContact: 'sender@example.com',
          }),
          async getMembersBySegment() {
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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

  it('the requesting member is excluded from audience contacts — by member id since 108 PR-C (FR-022)', async () => {
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [
            // The requesting member (`makeBroadcast` → requestedByMemberId 'm-1')
            // listed as a recipient: excluded because it is the SAME MEMBER,
            // whatever address the row carries.
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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

  // ---- Round 4 L2 — the lost audience-attach CAS ------------------------
  //
  // Two overlapping ticks are reachable because `maxDuration` equals the cron
  // cadence. The loser's freshly minted audience is referenced by nothing:
  // `reclaim-orphaned-audiences` filters on the broadcast ROW being gone (it is
  // not) and `cleanup-orphaned-audiences` deletes only the id the row points at
  // (the winner's). On the Resend Free plan three audiences is the cap.
  //
  // Neither case below could be written before this round: the arm did not
  // exist, `grep -rl audience_attach_lost tests/` found nothing, and
  // `attachAudienceId` had no way to lose in the harness.

  it('Round 4 L2 — a lost audience-attach CAS reclaims the audience it minted and reports the status it OBSERVED', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
      attachAudienceIdLosesCasWithStatus: 'sending',
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
    if (result.ok) return;
    expect(result.error.kind).toBe('broadcast_invalid_state_transition');
    // The status the probe actually read. The live leg used to discard it and
    // pass the literal 'sending_or_later' — a guessed value in a field an
    // operator reads.
    expect(
      (result.error as { readonly observedStatus: string }).observedStatus,
    ).toBe('sending');

    // The reclaim: exactly the audience this tick created.
    expect(gw.audienceCalls.length).toBe(1);
    expect(gw.deleteAudienceCalls).toEqual(['aud-fake-1']);

    // And nothing terminal happened to the broadcast — the WINNER is sending
    // it. Before this arm existed the throw reached `classifyThrown`, which
    // reads a `kind` field the error class does not have, so it was treated as
    // a permanent gateway failure and tried to mark the row failed_to_dispatch
    // mid-send.
    expect(repo.transitions).toHaveLength(0);
    expect(audit.emits).toHaveLength(0);
  });

  it('Round 4 L2 — when the reclaim ITSELF fails the audience is genuinely leaked, and the tick still returns the benign race', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
      attachAudienceIdLosesCasWithStatus: 'sent',
    });
    const gw = makeGateway({ throwOnDeleteAudience: true });
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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

    // Best-effort: a failed reclaim must not change what the tick reports, or a
    // Resend blip would turn a benign race into a paging error.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('broadcast_invalid_state_transition');
    expect(
      (result.error as { readonly observedStatus: string }).observedStatus,
    ).toBe('sent');
    // It was attempted — that is what separates "leaked" from "never tried".
    expect(gw.deleteAudienceCalls).toEqual(['aud-fake-1']);
    expect(repo.transitions).toHaveLength(0);
  });

  it('Round 4 F2/L6 — the row vanishing under the POST-SEND write is broadcast_not_found, not a critical DB failure', async () => {
    // R2-1 added this arm citing `attachAudienceId`, which throws in a DIFFERENT
    // try block. Nothing inside the post-send try could produce it, because
    // `attachResendIds` threw a bare `Error` and landed in
    // `db_write_after_resend_success` — severity critical, `gateway_retryable`,
    // i.e. "retry a broadcast Resend has already sent". Routing it through
    // `throwConcurrentMutation` is what makes the arm reachable; this case is
    // the proof, and it fails if `attachResendIds` goes back to a bare Error.
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
      attachResendIdsRowVanished: true,
    });
    const gw = makeGateway();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
    if (result.ok) return;
    // Not `gateway_retryable`: there is no row left to retry, and the send
    // already happened.
    expect(result.error.kind).toBe('broadcast_not_found');
    // The send DID go out before the row disappeared — that is the whole reason
    // this must not be reported as a retryable gateway fault.
    expect(gw.sendCalls.length).toBe(1);
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [
            recipient('m-r1', 'one@example.com'),
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gwPort,
        membersBridge: makeMembersBridge({
          recipients: [
            recipient('m-r1', 'one@example.com'),
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

  /**
   * Round 4, whole-branch review #2 — the same fixture with `has_more` set.
   *
   * `2d61a0605` taught `getAudienceContactCount` to report whether it read the
   * WHOLE audience, and wired the flag into `build-audience-tick.ts` only. That
   * is class 3 — a fix landing on one leg — inside a commit written to fix class
   * 3, which is why this case exists on the leg that runs in production.
   *
   * A truncated page can only UNDERCOUNT, so a shortfall proves nothing. Filing
   * it as drift writes a FALSE `broadcast_resend_audience_drift` row into an
   * append-only table and pages on `observability.md` § 22.3. The excess
   * direction is unaffected and still refuses — truncation cannot fake it.
   */
  it('Round 4 #2 — a TRUNCATED count on the replay arm is unverifiable, not drift', async () => {
    // Same dynamic-import spy pattern the budget case below uses — the metrics
    // singleton is not imported at module top in this file.
    const { broadcastsMetrics } = await import('@/lib/metrics');
    const unverifiableSpy = vi.spyOn(broadcastsMetrics, 'driftCheckUnverifiable');
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnSend: { kind: 'permanent', reason: 'idempotency_conflict' },
      // One page of a larger audience: fewer than the 2 we resolved, and Resend
      // said there is more it did not return.
      audienceContactCount: 1,
      audienceCountComplete: false,
    });
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gwPort,
        membersBridge: makeMembersBridge({
          recipients: [
            recipient('m-r1', 'one@example.com'),
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

    // The replay still advances — this is about the RECORD, not the send.
    expect(result.ok).toBe(true);
    // No drift row: the comparison was not possible, so it is not asserted.
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_resend_audience_drift'),
    ).toBeUndefined();
    // Recorded as what it actually is — via the METRIC that feeds the § 22.3
    // alert, not an append-only audit row. A partial read is not a failure and
    // does not deserve a 5-to-10-year record; what it must not do is look like a
    // completed check.
    expect(unverifiableSpy).toHaveBeenCalledTimes(1);
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gwPort,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
    // Round 4 (security finding 6) — this asserted the payload CONTAINS '503',
    // pinning the provider's raw message inside an append-only row with 5–10
    // year retention as the contract. Nothing was filtering it: `REDACT_PATHS`
    // is a pino formatter and never touches a DB write, and the row is emitted
    // with `emit(null, …)` through the BYPASSRLS global `db`, so it lands.
    //
    // `countErr` is whatever `getAudienceContactCount` threw — a `NeonDbError`
    // carrying the failed SQL with its bound parameters (member addresses here)
    // or Resend's own text. The CLASS answers the only question the audit row
    // exists for — was the drift check unverifiable because of our database or
    // theirs — and carries nothing that cannot be edited away later.
    expect(unverifiableEvent?.payload['errorReason']).toBe('Error');
    expect(JSON.stringify(unverifiableEvent?.payload)).not.toContain('503');
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gwPort,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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

  it('dispatch-failure email renders in the member preferred locale, not the tenant default (email-locale audit 2026-07-16)', async () => {
    const audit = makeAudit();
    const repo = makeRepo({
      lockedStatus: 'approved',
      broadcast: makeBroadcast('approved'),
    });
    const gw = makeGateway({
      throwOnSend: { kind: 'permanent', reason: 'Resend 422 — invalid template' },
    });
    const email = makeEmailTransactional();
    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
          primaryContact: 'sender@example.com',
          // Member explicitly prefers Thai; the tenant default below is 'en'.
          preferredLocale: 'th',
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
    expect(email.memberCalls[0]?.locale).toBe('th');
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
    // Round 4 L1 — this asserted `toContain('Resend 422')`, i.e. that the RAW
    // gateway message was forwarded as the notification's `reason`. It was, and
    // that was the defect: `reason` is a LOOKUP KEY in the email builder, so a
    // raw message matched nothing and the member read the generic "a technical
    // problem prevented delivery" for a refused request. The test pinned the bug
    // as the contract.
    //
    // The raw message is not lost — it still goes to `broadcasts.failure_reason`
    // and the audit payload, which is where an operator looks. What the member
    // gets is a token that renders a sentence.
    expect(email.memberCalls[0]?.payload['reason']).toBe('gateway_permanent');
    // The load-bearing half: whatever this call site passes must be renderable.
    // A literal check alone would still pass if someone swapped in another
    // plausible string.
    expect(MEMBER_FACING_FAILURE_REASONS as readonly string[]).toContain(
      email.memberCalls[0]?.payload['reason'],
    );
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        // primaryContact: null โ’ membersBridge.getMemberPrimaryContact returns null
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
          audienceMode: 'primary_only' as const,
          audienceCeiling: 5000,
          broadcastsGateway: gw.port,
          membersBridge: makeMembersBridge({
            recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        // primaryContact: null โ’ email skipped, audit MUST fire
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [recipient('m-r1', 'one@example.com')],
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

// Round-2 code review, finding 10 (third behaviour): the per-broadcast
// `droppedByPreference` log line. Its sibling `orphans` is audited per member;
// this is the cheaper equivalent while the sender-facing surface waits for
// PR-C — one line, with the broadcast id, counts only, never an address.
describe('dispatch-scheduled-broadcast — per-broadcast opt-out drop log (round-2 finding 10)', () => {
  it('a non-zero droppedByPreference is logged against the broadcast id, addresses excluded', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'approved', broadcast: makeBroadcast('approved') });
    const gw = makeGateway();
    const bridge = makeMembersBridge({
      recipients: [recipient('m-r1', 'one@example.com'), recipient('m-2', 'two@example.com')],
      primaryContact: 'sender@example.com',
    });
    // One of the two recipients carries a marketing opt-out.
    bridge.filterMarketingOptedOut = async () => new Set(['two@example.com'] as never);

    const result = await dispatchScheduledBroadcast(
      {
        tenant,
        broadcastsRepo: repo.port,
        audienceMode: 'primary_only' as const,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: bridge,
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

    const call = info.mock.calls.find((c) => c[1] === 'broadcasts.dispatch.marketing_opt_out_dropped');
    expect(call).toBeDefined();
    const fields = call![0] as Record<string, unknown>;
    expect(fields.droppedByPreference).toBe(1);
    expect(fields.recipientCount).toBe(1);
    expect(fields.broadcastId).toBe(baseInput.broadcastId);
    // FR-053a — never an address in a log line.
    expect(JSON.stringify(fields)).not.toContain('@');
    info.mockRestore();
  });
});


/**
 * 108 PR-C T076 — the dispatch path hands the resolver the requesting MEMBER
 * id (self-exclusion by member, FR-022), threads `audienceMode` from deps,
 * and maps the resolver's typed `resolve.server_error` to
 * `dispatch.server_error` with NO transition and NO audit, so the broadcast
 * stays `approved` for the next tick — never `failed_to_dispatch` with a
 * fabricated "empty audience" reason.
 */
describe('dispatch-scheduled-broadcast — 108 PR-C resolver contract (T076)', () => {
  function depsWith(
    bridge: MembersBridgePort,
    audienceMode: 'primary_only' | 'all_contacts',
  ) {
    const audit = makeAudit();
    const repo = makeRepo({ lockedStatus: 'approved', broadcast: makeBroadcast('approved') });
    const gw = makeGateway();
    return {
      audit,
      repo,
      gw,
      deps: {
        tenant,
        broadcastsRepo: repo.port,
        audienceMode,
        audienceCeiling: 5000,
        broadcastsGateway: gw.port,
        membersBridge: bridge,
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
    };
  }

  it('a failed member read (resolve.server_error) → dispatch.server_error, no transition, no audit, no audience', async () => {
    const { audit, repo, gw, deps } = depsWith(
      {
        ...makeMembersBridge({ recipients: [recipient('m-r1', 'one@example.com')], primaryContact: 'sender@example.com' }),
        async getMembersBySegment() {
          throw new Error('members-bridge.getMembersBySegment: repo.unexpected');
        },
      },
      'primary_only',
    );
    const result = await dispatchScheduledBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('dispatch.server_error');
    expect(gw.audienceCalls).toHaveLength(0);
    expect(repo.transitions).toHaveLength(0);
    expect(audit.emits).toHaveLength(0);
  });

  it('self-exclusion is by member id: the requesting member (m-1) is dropped even under a different address', async () => {
    const { gw, deps } = depsWith(
      makeMembersBridge({
        recipients: [recipient('m-1', 'not-the-sender-address@example.com'), recipient('m-2', 'two@example.com')],
        primaryContact: 'sender@example.com',
      }),
      'primary_only',
    );
    const result = await dispatchScheduledBroadcast(deps, baseInput);
    expect(result.ok).toBe(true);
    const pushed = JSON.stringify(gw.contactsCalls);
    expect(pushed).toContain('two@example.com');
    expect(pushed).not.toContain('not-the-sender-address@example.com');
  });

  it("audienceMode 'all_contacts' dispatches the contact-leg rows, not the primary-only rows", async () => {
    const kinds: string[] = [];
    const { gw, deps } = depsWith(
      {
        ...makeMembersBridge({ recipients: [recipient('m-9', 'nine@example.com')], primaryContact: 'sender@example.com' }),
        async getContactsBySegment(_ctx, kind) {
          kinds.push(kind);
          return [
            { memberId: 'm-2', contactId: 'c-2p', emailLower: unsafeBrandEmailLower('two@example.com'), hasOptedOutContact: false },
            { memberId: 'm-2', contactId: 'c-2s', emailLower: unsafeBrandEmailLower('two-secondary@example.com'), hasOptedOutContact: false },
          ];
        },
      },
      'all_contacts',
    );
    const result = await dispatchScheduledBroadcast(deps, baseInput);
    expect(result.ok).toBe(true);
    expect(kinds).toEqual(['all_members']);
    const pushed = JSON.stringify(gw.contactsCalls);
    expect(pushed).toContain('two@example.com');
    expect(pushed).toContain('two-secondary@example.com');
    expect(pushed).not.toContain('nine@example.com');
  });

  /**
   * 108 Phase 9 review S21 — there is no hand-off any more, and this replaces
   * the two cases that pinned one.
   *
   * `DEFERRED_TO_BATCH_PATH` wrote the resolved count back as the estimate and
   * left the row `approved` for `split-large-broadcasts` to claim. `ca51f59a1`
   * deleted that cron, so the hand-off had nowhere to go: the kind had no case
   * in the dispatch cron's switch, fell through to `default` -> `unknown_error`,
   * and left the row approved with no claimant — a broadcast that could never
   * be delivered and never be failed.
   *
   * What bounds this leg now is the ACCEPT ceiling, which the composition root
   * clamps to `DELIVERABLE_RECIPIENTS_PER_TICK` whenever the import flag is off
   * — and the import leg, where the ceiling is deliberately higher, does not run
   * this use case at all. So an audience this loop cannot push is refused
   * upstream as `broadcast_audience_too_large`, terminally, with the member
   * told. That is the honest answer once there is no second path to carry it.
   */
  it('an audience above the accept ceiling is refused terminally — there is no batch path to defer to', async () => {
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
        audienceMode: 'primary_only' as const,
        // The clamped shape prod actually runs on this leg: accept bound and
        // delivery bound are the SAME number, so nothing can resolve into the
        // gap the hand-off existed to cover.
        audienceCeiling: 2,
        broadcastsGateway: gw.port,
        membersBridge: makeMembersBridge({
          recipients: [
            recipient('m-r1', 'one@example.com'),
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

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    // NOT `DEFERRED_TO_BATCH_PATH` — that kind no longer exists.
    expect((result.error as { kind: string }).kind).toBe('broadcast_failed_to_dispatch');

    // Nothing was pushed. A partial push would leave an orphan Resend audience
    // holding real addresses.
    expect(gw.audienceCalls).toHaveLength(0);
    expect(gw.contactsCalls).toHaveLength(0);
    expect(gw.sendCalls).toHaveLength(0);
  });
});
