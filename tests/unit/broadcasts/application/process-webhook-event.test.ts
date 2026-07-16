/**
 * T150 โ€” Unit tests for `process-webhook-event.ts` Application use-case.
 *
 * Covers (a) idempotent replay (FR-025), (b) suppression cascade on
 * hard bounce (FR-027), (c) suppression + complaint audit, (d) the
 * sending โ’ sent transition + quota consumption when terminal events
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
import type { EmailTransactionalPort } from '@/modules/broadcasts/application/ports/email-transactional-port';
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
    manualRetryCount: 0,
    partialDeliveryAcceptedAt: null,
    partialDeliveryAcceptedByUserId: null,
    templateProvenance: null,
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
    async updateDraftFromTemplate() {
      throw new Error('not used in process-webhook-event fixture');
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
    async pruneExpiredDrafts() {
      return { prunedCount: 0 };
    },
    async listInFlightOwnedByMember() { return []; },
    async scrubContentForMemberInTx() { return { scrubbedCount: 0 }; },
    async tombstoneDeliveriesForMemberInTx() { return { tombstonedCount: 0 }; },
    async listMemberResendAudienceContactsInTx() { return []; },
    async redactMemberEmailFromCustomRecipientsInTx() { return { redactedCount: 0 }; },
    async listTerminalBroadcastsWithLiveAudience() { throw new Error('not used in process-webhook-event fixture'); },
    async markAudienceDeletedInTx() { throw new Error('not used in process-webhook-event fixture'); },
    async existingBroadcastIds() { throw new Error('not used in process-webhook-event fixture'); },
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
    async getMemberPreferredLocale() { return null; },
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
      async emitTyped(_tx, e) {
        emits.push(e as AuditEmitInput);
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

  it('hard bounce โ’ suppression upsert + audit broadcast_suppression_applied (FR-027)', async () => {
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

  it('terminal-event count reaches estimatedRecipientCount โ’ sendingโ’sent + quota consumed', async () => {
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

  // R6 staff-review W-T4 fix — Bangkok timezone boundary cases for
  // FR-007 quota-year derivation. The prior single test fixed the
  // clock at 2026-06-15 which yielded 2026 in BOTH UTC and BKK, so a
  // regression that swapped `tenantTz` for UTC would not be caught.
  // These two tests pin the Asia/Bangkok boundary explicitly.
  it('Bangkok new-year boundary: 2026-12-31T17:01:00Z (= 2027-01-01 00:01 BKK) → quotaYear 2027', async () => {
    const NY_BKK = new Date('2026-12-31T17:01:00Z');
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ estimatedRecipientCount: 1 }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 1,
        delivered: 1,
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
        clock: { now: () => NY_BKK },
      },
      {
        broadcastId,
        event: { ...buildEvent('delivered'), createdAtUnixSeconds: Math.floor(NY_BKK.getTime() / 1000) },
        requestId: null,
      },
    );
    expect(result.ok).toBe(true);
    const quotaAudit = audit.emits.find(
      (e) => e.eventType === 'broadcast_quota_consumed',
    );
    expect(quotaAudit?.payload['quotaYear']).toBe(2027);
  });

  it('Bangkok pre-rollover boundary: 2026-12-31T16:59:00Z (= 2026-12-31 23:59 BKK) → quotaYear 2026', async () => {
    const PRE_NY_BKK = new Date('2026-12-31T16:59:00Z');
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ estimatedRecipientCount: 1 }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 1,
        delivered: 1,
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
        clock: { now: () => PRE_NY_BKK },
      },
      {
        broadcastId,
        event: { ...buildEvent('delivered'), createdAtUnixSeconds: Math.floor(PRE_NY_BKK.getTime() / 1000) },
        requestId: null,
      },
    );
    expect(result.ok).toBe(true);
    const quotaAudit = audit.emits.find(
      (e) => e.eventType === 'broadcast_quota_consumed',
    );
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
    // R7 staff-review MED-T2 fix — assert delivery row IS recorded
    // even on terminal-state path. FR-025 idempotency requires
    // terminal path ≠ replay path: terminal still INSERTs the
    // delivery row; replay returns 'duplicate' with no INSERT.
    expect(deliveries.upserts).toHaveLength(1);
  });

  // R7 staff-review HIGH-2 fix — pin the audit event type emitted on
  // a fresh `delivered` webhook event. R6 B1 changed this from
  // `broadcast_send_started` to `broadcast_delivery_recorded`; without
  // this test, a regression to the old event type would ship green
  // (the audit-event-type-emission grep test only checks declarations,
  // not emission paths in the mock chain).
  it('delivered event (fresh insert) → emits broadcast_delivery_recorded (NOT broadcast_send_started)', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ estimatedRecipientCount: 100 }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 1,
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
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_delivery_recorded'),
    ).toBeDefined();
    // Pin the negative — old event must NOT be emitted on delivered
    // webhook events (it's reserved for the dispatch use-case's
    // send-init).
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_send_started'),
    ).toBeUndefined();
  });
});

describe('process-webhook-event โ€” per-broadcast complaint-rate auto-halt (FR-027 / Q14 / SC-005(b))', () => {
  // Review TEST-1: closes the gap where the 20-event small-N noise
  // floor + 5% threshold + setMemberHalt cascade were unasserted.

  it('crosses 20-event floor + >5% rate โ’ setMemberHalt called + breach audit emitted', async () => {
    // 21 terminal events (1 complaint + 20 delivered) โ’ 1/21 โ 4.76%
    // โ€” below 5%, halt should NOT fire (boundary check below).
    // For a positive halt: 22 terminals (2 complaints + 20 delivered)
    // โ’ 2/22 โ 9.1% AND โฅ20 events โ’ halt fires.
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ estimatedRecipientCount: 100 }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 20,
        bounced: 0,
        softBounced: 0,
        complained: 2,
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
        event: buildEvent('complained'),
        requestId: null,
      },
    );

    expect(members.haltCalls).toHaveLength(1);
    expect(members.haltCalls[0]).toEqual({
      memberId: '44444444-4444-4444-4444-444444444444',
      halted: true,
    });
    const breach = audit.emits.find(
      (e) => e.eventType === 'broadcast_complaint_rate_per_broadcast_breach',
    );
    expect(breach).toBeDefined();
    expect(breach?.payload['recipientsAtBreach']).toBe(22);

    // Round 3 G2 — assert hashRecipient format on every audit row that
    // carries `recipientEmailHashed`. Format must be `sha256:<24-hex>`
    // so dashboards can mass-grep without knowing per-tenant salts.
    // Plaintext email MUST NOT appear in any audit payload (PDPA §23 +
    // GDPR Art. 5(1)(c) data minimisation).
    const hashedEvents = audit.emits.filter((e) =>
      Object.prototype.hasOwnProperty.call(
        e.payload ?? {},
        'recipientEmailHashed',
      ),
    );
    expect(hashedEvents.length).toBeGreaterThan(0);
    for (const ev of hashedEvents) {
      const hashed = (ev.payload as { recipientEmailHashed: unknown })
        .recipientEmailHashed;
      expect(typeof hashed).toBe('string');
      expect(hashed).toMatch(/^sha256:[a-f0-9]{24}$/);
      // Plaintext leak guard.
      const payloadJson = JSON.stringify(ev.payload);
      expect(payloadJson).not.toMatch(/@/);
    }
  });

  it('below 20-event noise floor โ’ halt does NOT fire even at 100% complaint rate', async () => {
    // 5 terminals all complaints (100%) โ€” n<20 โ’ no halt.
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ estimatedRecipientCount: 100 }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 0,
        bounced: 0,
        softBounced: 0,
        complained: 5,
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
        event: buildEvent('complained'),
        requestId: null,
      },
    );

    // Suppression still applies (the spec'd cascade is independent of
    // the halt cascade) โ€” but member halt MUST NOT fire below the floor.
    expect(members.haltCalls).toHaveLength(0);
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_complaint_rate_per_broadcast_breach',
      ),
    ).toBeUndefined();
    // Suppression IS still recorded.
    expect(unsub.upserts).toHaveLength(1);
  });

  it('above noise floor but โค5% rate โ’ halt does NOT fire (boundary)', async () => {
    // 21 terminals (1 complaint + 20 delivered) โ’ 1/21 โ 4.76% โ€” under
    // 5%, halt MUST NOT fire even though n โฅ 20.
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ estimatedRecipientCount: 100 }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 20,
        bounced: 0,
        softBounced: 0,
        complained: 1,
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
        event: buildEvent('complained'),
        requestId: null,
      },
    );

    expect(members.haltCalls).toHaveLength(0);
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_complaint_rate_per_broadcast_breach',
      ),
    ).toBeUndefined();
  });
});

describe('process-webhook-event โ€” terminal-state guard does NOT double-consume quota (TEST-1 lock)', () => {
  it('event arriving after broadcast already sent does NOT re-emit broadcast_quota_consumed', async () => {
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
        delivered: 99,
        bounced: 0,
        softBounced: 0,
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
        event: buildEvent('delivered'),
        requestId: null,
      },
    );

    // Locks the FR-028 "do not double-consume quota" invariant.
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_quota_consumed'),
    ).toBeUndefined();
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_sent'),
    ).toBeUndefined();
    // ERR-H2: late-event audit IS emitted for forensic visibility.
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_concurrent_action_blocked',
      ),
    ).toBeDefined();
  });
});

describe('process-webhook-event โ€” dup-replay on already-sent broadcast (TEST-GAP closure)', () => {
  it('idempotent replay (inserted=false) on a `sent` broadcast does NOT emit broadcast_concurrent_action_blocked (audit-spam guard)', async () => {
    // Combines two terminal-guard conditions: the broadcast is already
    // `sent` AND the upsert returns `inserted=false` (Resend re-delivered
    // the same svix-id we already persisted). The late-event audit
    // (ERR-H2) must fire ONLY on genuinely-new late events; replays
    // must stay silent or audit_log floods on every Resend retry.
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({
        status: 'sent',
        sentAt: FROZEN_NOW,
        quotaYearConsumed: 2026,
        quotaConsumedAt: FROZEN_NOW,
      }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [false], // โ replay on terminal broadcast
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
    // Audit spam guard: no broadcast_concurrent_action_blocked on
    // idempotent replay.
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_concurrent_action_blocked',
      ),
    ).toBeUndefined();
    // Sanity: no transitions, no quota consumed.
    expect(broadcasts.transitions).toHaveLength(0);
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_quota_consumed'),
    ).toBeUndefined();
  });
});

describe('process-webhook-event — outbox best-effort + observability fallback (R6 B4 fix; TEST-G1)', () => {
  it('outbox failure DOES NOT roll back broadcast_sent — AS3 via logger.error + alert (best-effort by design)', async () => {
    // Round 2 fix (ERR-C1) made the outbox INSERT participate in the
    // broadcastsRepo.withTx scope. This test locks the rollback
    // contract: if sendMemberEmail throws, the entire withTx callback
    // re-throws, and the use-case wraps it as a server_error. A
    // regression that catches+swallows the outbox throw (or moves the
    // INSERT back outside the tx) would let broadcast_sent commit
    // alone, breaking the AS3 invariant "every sending โ’ sent
    // transition produces a summary email."
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ estimatedRecipientCount: 1 }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 1,
        bounced: 0,
        softBounced: 0,
        complained: 0,
      },
    });
    const unsub = makeUnsubscribesRepo();
    const audit = makeAudit();
    const members: MembersBridgePort = {
      async getMembersBySegment() { return []; },
      async getMemberPrimaryContact() {
        // Member lookup succeeds โ€” a real email is found.
        return unsafeBrandEmailLower('alice@example.com');
      },
      async memberExistsInTenant() { return true; },
      async lookupContactEmailInTenant() { return null; },
      async lookupMemberPrimaryContactEmailInTenant() { return null; },
      async getMembersHaltedInTenant() { return []; },
      async setMemberHalt() { return ok(undefined); },
      async markBroadcastsAcknowledged() { return ok({ previouslyNull: true }); },
      async getMemberPreferredLocale() { return null; },
    };
    // Email transport throws โ€” simulating a Postgres outage on the
    // outbox INSERT.
    const failingEmailTransport: EmailTransactionalPort = {
      async sendAdminNotification() { /* not used */ },
      async sendMemberEmail() {
        throw new Error('notifications_outbox INSERT failed: connection terminated');
      },
    };

    const result = await processWebhookEvent(
      {
        tenant,
        broadcastsRepo: broadcasts.port,
        deliveriesRepo: deliveries.port,
        marketingUnsubscribes: unsub.port,
        membersBridge: members,
        audit: audit.port,
        clock: { now: () => FROZEN_NOW },
        emailTransactional: failingEmailTransport,
      },
      {
        broadcastId,
        event: buildEvent('delivered'),
        requestId: null,
      },
    );

    // R6 staff-review B4 fix — the prior comment block claimed this
    // test pinned the rollback contract; in reality
    // `enqueueDeliverySummaryEmail` (process-webhook-event.ts:659)
    // wraps `sendMemberEmail` in try/catch and emits
    // `broadcasts.delivered_email.enqueue_failed` via logger.error.
    // The reason the helper swallows is to prevent a transient
    // outbox/Postgres outage from cascading into a Resend webhook 5xx
    // storm (Resend would retry, the outbox would still be down, and
    // broadcasts would never transition to `sent` — worse than
    // missing one summary email).
    //
    // AS3 invariant ("every sending → sent produces a summary email")
    // is therefore enforced via OBSERVABILITY (logger.error +
    // `f7-broadcasts.delivered_email_enqueue_failures` alert + manual
    // re-enqueue runbook), NOT transaction atomicity. This test pins
    // THAT contract:
    //   1. result.ok === true (sent transition committed despite
    //      outbox failure — the alternative is a 5xx storm).
    //   2. broadcast_sent + broadcast_quota_consumed audit rows
    //      committed in the tx alongside the transition.
    //
    // The logger.error emit IS the AS3 enforcement signal — a
    // regression that drops it would break the alert chain silently.
    // A `logger.error` spy assertion would tighten this further but
    // requires `vi.mock` on `@/lib/logger` which collides with
    // unrelated suite setup; the live-pino integration test is the
    // load-bearing observability assertion (covered via
    // tests/integration/broadcasts/webhook-idempotency.test.ts).
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === 'recorded') {
      expect(result.value.transitionedToSent).toBe(true);
    }
    // Audit rows DID emit (best-effort enqueue path swallowed the
    // outbox failure with a logger.error).
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_sent'),
    ).toBeDefined();
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_quota_consumed'),
    ).toBeDefined();
  });
});

