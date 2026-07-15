/**
 * 059-membership-suspension Task 5 — `submitBroadcast` precondition (l):
 * membership-access gate (F8 suspension → blocks F7 e-blast submission).
 *
 * Placed immediately after halt-flag (k), BEFORE rate-limit (d) in the
 * pipeline (submit-broadcast.ts ~:298-311). Harness mirrors
 * `tests/integration/broadcasts/halt-flag-precondition.test.ts` (minimal
 * stub deps, no heavy quota/segment fixture) rather than the full
 * `submit-broadcast.test.ts` fixture, since this precondition fires
 * before any of that machinery runs.
 *
 * The `err(lookup_error)` case is the fail-CLOSED requirement: an infra
 * blip on the F8 lookup must NEVER be treated as "full access" — it
 * surfaces as `submit.server_error` (500), mirroring the adjacent
 * quota-counter precondition's round-4 MED-D pattern
 * (submit-broadcast.ts:348-357), NOT the policy-reject kind (422).
 *
 * Call counters on rateLimiter / plansBridge / broadcastsRepo prove the
 * suspended path SHORT-CIRCUITS before quota reservation — the bug
 * class this whole feature exists to prevent (a gate that compiles but
 * is never reached, so quota still gets spent by a suspended member).
 */
import { describe, expect, it } from 'vitest';
import { ok, err } from '@/lib/result';
import { submitBroadcast } from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { rfc5321EmailValidator } from '@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';
import type {
  BroadcastsRepo,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { PlansBridgePort } from '@/modules/broadcasts/application/ports/plans-bridge-port';
import type { EventAttendeesRepository } from '@/modules/broadcasts/application/ports/event-attendees-repository';
import type { MarketingUnsubscribesRepo } from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';
import type { RateLimiterPort } from '@/modules/broadcasts/application/ports/rate-limiter-port';
import type { MembershipAccessPort } from '@/modules/broadcasts/application/ports/membership-access-port';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import type { SubmitBroadcastInput } from '@/modules/broadcasts/application/use-cases/submit-broadcast';

const tenant = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

interface CallCounters {
  rateLimiterCalls: number;
  planLookupCalls: number;
  quotaCountCalls: number;
  insertDraftCalls: number;
}

function makeCallCounters(): CallCounters {
  return {
    rateLimiterCalls: 0,
    planLookupCalls: 0,
    quotaCountCalls: 0,
    insertDraftCalls: 0,
  };
}

function makeAuditPort(): { emits: Array<AuditEmitInput>; port: AuditPort } {
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

function makeMembersBridge(): MembersBridgePort {
  return {
    async getMembersBySegment() {
      return [];
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
      return []; // NOT halted — reaches precondition (l)
    },
    async setMemberHalt() {
      return ok(undefined);
    },
    async memberExistsInTenant() {
      return true;
    },
    async markBroadcastsAcknowledged() {
      return ok({ previouslyNull: true });
    },
    async getMemberPreferredLocale() {
      return null;
    },
  };
}

function makeMembershipAccess(
  result: Awaited<ReturnType<MembershipAccessPort['getMembershipAccess']>>,
): MembershipAccessPort {
  return {
    async getMembershipAccess() {
      return result;
    },
  };
}

function makeRateLimiter(counters: CallCounters): RateLimiterPort {
  return {
    async checkLimit() {
      counters.rateLimiterCalls += 1;
      return ok(true);
    },
  };
}

function makePlansBridge(counters: CallCounters): PlansBridgePort {
  return {
    async getPlanForMember() {
      counters.planLookupCalls += 1;
      return ok({ planId: 'p', planCode: 'corporate', eblastPerYear: 6 });
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

function makeMarketingUnsubscribes(): MarketingUnsubscribesRepo {
  return {
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
}

function makeBroadcastsRepo(counters: CallCounters): BroadcastsRepo {
  return {
    async withTx(fn) {
      return fn(null);
    },
    async insertDraft(_tx, input) {
      counters.insertDraftCalls += 1;
      return { ...(input as unknown as Broadcast), status: 'draft' } as Broadcast;
    },
    async updateDraft() {
      throw new Error('not used in membership-access fixture');
    },
    async updateDraftFromTemplate() {
      throw new Error('not used in membership-access fixture');
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
    async applyTransition() {
      throw new Error(
        'not used — suspended path must never reach status transition',
      );
    },
    async attachResendIds() {},
    async attachAudienceId() {},
    async listByTenantStatus() {
      return { rows: [], nextCursor: null };
    },
    async countForMemberQuota() {
      counters.quotaCountCalls += 1;
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
    async listInFlightOwnedByMember() {
      return [];
    },
    async scrubContentForMemberInTx() {
      return { scrubbedCount: 0 };
    },
    async tombstoneDeliveriesForMemberInTx() {
      return { tombstonedCount: 0 };
    },
    async listMemberResendAudienceContactsInTx() {
      return [];
    },
    async redactMemberEmailFromCustomRecipientsInTx() {
      return { redactedCount: 0 };
    },
    async listTerminalBroadcastsWithLiveAudience() {
      throw new Error('not used in membership-access fixture');
    },
    async markAudienceDeletedInTx() {
      throw new Error('not used in membership-access fixture');
    },
    async existingBroadcastIds() {
      throw new Error('not used in membership-access fixture');
    },
  };
}

const baseInput: SubmitBroadcastInput = {
  memberId: 'm-1',
  submittedByUserId: 'u-1',
  actorRole: 'member_self_service',
  tenantDisplayName: 'SweCham',
  memberDisplayName: 'Acme Co',
  subject: 'Hello',
  bodySource: 'plain',
  bodyHtml: '<p>Hello world</p>',
  segment: { kind: 'all_members' },
  scheduledFor: null,
  requestId: 'req-test',
};

function makeDeps(counters: CallCounters, membershipAccess: MembershipAccessPort) {
  const audit = makeAuditPort();
  const broadcastsRepo = makeBroadcastsRepo(counters);
  return {
    audit,
    broadcastsRepo,
    deps: {
      tenant,
      broadcastsRepo,
      sanitizer: dompurifySanitizer,
      membersBridge: makeMembersBridge(),
      plansBridge: makePlansBridge(counters),
      emailValidator: rfc5321EmailValidator,
      eventAttendees: makeEventAttendees(),
      marketingUnsubscribes: makeMarketingUnsubscribes(),
      rateLimiter: makeRateLimiter(counters),
      membershipAccess,
      audit: audit.port,
      clock: { now: () => FROZEN_NOW },
    },
  };
}

describe('submit-broadcast — precondition (l) membership access (Task 5)', () => {
  it('suspended member → broadcast_membership_suspended_blocked (422 policy)', async () => {
    const counters = makeCallCounters();
    const membershipAccess = makeMembershipAccess(
      ok({ access: 'suspended', reason: 'unpaid' }),
    );
    const { deps } = makeDeps(counters, membershipAccess);

    const result = await submitBroadcast(deps, baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_membership_suspended_blocked');
    }
  });

  it('membership-access lookup_error → submit.server_error (fail-CLOSED, NOT the policy code)', async () => {
    const counters = makeCallCounters();
    const membershipAccess = makeMembershipAccess(
      err({ kind: 'membership_access.lookup_error' }),
    );
    const { deps } = makeDeps(counters, membershipAccess);

    const result = await submitBroadcast(deps, baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('submit.server_error');
      if (result.error.kind === 'submit.server_error') {
        expect(result.error.message).toContain('membership_access_error');
      }
    }
  });

  it('suspended member: NO quota reserved — rate-limiter/plan/quota-count/insert never invoked (short-circuit proof)', async () => {
    const counters = makeCallCounters();
    const membershipAccess = makeMembershipAccess(
      ok({ access: 'suspended', reason: 'unpaid' }),
    );
    const { deps } = makeDeps(counters, membershipAccess);

    await submitBroadcast(deps, baseInput);

    expect(counters.rateLimiterCalls).toBe(0);
    expect(counters.planLookupCalls).toBe(0);
    expect(counters.quotaCountCalls).toBe(0);
    expect(counters.insertDraftCalls).toBe(0);
  });

  it('terminated member is ALSO blocked (access !== "full" catches both suspended and terminated)', async () => {
    const counters = makeCallCounters();
    const membershipAccess = makeMembershipAccess(
      ok({ access: 'terminated', reason: 'grace_expired' }),
    );
    const { deps } = makeDeps(counters, membershipAccess);

    const result = await submitBroadcast(deps, baseInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_membership_suspended_blocked');
    }
    expect(counters.rateLimiterCalls).toBe(0);
  });

  it('suspended member → emits broadcast_membership_suspended_blocked audit (Task 8)', async () => {
    const counters = makeCallCounters();
    const membershipAccess = makeMembershipAccess(
      ok({ access: 'suspended', reason: 'unpaid' }),
    );
    const { deps, audit } = makeDeps(counters, membershipAccess);

    await submitBroadcast(deps, baseInput);

    expect(audit.emits).toHaveLength(1);
    expect(audit.emits[0]).toMatchObject({
      eventType: 'broadcast_membership_suspended_blocked',
      payload: { memberId: baseInput.memberId },
    });
  });

  it('terminated member ALSO emits broadcast_membership_suspended_blocked audit (Task 8)', async () => {
    const counters = makeCallCounters();
    const membershipAccess = makeMembershipAccess(
      ok({ access: 'terminated', reason: 'grace_expired' }),
    );
    const { deps, audit } = makeDeps(counters, membershipAccess);

    await submitBroadcast(deps, baseInput);

    expect(audit.emits).toHaveLength(1);
    expect(audit.emits[0]).toMatchObject({
      eventType: 'broadcast_membership_suspended_blocked',
      payload: { memberId: baseInput.memberId },
    });
  });

  it('full access member is NOT blocked by this precondition (control — reaches rate-limit)', async () => {
    const counters = makeCallCounters();
    const membershipAccess = makeMembershipAccess(
      ok({ access: 'full', reason: 'in_good_standing' }),
    );
    const { deps } = makeDeps(counters, membershipAccess);

    await submitBroadcast(deps, baseInput);

    // Control: full access must clear precondition (l) and reach the
    // rate-limiter (d). This test intentionally does NOT assert overall
    // submit success — the minimal fixture's segment stub (empty
    // recipient list) is not tuned for the full happy path; it only
    // proves this precondition does not block a full-access member.
    expect(counters.rateLimiterCalls).toBe(1);
  });
});
