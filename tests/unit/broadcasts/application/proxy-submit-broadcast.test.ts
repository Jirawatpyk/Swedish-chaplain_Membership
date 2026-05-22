/**
 * T098 โ€” Unit tests for `proxy-submit-broadcast.ts` (Q12).
 *
 * Wave 6 GREEN โ€” admin-on-behalf-of-member. The use-case is a thin
 * wrapper that:
 *   1. Calls `membersBridge.getMemberPrimaryContact` (existence probe)
 *   2. Delegates to `submitBroadcast` with actorRole='admin_proxy'
 *   3. Casts the result to ProxySubmitBroadcastOutput
 *
 * Test focus:
 *   - actorRole='admin_proxy' propagated into persisted row
 *   - dual-actor mapping: proxiedMemberId โ’ requestedByMemberId,
 *     adminUserId โ’ submittedByUserId
 *   - quota bypass (admin_proxy short-circuits the quota branch in submit-broadcast)
 *   - halt-flag still enforced (admin can NOT bypass halt โ€” R3-NEW-1)
 *   - SubmitBroadcastError pass-through
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { proxySubmitBroadcast } from '@/modules/broadcasts/application/use-cases/proxy-submit-broadcast';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { ok, err } from '@/lib/result';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';
import { rfc5321EmailValidator } from '@/modules/broadcasts/infrastructure/email-validator/rfc5321-email-validator';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';
import type {
  BroadcastsRepo,
  NewBroadcastDraftInput,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { PlansBridgePort } from '@/modules/broadcasts/application/ports/plans-bridge-port';
import type { EventAttendeesRepository } from '@/modules/broadcasts/application/ports/event-attendees-repository';
import type { MarketingUnsubscribesRepo } from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';
import type { RateLimiterPort } from '@/modules/broadcasts/application/ports/rate-limiter-port';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/proxy-submit-broadcast.ts',
);
const tenant: TenantContext = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

interface FixtureOpts {
  readonly halted?: ReadonlyArray<string>;
  readonly rateLimitAllow?: boolean;
  readonly planFound?: boolean;
  readonly planCap?: number;
  readonly used?: number;
  readonly reserved?: number;
  readonly primaryContact?: string | null;
  readonly recipients?: ReadonlyArray<{
    memberId: string;
    primaryContactEmail: string | null;
  }>;
  /** Round-5 R5-T โ€” let tests synthesise "member not found in tenant" + infra-throw paths. */
  readonly memberExists?: boolean;
}

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

function makeMembersBridge(opts: FixtureOpts): MembersBridgePort {
  return {
    async getMembersBySegment() {
      return (opts.recipients ?? []).map((r) => ({
        memberId: r.memberId,
        displayName: r.memberId,
        primaryContactEmail:
          r.primaryContactEmail !== null
            ? unsafeBrandEmailLower(r.primaryContactEmail)
            : null,
        tierCode: null,
        broadcastsHaltedUntilAdminReview: false,
      }));
    },
    async getMemberPrimaryContact() {
      return opts.primaryContact !== null && opts.primaryContact !== undefined
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
      return (opts.halted ?? []).map((id) => ({
        memberId: id,
        displayName: id,
        haltedSinceBroadcastId: 'b-prev',
        haltedSinceAt: new Date(),
      }));
    },
    async setMemberHalt() {
      return ok(undefined);
    },
    async memberExistsInTenant() {
      return opts.memberExists ?? true;
    },
    async markBroadcastsAcknowledged() {
      return ok({ previouslyNull: true });
    },
    async getMemberPreferredLocale() { return null; },
  };
}

function makePlansBridge(opts: FixtureOpts): PlansBridgePort {
  return {
    async getPlanForMember(_ctx, memberId) {
      if (opts.planFound === false) {
        return err({ kind: 'plan_lookup.member_not_found', memberId });
      }
      return ok({
        planId: 'corporate-2026',
        planCode: 'corporate',
        eblastPerYear: opts.planCap ?? 6,
      });
    },
  };
}