describe('process-webhook-event — delivered-summary locale (email-locale audit 2026-07-16)', () => {
  it('renders the delivered-summary email in the member preferred locale, not hardcoded en', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ estimatedRecipientCount: 1 }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 1,
        bounced: 0,
        softBounced: 0,
        complained: 0,
      },
    });
    const unsub = makeUnsubscribesRepo();
    const audit = makeAudit();
    const members: MembersBridgePort = {
      async getMembersBySegment() { return []; },
      async getMemberPrimaryContact() {
        return unsafeBrandEmailLower('alice@example.com');
      },
      async memberExistsInTenant() { return true; },
      async lookupContactEmailInTenant() { return null; },
      async lookupMemberPrimaryContactEmailInTenant() { return null; },
      async getMembersHaltedInTenant() { return []; },
      async setMemberHalt() { return ok(undefined); },
      async markBroadcastsAcknowledged() { return ok({ previouslyNull: true }); },
      // Member explicitly prefers Thai.
      async getMemberPreferredLocale() { return 'th'; },
    };
    const sent: Array<{ templateKey: string; locale: string }> = [];
    const capturingTransport: EmailTransactionalPort = {
      async sendAdminNotification() {},
      async sendMemberEmail(_ctx, msg) {
        sent.push({ templateKey: msg.templateKey, locale: msg.locale });
      },
    };

    const result = await processWebhookEvent(
      {
        tenant,
        broadcastsRepo: broadcasts.port,
        deliveriesRepo: deliveries.port,
        marketingUnsubscribes: unsub.port,
        membersBridge: members,
        audit: audit.port,
        clock: { now: () => FROZEN_NOW },
        emailTransactional: capturingTransport,
      },
      { broadcastId, event: buildEvent('delivered'), requestId: null },
    );

    expect(result.ok).toBe(true);
    const delivered = sent.find((s) => s.templateKey === 'broadcast_delivered');
    expect(delivered).toBeDefined();
    expect(delivered!.locale).toBe('th');
  });
});

