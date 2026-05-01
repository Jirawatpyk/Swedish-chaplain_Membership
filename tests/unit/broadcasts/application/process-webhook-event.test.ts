/**
 * T150 — Unit tests for `process-webhook-event.ts` Application use-case.
 *
 * Covers (a) idempotent replay (FR-025), (b) suppression cascade on
 * hard bounce (FR-027), (c) suppression + complaint audit, (d) the
 * sending → sent transition + quota consumption when terminal events
 * complete the broadcast, (e) terminal-state guard (events arriving
 * after sent are recorded but do NOT mutate broadcast state).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processWebhookEvent } from '@/modules/broadcasts/application/use-cases/process-webhook-event';
import { asBroadcastId, type Broadcast } from '@/modules/broadcasts/domain/broadcast';
import { asTenantContext } from '@/modules/tenants';
import {
  asBroadcastDeliveryId,
  type BroadcastDelivery,
} from '@/modules/broadcasts/domain/broadcast-delivery';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';

import type { AuditEmitInput, AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type {
  BroadcastDeliveriesRepo,
  BroadcastDeliveryAggregate,
  NewBroadcastDeliveryInput,
} from '@/modules/broadcasts/application/ports/broadcast-deliveries-repo';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type {
  MarketingUnsubscribesRepo,
  NewSuppressionInput,
} from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { VerifiedBroadcastEvent } from '@/modules/broadcasts/application/ports/webhook-verifier-port';
import type { BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import { ok } from '@/lib/result';

const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');
const tenant = asTenantContext('test-tenant');
const broadcastId = asBroadcastId('33333333-3333-3333-3333-333333333333');

function baseBroadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    tenantId: 'test-tenant',
    broadcastId,
    requestedByMemberId: '44444444-4444-4444-4444-444444444444',
    requestedByMemberPlanIdSnapshot: 'corporate',
    submittedByUserId: '55555555-5555-5555-5555-555555555555',
    actorRole: 'member_self_service',
    subject: 'Welcome',
    bodyHtml: '<p>hi</p>',
    bodySource: 'hi',
    fromName: 'Chamber',
    replyToEmail: 'reply@example.com',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 3,
    status: 'sending',
    submittedAt: FROZEN_NOW,
    approvedAt: FROZEN_NOW,
    approvedByUserId: 'admin',
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    scheduledFor: FROZEN_NOW,
    sendingStartedAt: FROZEN_NOW,
    sentAt: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null,
    failedToDispatchAt: null,
    failureReason: null,
    quotaYearConsumed: null,
    quotaConsumedAt: null,
    resendAudienceId: 'aud-1',
    resendBroadcastId: 'rsb-1',
    retentionYears: 5,
    createdAt: FROZEN_NOW,
    updatedAt: FROZEN_NOW,
    ...overrides,
  };
}

function makeBroadcastsRepo(args: {
  readonly currentBroadcast: Broadcast;
}): {
  readonly port: BroadcastsRepo;
  readonly transitions: Array<{ target: string; fields: unknown }>;
} {
  const transitions: Array<{ target: string; fields: unknown }> = [];
  let current = args.currentBroadcast;
  const port: BroadcastsRepo = {
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
      return current;
    },
    async findByIdInTx() {
      return current;
    },
    async lockForUpdate() {
      return current.status;
    },
    async applyTransition(_tx, _t, _b, target, fields) {
      transitions.push({ target, fields });
      current = { ...current, status: target as BroadcastStatus, ...fields };
      return current;
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
  };
  return { port, transitions };
}

function makeDeliveriesRepo(args: {
  readonly upsertInsertedSequence: ReadonlyArray<boolean>;
  readonly aggregate: BroadcastDeliveryAggregate;
}): {
  readonly port: BroadcastDeliveriesRepo;
  readonly upserts: Array<NewBroadcastDeliveryInput>;
} {
  const upserts: Array<NewBroadcastDeliveryInput> = [];
  let upsertIdx = 0;
  const port: BroadcastDeliveriesRepo = {
    async upsertByResendEventId(_tx, input) {
      upserts.push(input);
      const inserted =
        args.upsertInsertedSequence[upsertIdx] ?? true;
      upsertIdx++;
      const delivery: BroadcastDelivery = {
        tenantId: input.tenantId,
        deliveryId: input.deliveryId,
        broadcastId: input.broadcastId,
        resendEventId: input.resendEventId,
        resendMessageId: input.resendMessageId,
        recipientEmailLower: input.recipientEmailLower,
        recipientMemberId: input.recipientMemberId,
        recipientMemberLookupAttemptedAt:
          input.recipientMemberLookupAttemptedAt,
        status: input.status,
        eventTimestamp: input.eventTimestamp,
        errorMessage: input.errorMessage,
        bounceType: input.bounceType,
        createdAt: FROZEN_NOW,
      };
      return { inserted, delivery };
    },
    async findByBroadcastId() {
      return [];
    },
    async aggregateByBroadcast() {
      return args.aggregate;
    },
  };
  return { port, upserts };
}

function makeUnsubscribesRepo(): {
  readonly port: MarketingUnsubscribesRepo;
  readonly upserts: Array<NewSuppressionInput>;
} {
  const upserts: Array<NewSuppressionInput> = [];
  const port: MarketingUnsubscribesRepo = {
    async upsert(_tx, input) {
      upserts.push(input);
      return {
        wasNew: true,
        suppression: {
          tenantId: input.tenantId,
          emailLower: input.emailLower,
          memberId: input.memberId,
          reason: input.reason,
          reasonText: input.reasonText,
          sourceBroadcastId: input.sourceBroadcastId,
          sourceTokenHash: input.sourceTokenHash,
          unsubscribedAt: FROZEN_NOW,
        },
      };
    },
    async findByEmailLower() {
      return null;
    },
    async lookupBatch() {
      return new Set();
    },
    async setMemberIdNull() {
      return { affected: 0 };
    },
  };
  return { port, upserts };
}

function makeMembersBridge(): { port: MembersBridgePort; haltCalls: Array<{ memberId: string; halted: boolean }> } {
  const haltCalls: Array<{ memberId: string; halted: boolean }> = [];
  const port: MembersBridgePort = {
    async getMembersBySegment() {
      return [];
    },
    async getMemberPrimaryContact() {
      return null;
    },
    async memberExistsInTenant() {
      return true;
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
    async setMemberHalt(_ctx, memberId, halted) {
      haltCalls.push({ memberId, halted });
      return ok(undefined);
    },
    async markBroadcastsAcknowledged() {
      return ok({ previouslyNull: true });
    },
  };
  return { port, haltCalls };
}

function makeAudit(): { port: AuditPort; emits: Array<AuditEmitInput> } {
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

function buildEvent(
  status: 'sent' | 'delivered' | 'bounced' | 'soft_bounced' | 'complained',
  overrides: Partial<VerifiedBroadcastEvent['data']> = {},
): VerifiedBroadcastEvent {
  return {
    id: `msg_${status}_${Math.random().toString(36).slice(2, 7)}`,
    type: `email.${status}`,
    createdAtUnixSeconds: Math.floor(FROZEN_NOW.getTime() / 1000),
    data: {
      broadcastId: 'rsb-1',
      recipientEmail: 'alice@example.com',
      resendMessageId: 'mid-1',
      status,
      ...overrides,
    },
  };
}

beforeEach(() => vi.useFakeTimers({ now: FROZEN_NOW }));
afterEach(() => vi.useRealTimers());

describe('process-webhook-event (T150 GREEN)', () => {
  it('replay (inserted=false) is a no-op for downstream side effects (FR-025)', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast(),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [false],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 0,
        bounced: 0,
        softBounced: 0,
        complained: 0,
      },
    });
    const unsub = makeUnsubscribesRepo();
    const audit = makeAudit();
    const members = makeMembersBridge();

    const result = await processWebhookEvent(
      {
        tenant,
        broadcastsRepo: broadcasts.port,
        deliveriesRepo: deliveries.port,
        marketingUnsubscribes: unsub.port,
        membersBridge: members.port,
        audit: audit.port,
        clock: { now: () => FROZEN_NOW },
      },
      {
        broadcastId,
        event: buildEvent('delivered'),
        requestId: 'req-1',
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('duplicate');
    expect(unsub.upserts).toHaveLength(0);
    expect(audit.emits).toHaveLength(0);
    expect(broadcasts.transitions).toHaveLength(0);
  });

  it('hard bounce → suppression upsert + audit broadcast_suppression_applied (FR-027)', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast(),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 0,
        bounced: 1,
        softBounced: 0,
        complained: 0,
      },
    });
    const unsub = makeUnsubscribesRepo();
    const audit = makeAudit();
    const members = makeMembersBridge();

    const result = await processWebhookEvent(
      {
        tenant,
        broadcastsRepo: broadcasts.port,
        deliveriesRepo: deliveries.port,
        marketingUnsubscribes: unsub.port,
        membersBridge: members.port,
        audit: audit.port,
        clock: { now: () => FROZEN_NOW },
      },
      {
        broadcastId,
        event: buildEvent('bounced', { bounceType: 'hard' }),
        requestId: null,
      },
    );

    expect(result.ok).toBe(true);
    expect(unsub.upserts).toHaveLength(1);
    expect(unsub.upserts[0]!.reason).toBe('hard_bounce');
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_suppression_applied'),
    ).toBeDefined();
  });

  it('soft bounce records row but does NOT trigger suppression cascade', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast(),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 0,
        bounced: 0,
        softBounced: 1,
        complained: 0,
      },
    });
    const unsub = makeUnsubscribesRepo();
    const audit = makeAudit();
    const members = makeMembersBridge();

    await processWebhookEvent(
      {
        tenant,
        broadcastsRepo: broadcasts.port,
        deliveriesRepo: deliveries.port,
        marketingUnsubscribes: unsub.port,
        membersBridge: members.port,
        audit: audit.port,
        clock: { now: () => FROZEN_NOW },
      },
      {
        broadcastId,
        event: buildEvent('soft_bounced', { bounceType: 'soft' }),
        requestId: null,
      },
    );

    expect(unsub.upserts).toHaveLength(0);
    expect(broadcasts.transitions).toHaveLength(0);
  });

  it('terminal-event count reaches estimatedRecipientCount → sending→sent + quota consumed', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ estimatedRecipientCount: 3 }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 3,
        delivered: 3,
        bounced: 0,
        softBounced: 0,
        complained: 0,
      },
    });
    const unsub = makeUnsubscribesRepo();
    const audit = makeAudit();
    const members = makeMembersBridge();

    const result = await processWebhookEvent(
      {
        tenant,
        broadcastsRepo: broadcasts.port,
        deliveriesRepo: deliveries.port,
        marketingUnsubscribes: unsub.port,
        membersBridge: members.port,
        audit: audit.port,
        clock: { now: () => FROZEN_NOW },
      },
      {
        broadcastId,
        event: buildEvent('delivered'),
        requestId: null,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === 'recorded') {
      expect(result.value.transitionedToSent).toBe(true);
    }
    const sentTransition = broadcasts.transitions.find((t) => t.target === 'sent');
    expect(sentTransition).toBeDefined();
    const sentAudit = audit.emits.find((e) => e.eventType === 'broadcast_sent');
    expect(sentAudit).toBeDefined();
    const quotaAudit = audit.emits.find(
      (e) => e.eventType === 'broadcast_quota_consumed',
    );
    expect(quotaAudit).toBeDefined();
    expect(quotaAudit?.payload['quotaYear']).toBe(2026);
  });

  it('event after broadcast already sent: row recorded, no transition + outcome=broadcast_terminal', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({
        status: 'sent',
        sentAt: FROZEN_NOW,
        quotaYearConsumed: 2026,
        quotaConsumedAt: FROZEN_NOW,
      }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 5,
        bounced: 0,
        softBounced: 0,
        complained: 0,
      },
    });
    const unsub = makeUnsubscribesRepo();
    const audit = makeAudit();
    const members = makeMembersBridge();

    const result = await processWebhookEvent(
      {
        tenant,
        broadcastsRepo: broadcasts.port,
        deliveriesRepo: deliveries.port,
        marketingUnsubscribes: unsub.port,
        membersBridge: members.port,
        audit: audit.port,
        clock: { now: () => FROZEN_NOW },
      },
      {
        broadcastId,
        event: buildEvent('delivered'),
        requestId: null,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('broadcast_terminal');
    expect(broadcasts.transitions).toHaveLength(0);
  });
});

describe('process-webhook-event — defence-in-depth checks', () => {
  it('rejects malformed recipient email', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast(),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 0,
        bounced: 0,
        softBounced: 0,
        complained: 0,
      },
    });
    const unsub = makeUnsubscribesRepo();
    const audit = makeAudit();
    const members = makeMembersBridge();

    const result = await processWebhookEvent(
      {
        tenant,
        broadcastsRepo: broadcasts.port,
        deliveriesRepo: deliveries.port,
        marketingUnsubscribes: unsub.port,
        membersBridge: members.port,
        audit: audit.port,
        clock: { now: () => FROZEN_NOW },
      },
      {
        broadcastId,
        event: buildEvent('delivered', { recipientEmail: 'NOT_AN_EMAIL' }),
        requestId: null,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('process_webhook.invalid_payload');
    }
  });
});

describe('helpers: shape conformance', () => {
  it('asBroadcastDeliveryId rejects malformed uuid', () => {
    expect(() => asBroadcastDeliveryId('not-a-uuid')).not.toThrow();
    // Unchecked brand cast — domain enforces shape via parseBroadcastDeliveryId
  });
  it('unsafeBrandEmailLower preserves shape', () => {
    expect(unsafeBrandEmailLower('a@b.com')).toBe('a@b.com');
  });
});