function makeRepo(opts: FixtureOpts): {
  port: BroadcastsRepo;
  inserted: Array<NewBroadcastDraftInput>;
} {
  const inserted: Array<NewBroadcastDraftInput> = [];
  return {
    inserted,
    port: {
      async withTx(fn) {
        return fn(null);
      },
      async insertDraft(_tx, input) {
        inserted.push(input);
        return makeBroadcast(input);
      },
      async updateDraft() {
        throw new Error('not used');
      },
      async updateDraftFromTemplate() {
        throw new Error('not used in proxy-submit-broadcast fixture');
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
      async applyTransition(_tx, _t, _b, status, _f) {
        const last = inserted[inserted.length - 1];
        if (!last) throw new Error('no insert');
        return { ...makeBroadcast(last), status };
      },
      async attachResendIds() {},
      async attachAudienceId() {},
      async listByTenantStatus() {
        return { rows: [], nextCursor: null };
      },
      async countForMemberQuota() {
        return {
          submittedOrApproved: opts.reserved ?? 0,
          sent: opts.used ?? 0,
        };
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

function makeBroadcast(input: NewBroadcastDraftInput): Broadcast {
  return {
    tenantId: input.tenantId,
    broadcastId: input.broadcastId,
    requestedByMemberId: input.requestedByMemberId,
    requestedByMemberPlanIdSnapshot: input.requestedByMemberPlanIdSnapshot,
    submittedByUserId: input.submittedByUserId,
    actorRole: input.actorRole,
    subject: input.subject,
    bodyHtml: input.bodyHtml,
    bodySource: input.bodySource,
    fromName: input.fromName,
    replyToEmail: input.replyToEmail,
    segmentType: input.segmentType,
    segmentParams: input.segmentParams,
    customRecipientEmails: input.customRecipientEmails ?? null,
    estimatedRecipientCount: input.estimatedRecipientCount,
    status: 'draft',
    submittedAt: null,
    approvedAt: null,
    approvedByUserId: null,
    rejectedAt: null,
    rejectedByUserId: null,
    rejectionReason: null,
    scheduledFor: input.scheduledFor,
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

function makeRateLimiter(allow: boolean): RateLimiterPort {
  return {
    async checkLimit(key) {
      if (allow) return ok(true);
      return err({ kind: 'rate_limit_exceeded', retryAfterSeconds: 60, key });
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

function makeDeps(opts: FixtureOpts) {
  const audit = makeAudit();
  const repo = makeRepo(opts);
  return {
    audit,
    repo,
    deps: {
      tenant,
      broadcastsRepo: repo.port,
      sanitizer: dompurifySanitizer,
      membersBridge: makeMembersBridge(opts),
      plansBridge: makePlansBridge(opts),
      emailValidator: rfc5321EmailValidator,
      eventAttendees: makeEventAttendees(),
      marketingUnsubscribes: makeMarketingUnsubscribes(),
      rateLimiter: makeRateLimiter(opts.rateLimitAllow ?? true),
      audit: audit.port,
      clock: { now: () => FROZEN_NOW },
    },
  };
}

const baseInput = {
  proxiedMemberId: 'm-target',
  adminUserId: 'admin-7',
  tenantDisplayName: 'Test Chamber',
  subject: 'Welcome from your chamber admin',
  bodySource: 'plain',
  bodyHtml: '<p>Hello</p>',
  segment: { kind: 'all_members' as const },
  scheduledFor: null,
  requestId: 'req-proxy',
};

beforeEach(() => vi.useFakeTimers({ now: FROZEN_NOW }));
afterEach(() => vi.useRealTimers());

describe('proxy-submit-broadcast โ€” Wave 6 GREEN (T102 / Q12)', () => {
  it('use-case module exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // ---- Dual-actor (Q12) -----------------------------------------------

  it('persisted row: requestedByMemberId = proxiedMemberId (NOT admin id)', async () => {
    const { deps, repo } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(true);
    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0]?.requestedByMemberId).toBe('m-target');
  });

  it('persisted row: submittedByUserId = adminUserId', async () => {
    const { deps, repo } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    await proxySubmitBroadcast(deps, baseInput);
    expect(repo.inserted[0]?.submittedByUserId).toBe('admin-7');
  });

  it('persisted row: actorRole = "admin_proxy"', async () => {
    const { deps, repo } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    await proxySubmitBroadcast(deps, baseInput);
    expect(repo.inserted[0]?.actorRole).toBe('admin_proxy');
  });

  it('audit broadcast_submitted carries actorRole="admin_proxy"', async () => {
    const { deps, audit } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    await proxySubmitBroadcast(deps, baseInput);
    const evt = audit.emits.find((e) => e.eventType === 'broadcast_submitted');
    expect(evt).toBeDefined();
    const payload = evt?.payload as Record<string, unknown>;
    expect(payload.actorRole).toBe('admin_proxy');
  });

  // ---- Quota bypass (Q12) ---------------------------------------------

  it('admin proxy bypasses quota check even when proxied member at full quota', async () => {
    const { deps, repo } = makeDeps({
      planCap: 6,
      used: 6,
      reserved: 0,
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(true);
    expect(repo.inserted).toHaveLength(1);
  });

  it('admin proxy bypasses quota check at over-cap (rare invariant violation)', async () => {
    const { deps, repo } = makeDeps({
      planCap: 6,
      used: 8,
      reserved: 2,
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(true);
    expect(repo.inserted).toHaveLength(1);
  });

  // ---- Halt-state precondition still applies (R3-NEW-1) ------------

  it('proxied member halted โ’ broadcast_member_halted_pending_review (admin can NOT bypass halt)', async () => {
    const { deps, repo } = makeDeps({
      halted: ['m-target'],
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_member_halted_pending_review');
    }
    expect(repo.inserted).toHaveLength(0);
  });

  // ---- Member existence ---------------------------------------------

  it('rejects when proxied member missing primary contact email โ’ broadcast_member_missing_primary_contact_email', async () => {
    const { deps, repo } = makeDeps({
      primaryContact: null,
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe(
        'broadcast_member_missing_primary_contact_email',
      );
    }
    expect(repo.inserted).toHaveLength(0);
  });

  it('rejects when proxied member plan not found โ’ broadcast_not_in_plan', async () => {
    const { deps } = makeDeps({
      planFound: false,
      primaryContact: 'm-target@example.com',
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_not_in_plan');
  });

  // ---- Standard FR-002 preconditions still enforced ----------------

  it('subject too long โ’ broadcast_subject_too_long', async () => {
    const { deps } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const tooLong = 'x'.repeat(201);
    const result = await proxySubmitBroadcast(deps, {
      ...baseInput,
      subject: tooLong,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_subject_too_long');
  });

  it('empty body โ’ broadcast_body_unsafe_html (sanitiser strips to empty)', async () => {
    const { deps } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const result = await proxySubmitBroadcast(deps, {
      ...baseInput,
      bodyHtml: '<script>evil()</script>',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('broadcast_body_unsafe_html');
  });

  it('empty segment โ’ broadcast_empty_segment_blocked', async () => {
    const { deps } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [],
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_empty_segment_blocked');
    }
  });

  // ---- Atomicity --------------------------------------------------

  it('happy path: insertDraft + applyTransition(submitted) + audit emit are atomic in single tx', async () => {
    let txOpened = false;
    let txClosed = false;
    let insertWasInsideTx = false;
    let auditWasInsideTx = false;
    const { deps, repo, audit } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const wrappedRepo: BroadcastsRepo = {
      ...repo.port,
      async withTx(fn) {
        txOpened = true;
        const r = await fn(null);
        txClosed = true;
        return r;
      },
      async insertDraft(_tx, input) {
        insertWasInsideTx = txOpened && !txClosed;
        return repo.port.insertDraft(_tx, input);
      },
    };
    const wrappedAudit: AuditPort = {
      async emit(_tx, e) {
        if (e.eventType === 'broadcast_submitted') {
          auditWasInsideTx = txOpened && !txClosed;
        }
        audit.emits.push(e);
      },
      async emitTyped(_tx, e) {
        if (e.eventType === 'broadcast_submitted') {
          auditWasInsideTx = txOpened && !txClosed;
        }
        audit.emits.push(e as AuditEmitInput);
      },
    };
    await proxySubmitBroadcast(
      { ...deps, broadcastsRepo: wrappedRepo, audit: wrappedAudit },
      baseInput,
    );
    expect(insertWasInsideTx).toBe(true);
    expect(auditWasInsideTx).toBe(true);
  });

  it('rejection (subject too long) does NOT insert row (no reservation leak)', async () => {
    const { deps, repo } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    await proxySubmitBroadcast(deps, {
      ...baseInput,
      subject: 'x'.repeat(201),
    });
    expect(repo.inserted).toHaveLength(0);
  });

  // ---- Server error catch-all -----------------------------------

  it('repo throw inside withTx โ’ submit.server_error', async () => {
    const { deps } = makeDeps({
      primaryContact: 'm-target@example.com',
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const wrapped: BroadcastsRepo = {
      ...deps.broadcastsRepo,
      async withTx() {
        throw new Error('db down');
      },
    };
    const result = await proxySubmitBroadcast(
      { ...deps, broadcastsRepo: wrapped },
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('submit.server_error');
    }
  });

  // ---- Existence probe doesn't gate (delegate handles existence) --

  it('proxy probe returns null but bridge.recipients still resolve โ’ delegate fails on missing primary contact', async () => {
    // Even when getMemberPrimaryContact returns null at the probe, the
    // delegate (submit-broadcast) re-checks and emits the right error.
    // memberExistsInTenant is true (default) so proxy-submit doesn't
    // short-circuit; submit-broadcast surfaces the precondition (j) error.
    const { deps } = makeDeps({
      primaryContact: null,
      recipients: [
        { memberId: 'm-other', primaryContactEmail: 'other@example.com' },
      ],
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe(
        'broadcast_member_missing_primary_contact_email',
      );
    }
  });

  // ---- Round-5 R5-T โ€” memberExistsInTenant short-circuits ----------

  it('F7.1-HIGHC โ€” memberExistsInTenant returns false โ’ broadcast_member_not_found', async () => {
    const { deps } = makeDeps({
      memberExists: false,
      primaryContact: 'doesnt@matter.com',
    });
    const result = await proxySubmitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_member_not_found');
      if (result.error.kind === 'broadcast_member_not_found') {
        expect(result.error.memberId).toBe(baseInput.proxiedMemberId);
      }
    }
  });

  it('R5-S2 โ€” memberExistsInTenant throws (Neon outage) โ’ submit.server_error', async () => {
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      recipients: [{ memberId: 'm-1', primaryContactEmail: 'r@example.com' }],
    });
    // Override the bridge to throw, simulating a repo.unexpected
    // error rethrown from the bridge after R5-S2.
    const throwingDeps = {
      ...deps,
      membersBridge: {
        ...deps.membersBridge,
        async memberExistsInTenant(): Promise<boolean> {
          throw new Error('members-bridge.memberExistsInTenant: repo.unexpected');
        },
      },
    };
    const result = await proxySubmitBroadcast(throwingDeps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('submit.server_error');
    }
  });
});