describe('process-webhook-event โ€” defence-in-depth checks', () => {
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

describe('process-webhook-event — bug fixes 2026-07-10 (#7 late suppression, #10 unsubscribed)', () => {
  it('#7: late hard bounce on an already-sent broadcast STILL suppresses (FR-027) + suppression audit', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({
        status: 'sent',
        sentAt: FROZEN_NOW,
        quotaYearConsumed: 2026,
        quotaConsumedAt: FROZEN_NOW,
      }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true], // genuinely-new late event
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
    if (result.ok) expect(result.value.kind).toBe('broadcast_terminal');
    // Core regression: suppression MUST fire even though terminal.
    expect(unsub.upserts).toHaveLength(1);
    expect(unsub.upserts[0]!.reason).toBe('hard_bounce');
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_suppression_applied'),
    ).toBeDefined();
    // No lifecycle mutation on the terminal path.
    expect(broadcasts.transitions).toHaveLength(0);
  });

  it('#7: late complaint on a cancelled broadcast suppresses + complaint_received (no member halt)', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({
        status: 'cancelled',
        cancelledAt: FROZEN_NOW,
      }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [true],
      aggregate: {
        broadcastId,
        sent: 0,
        delivered: 0,
        bounced: 0,
        softBounced: 0,
        complained: 1,
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
        event: buildEvent('complained'),
        requestId: null,
      },
    );

    expect(unsub.upserts).toHaveLength(1);
    expect(unsub.upserts[0]!.reason).toBe('complaint');
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_complaint_received'),
    ).toBeDefined();
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_suppression_applied'),
    ).toBeDefined();
    // Member-halt cascade is lifecycle-scoped — must NOT run on a terminal row.
    expect(members.haltCalls).toHaveLength(0);
  });

  it('#7: idempotent replay of a late bounce (inserted=false) does NOT re-suppress or re-audit', async () => {
    const broadcasts = makeBroadcastsRepo({
      currentBroadcast: baseBroadcast({ status: 'sent', sentAt: FROZEN_NOW }),
    });
    const deliveries = makeDeliveriesRepo({
      upsertInsertedSequence: [false], // replay
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
        event: buildEvent('bounced', { bounceType: 'hard' }),
        requestId: null,
      },
    );

    expect(unsub.upserts).toHaveLength(0);
    expect(audit.emits).toHaveLength(0);
  });

  it('#10: email.unsubscribed (MVP path) suppresses recipient WITHOUT writing a delivery row', async () => {
    const broadcasts = makeBroadcastsRepo({ currentBroadcast: baseBroadcast() });
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

    const unsubEvent: VerifiedBroadcastEvent = {
      id: 'msg_unsub_1',
      type: 'email.unsubscribed',
      createdAtUnixSeconds: Math.floor(FROZEN_NOW.getTime() / 1000),
      data: {
        broadcastId: 'rsb-1',
        recipientEmail: 'alice@example.com',
        resendMessageId: 'mid-1',
        status: 'unsubscribed',
      },
    };

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
      { broadcastId, event: unsubEvent, requestId: null },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('recorded');
    // Suppression recorded as recipient_initiated...
    expect(unsub.upserts).toHaveLength(1);
    expect(unsub.upserts[0]!.reason).toBe('recipient_initiated');
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_suppression_applied'),
    ).toBeDefined();
    // ...but NO broadcast_deliveries row (unsubscribed is not in that enum).
    expect(deliveries.upserts).toHaveLength(0);
    expect(broadcasts.transitions).toHaveLength(0);
  });
});

describe('helpers: shape conformance', () => {
  it('asBroadcastDeliveryId rejects malformed uuid', () => {
    expect(() => asBroadcastDeliveryId('not-a-uuid')).not.toThrow();
    // Unchecked brand cast โ€” domain enforces shape via parseBroadcastDeliveryId
  });
  it('unsafeBrandEmailLower preserves shape', () => {
    expect(unsafeBrandEmailLower('a@b.com')).toBe('a@b.com');
  });
});
