/**
 * T051 — FR-002 precondition `k` (R3-NEW-1) halt-flag enforcement.
 *
 * Verifies the submit-broadcast use case rejects with
 * `broadcast_member_halted_pending_review` when the member's halt
 * flag is set, AND that the admin clear-halt path resumes
 * dispatch. Uses stub bridges to drive the use-case directly without
 * needing to seed F1+F2+F3 data in live Neon.
 *
 * Live-DB cross-tenant + RLS coverage lives in `tenant-isolation.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { submitBroadcast } from '@/modules/broadcasts';
import { clearHalt } from '@/modules/broadcasts/application/use-cases/clear-halt';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { rfc5321EmailValidator } from '@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator';
import type { HtmlSanitizerPort } from '@/modules/broadcasts/application/ports/html-sanitizer-port';

const stubSanitizer: HtmlSanitizerPort = {
  sanitize(html: string): string {
    return html.replace(/<script[\s\S]*?<\/script>/gi, '');
  },
};
import { asTenantContext } from '@/modules/tenants';
import type { AuditEmitInput, AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { BroadcastsRepo, NewBroadcastDraftInput } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { PlansBridgePort } from '@/modules/broadcasts/application/ports/plans-bridge-port';
import type { EventAttendeesRepository } from '@/modules/broadcasts/application/ports/event-attendees-repository';
import type { MarketingUnsubscribesRepo } from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';
import type { RateLimiterPort } from '@/modules/broadcasts/application/ports/rate-limiter-port';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';

const tenant = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

const auditEmits: Array<AuditEmitInput> = [];
const auditPort: AuditPort = {
  async emit(_tx, e) {
    auditEmits.push(e);
  },
};

interface State {
  haltedSet: Set<string>;
  insertedRows: Array<NewBroadcastDraftInput>;
}

function makeState(opts: { halted?: boolean }): State {
  return {
    haltedSet: opts.halted ? new Set(['m-1']) : new Set(),
    insertedRows: [],
  };
}

function makeMembersBridge(state: State): MembersBridgePort {
  const haltCalls: Array<{ memberId: string; halted: boolean }> = [];
  return {
    async getMembersBySegment() {
      return [
        {
          memberId: 'm-2',
          displayName: 'Other',
          primaryContactEmail: unsafeBrandEmailLower('other@example.com'),
          tierCode: null,
          broadcastsHaltedUntilAdminReview: false,
        },
      ];
    },
    async getMemberPrimaryContact() {
      return unsafeBrandEmailLower('member@example.com');
    },
    async lookupContactEmailInTenant() {
      return null;
    },
    async lookupMemberPrimaryContactEmailInTenant() {
      return null;
    },
    async getMembersHaltedInTenant() {
      return [...state.haltedSet].map((memberId) => ({
        memberId,
        displayName: memberId,
        haltedSinceBroadcastId: 'b-prev',
        haltedSinceAt: FROZEN_NOW,
      }));
    },
    async setMemberHalt(_ctx, memberId, halted) {
      haltCalls.push({ memberId, halted });
      if (halted) state.haltedSet.add(memberId);
      else state.haltedSet.delete(memberId);
      return ok(undefined);
    },
    async memberExistsInTenant() { return true; },
    async markBroadcastsAcknowledged() {
      return ok(undefined);
    },
  };
}

function makeBroadcastsRepo(state: State): BroadcastsRepo {
  return {
    async withTx(fn) {
      return fn(null);
    },
    async insertDraft(_tx, input): Promise<Broadcast> {
      state.insertedRows.push(input);
      return {
        ...(input as Broadcast),
        status: 'draft',
        submittedAt: null,
        approvedAt: null,
        approvedByUserId: null,
        rejectedAt: null,
        rejectedByUserId: null,
        rejectionReason: null,
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
      } as Broadcast;
    },
    async updateDraft() {
      throw new Error('not used');
    },
    async findById() {
      return null;
    },
    async findByIdInTx() {
      return null;
    },
    async lockForUpdate() {
      return null;
    },
    async applyTransition(_tx, _t, _b, status) {
      const last = state.insertedRows[state.insertedRows.length - 1];
      if (!last) throw new Error('no insert');
      return { ...(last as unknown as Broadcast), status } as Broadcast;
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
  };
}

const plansBridge: PlansBridgePort = {
  async getPlanForMember() {
    return ok({
      planId: 'corporate',
      planCode: 'corporate',
      eblastPerYear: 6,
    });
  },
};

const eventAttendees: EventAttendeesRepository = {
  async getLastNinetyDayAttendees() {
    return [];
  },
  async lookupAttendeeEmailInTenant() {
    return null;
  },
};

const marketingUnsubscribes: MarketingUnsubscribesRepo = {
  async upsert() {
    throw new Error('not used');
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

const rateLimiter: RateLimiterPort = {
  async checkLimit() {
    return ok(true);
  },
};

const baseInput = {
  memberId: 'm-1',
  submittedByUserId: 'u-1',
  actorRole: 'member_self_service' as const,
  tenantDisplayName: 'SweCham',
  subject: 'Hello',
  bodySource: 'plain',
  bodyHtml: '<p>Hello world</p>',
  segment: { kind: 'all_members' as const },
  scheduledFor: null,
  requestId: 'req-test',
};

beforeEach(() => {
  auditEmits.length = 0;
  vi.useFakeTimers({ now: FROZEN_NOW });
});
afterEach(() => vi.useRealTimers());

describe('halt-flag precondition (T051)', () => {
  it('halted=true → submit returns broadcast_member_halted_pending_review', async () => {
    const state = makeState({ halted: true });
    const result = await submitBroadcast(
      {
        tenant,
        broadcastsRepo: makeBroadcastsRepo(state),
        sanitizer: stubSanitizer,
        membersBridge: makeMembersBridge(state),
        plansBridge,
        emailValidator: rfc5321EmailValidator,
        eventAttendees,
        marketingUnsubscribes,
        rateLimiter,
        audit: auditPort,
        clock: { now: () => FROZEN_NOW },
      },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_member_halted_pending_review');
    }
  });

  it('rejected halt-blocked submission does NOT insert broadcasts row', async () => {
    const state = makeState({ halted: true });
    await submitBroadcast(
      {
        tenant,
        broadcastsRepo: makeBroadcastsRepo(state),
        sanitizer: stubSanitizer,
        membersBridge: makeMembersBridge(state),
        plansBridge,
        emailValidator: rfc5321EmailValidator,
        eventAttendees,
        marketingUnsubscribes,
        rateLimiter,
        audit: auditPort,
        clock: { now: () => FROZEN_NOW },
      },
      baseInput,
    );
    expect(state.insertedRows).toHaveLength(0);
  });

  it('audit broadcast_member_halted_pending_review emitted with member_id', async () => {
    const state = makeState({ halted: true });
    await submitBroadcast(
      {
        tenant,
        broadcastsRepo: makeBroadcastsRepo(state),
        sanitizer: stubSanitizer,
        membersBridge: makeMembersBridge(state),
        plansBridge,
        emailValidator: rfc5321EmailValidator,
        eventAttendees,
        marketingUnsubscribes,
        rateLimiter,
        audit: auditPort,
        clock: { now: () => FROZEN_NOW },
      },
      baseInput,
    );
    const evt = auditEmits.find(
      (e) => e.eventType === 'broadcast_member_halted_pending_review',
    );
    expect(evt).toBeDefined();
    expect((evt?.payload as { memberId: string }).memberId).toBe('m-1');
  });

  it('halt cleared via setMemberHalt → next submit succeeds', async () => {
    const state = makeState({ halted: true });
    const membersBridge = makeMembersBridge(state);
    const repo = makeBroadcastsRepo(state);

    // Admin clears the halt
    const clearResult = await clearHalt(
      {
        tenant,
        membersBridge,
        audit: auditPort,
        clock: { now: () => FROZEN_NOW },
      },
      { memberId: 'm-1', actorUserId: 'admin-7', requestId: 'req-clear' },
    );
    expect(clearResult.ok).toBe(true);

    // Subsequent submit should now pass the halt-flag precondition
    const submitResult = await submitBroadcast(
      {
        tenant,
        broadcastsRepo: repo,
        sanitizer: stubSanitizer,
        membersBridge,
        plansBridge,
        emailValidator: rfc5321EmailValidator,
        eventAttendees,
        marketingUnsubscribes,
        rateLimiter,
        audit: auditPort,
        clock: { now: () => FROZEN_NOW },
      },
      baseInput,
    );
    expect(submitResult.ok).toBe(true);
  });

  it('clear-halt with bridge unauthorised → forbidden error', async () => {
    const restrictiveBridge: MembersBridgePort = {
      ...makeMembersBridge(makeState({ halted: true })),
      async setMemberHalt() {
        return err({
          kind: 'member_halt.unauthorized' as const,
          actorRole: 'manager',
        });
      },
    };
    const r = await clearHalt(
      {
        tenant,
        membersBridge: restrictiveBridge,
        audit: auditPort,
        clock: { now: () => FROZEN_NOW },
      },
      { memberId: 'm-1', actorUserId: 'manager-1', requestId: 'req-1' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('forbidden');
  });

  it('halted member can still be queried via getMembersHaltedInTenant (read not blocked)', async () => {
    const state = makeState({ halted: true });
    const bridge = makeMembersBridge(state);
    const halted = await bridge.getMembersHaltedInTenant(tenant);
    expect(halted).toHaveLength(1);
    expect(halted[0]?.memberId).toBe('m-1');
  });

  it('non-halted member submit succeeds (control)', async () => {
    const state = makeState({ halted: false });
    const result = await submitBroadcast(
      {
        tenant,
        broadcastsRepo: makeBroadcastsRepo(state),
        sanitizer: stubSanitizer,
        membersBridge: makeMembersBridge(state),
        plansBridge,
        emailValidator: rfc5321EmailValidator,
        eventAttendees,
        marketingUnsubscribes,
        rateLimiter,
        audit: auditPort,
        clock: { now: () => FROZEN_NOW },
      },
      baseInput,
    );
    expect(result.ok).toBe(true);
  });
});
