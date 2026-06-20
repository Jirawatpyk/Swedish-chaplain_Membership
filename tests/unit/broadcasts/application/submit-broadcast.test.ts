/**
 * T045 โ€” Unit tests for `submit-broadcast.ts` Application use-case.
 *
 * **100% branch coverage required** per Constitution Principle II
 * (security-critical: every FR-002 precondition aโ€“k surfaces a typed
 * error code + audit emission + reservation rollback).
 *
 * Wave 6 fills the bodies. Strategy: hand-built mocks for every Port
 * dependency that the use-case takes as a Deps argument. The
 * use-case is fully Dependency-Injected so vi.mock is unnecessary.
 *
 * Coverage targets every branch in `submit-broadcast.ts`:
 *   1. Halt-flag (k) โ€” emits audit + returns broadcast_member_halted_pending_review
 *   2. Rate limit (FR-002d) โ€” emits audit + returns broadcast_rate_limit_exceeded
 *   3. Plan check (a)
 *   4. Quota check (b) โ€” enforced for all actor roles incl admin_proxy (T-10)
 *   5. Reply-to (j)
 *   6. Subject length (c) โ€” empty + too-long
 *   7. Sanitiser (e + d)
 *   8. Custom-list validation (h)
 *   9. Segment resolve (f + g + i)
 *  10. Atomic insert/transition/audit
 *  11. Server error fall-through
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { submitBroadcast } from '@/modules/broadcasts';
import { ok, err } from '@/lib/result';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
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
import type {
  MemberHaltSummary,
  MembersBridgePort,
} from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { PlansBridgePort } from '@/modules/broadcasts/application/ports/plans-bridge-port';
import type { EventAttendeesRepository } from '@/modules/broadcasts/application/ports/event-attendees-repository';
import type { MarketingUnsubscribesRepo } from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';
import type { RateLimiterPort } from '@/modules/broadcasts/application/ports/rate-limiter-port';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import type { SubmitBroadcastInput } from '@/modules/broadcasts/application/use-cases/submit-broadcast';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/submit-broadcast.ts',
);

const tenant: TenantContext = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

interface FixtureOpts {
  readonly halted?: ReadonlyArray<string>;
  readonly rateLimit?: { allow: boolean; retryAfterSeconds?: number };
  readonly planCap?: number;
  readonly planFound?: boolean;
  readonly used?: number;
  readonly reserved?: number;
  readonly primaryContact?: string | null;
  readonly memberInBridge?: ReadonlyArray<{
    memberId: string;
    primaryContactEmail: string | null;
  }>;
  // R2.1 H-test-1 (FR-022): provenance fields read by submit-broadcast
  // use-case to populate broadcast_submitted audit payload. Wired into
  // makeBroadcast default + applyTransition mock so the submitted
  // event carries the template UUID instead of always null.
  readonly draftRow?: {
    startedFromTemplateId?: string | null;
    templateNameSnapshot?: string | null;
  };
}

function makeAuditEmits(): {
  readonly emits: Array<AuditEmitInput>;
  readonly port: AuditPort;
} {
  const emits: Array<AuditEmitInput> = [];
  return {
    emits,
    port: {
      async emit(_tx, event) {
        emits.push(event);
      },
      async emitTyped(_tx, event) {
        emits.push(event as AuditEmitInput);
      },
    },
  };
}

function makeMembersBridge(opts: FixtureOpts = {}): MembersBridgePort {
  const halted = (opts.halted ?? []).map(
    (memberId): MemberHaltSummary => ({
      memberId,
      displayName: memberId,
      haltedSinceBroadcastId: '',
      haltedSinceAt: new Date(),
    }),
  );
  return {
    async getMembersBySegment() {
      return (opts.memberInBridge ?? []).map((m) => ({
        memberId: m.memberId,
        displayName: m.memberId,
        primaryContactEmail:
          m.primaryContactEmail !== null
            ? unsafeBrandEmailLower(m.primaryContactEmail)
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
      return halted;
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

function makePlansBridge(opts: FixtureOpts = {}): PlansBridgePort {
  return {
    async getPlanForMember(_ctx, memberId) {
      if (opts.planFound === false) {
        return err({ kind: 'plan_lookup.member_not_found', memberId });
      }
      return ok({
        planId: 'premium-corporate-2026',
        planCode: 'corporate',
        eblastPerYear: opts.planCap ?? 6,
      });
    },
  };
}

interface BroadcastsRepoStub extends BroadcastsRepo {
  readonly inserted: Array<NewBroadcastDraftInput>;
  readonly transitions: Array<{ broadcastId: string; status: string }>;
}

function makeBroadcastsRepo(opts: FixtureOpts = {}): BroadcastsRepoStub {
  const inserted: Array<NewBroadcastDraftInput> = [];
  const transitions: Array<{ broadcastId: string; status: string }> = [];
  return {
    inserted,
    transitions,
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(null);
    },
    async insertDraft(_tx, input): Promise<Broadcast> {
      inserted.push(input);
      // R6.1 H2 — raw fields no longer on `Broadcast`; fixture only
      // sets the canonical `templateProvenance` discriminant. Source
      // of truth is the test's `draftRow` input pair below.
      return {
        ...makeBroadcast(input),
        templateProvenance:
          opts.draftRow?.startedFromTemplateId != null &&
          opts.draftRow?.templateNameSnapshot != null
            ? {
                templateId: opts.draftRow.startedFromTemplateId,
                templateNameSnapshot: opts.draftRow.templateNameSnapshot,
              }
            : null,
      };
    },
    async updateDraft() {
      throw new Error('not used in submit happy path (no existing draft)');
    },
    async updateDraftFromTemplate() {
      throw new Error('not used in submit-broadcast fixture');
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
    async applyTransition(_tx, tenantId, broadcastId, status, _fields): Promise<Broadcast> {
      transitions.push({ broadcastId: broadcastId as string, status });
      const lastInsert = inserted[inserted.length - 1];
      // Existing-draft path: caller never invoked insertDraft. Synthesise
      // a minimal Broadcast row so the use-case's downstream audit emit
      // has a valid object to operate on.
      const base: NewBroadcastDraftInput = lastInsert ?? {
        tenantId,
        broadcastId,
        requestedByMemberId: 'm-1',
        requestedByMemberPlanIdSnapshot: 'p',
        submittedByUserId: 'u-1',
        actorRole: 'member_self_service',
        subject: 'Welcome',
        bodyHtml: '<p>Hello</p>',
        bodySource: 'plain',
        fromName: 'Test Chamber',
        replyToEmail: 'me@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 0,
        scheduledFor: null,
      };
      // R6.1 H2 — see `insertDraft` sibling block.
      return {
        ...makeBroadcast(base),
        status,
        templateProvenance:
          opts.draftRow?.startedFromTemplateId != null &&
          opts.draftRow?.templateNameSnapshot != null
            ? {
                templateId: opts.draftRow.startedFromTemplateId,
                templateNameSnapshot: opts.draftRow.templateNameSnapshot,
              }
            : null,
      };
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
    // F7.1a US1 + US7 defaults (Phase 2 + 3 B0).
    manualRetryCount: 0,
    partialDeliveryAcceptedAt: null,
    partialDeliveryAcceptedByUserId: null,
    templateProvenance: null,
    createdAt: FROZEN_NOW,
    updatedAt: FROZEN_NOW,
  };
}

function makeRateLimiter({
  allow = true,
  retryAfterSeconds = 60,
}: {
  readonly allow?: boolean;
  readonly retryAfterSeconds?: number;
} = {}): RateLimiterPort {
  return {
    async checkLimit(key) {
      if (allow) return ok(true);
      return err({
        kind: 'rate_limit_exceeded',
        retryAfterSeconds,
        key,
      });
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

function makeDeps(opts: FixtureOpts = {}, allowRateLimit = true) {
  const audit = makeAuditEmits();
  const broadcastsRepo = makeBroadcastsRepo(opts);
  return {
    audit,
    broadcastsRepo,
    deps: {
      tenant,
      broadcastsRepo,
      sanitizer: dompurifySanitizer,
      membersBridge: makeMembersBridge(opts),
      plansBridge: makePlansBridge(opts),
      emailValidator: rfc5321EmailValidator,
      eventAttendees: makeEventAttendees(),
      marketingUnsubscribes: makeMarketingUnsubscribes(),
      rateLimiter: makeRateLimiter({
        allow: opts.rateLimit?.allow ?? allowRateLimit,
        retryAfterSeconds: opts.rateLimit?.retryAfterSeconds ?? 60,
      }),
      audit: audit.port,
      clock: { now: () => FROZEN_NOW },
    },
  };
}

const baseInput: SubmitBroadcastInput = {
  memberId: 'm-1',
  submittedByUserId: 'u-1',
  actorRole: 'member_self_service',
  tenantDisplayName: 'Test Chamber',
  memberDisplayName: 'Acme Co',
  subject: 'Welcome',
  bodySource: 'plain',
  bodyHtml: '<p>Hello world</p>',
  segment: { kind: 'all_members' },
  scheduledFor: null,
  requestId: 'req-test',
};

beforeEach(() => {
  vi.useFakeTimers({ now: FROZEN_NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('submit-broadcast โ€” Wave 6 (T069 GREEN โ€” 100% branch)', () => {
  it('use-case module exists at application/use-cases/submit-broadcast.ts', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // ---- FR-002 precondition (k) โ€” halt flag --------------------------

  it('precondition (k) member halted (R3-NEW-1) โ’ broadcast_member_halted_pending_review', async () => {
    const { audit, deps } = makeDeps({
      halted: ['m-1'],
      primaryContact: 'me@example.com',
      memberInBridge: [{ memberId: 'm-2', primaryContactEmail: 'p@example.com' }],
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_member_halted_pending_review');
    }
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_member_halted_pending_review'),
    ).toBeDefined();
  });

  // ---- FR-002d โ€” rate limit -----------------------------------------

  it('rate limit hit (10/24h) โ’ broadcast_rate_limit_exceeded', async () => {
    const { audit, deps } = makeDeps({
      rateLimit: { allow: false, retryAfterSeconds: 120 },
      primaryContact: 'me@example.com',
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_rate_limit_exceeded');
      if (result.error.kind === 'broadcast_rate_limit_exceeded') {
        expect(result.error.retryAfterSeconds).toBe(120);
      }
    }
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_rate_limit_exceeded'),
    ).toBeDefined();
  });

  // ---- FR-002 precondition (a) โ€” plan -------------------------------

  it('precondition (a) member plan does NOT include broadcasts โ’ broadcast_not_in_plan', async () => {
    const { audit, deps } = makeDeps({
      planFound: false,
      primaryContact: 'me@example.com',
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_not_in_plan');
    }
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_not_in_plan'),
    ).toBeDefined();
  });

  // ---- FR-002 precondition (b) โ€” quota ------------------------------

  it('precondition (b) quota exhausted โ’ broadcast_quota_blocked', async () => {
    const { audit, deps } = makeDeps({
      planCap: 6,
      used: 6,
      reserved: 0,
      primaryContact: 'me@example.com',
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_quota_blocked');
      if (result.error.kind === 'broadcast_quota_blocked') {
        expect(result.error.cap).toBe(6);
      }
    }
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_quota_blocked'),
    ).toBeDefined();
  });

  it('admin_proxy at full quota is BLOCKED (T-10 — admin cannot bypass the member cap per Q12)', async () => {
    const { audit, deps } = makeDeps({
      planCap: 6,
      used: 6,
      reserved: 0,
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'recipient@example.com' },
      ],
    });
    const result = await submitBroadcast(deps, {
      ...baseInput,
      actorRole: 'admin_proxy',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_quota_blocked');
      if (result.error.kind === 'broadcast_quota_blocked') {
        expect(result.error.cap).toBe(6);
      }
    }
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_quota_blocked'),
    ).toBeDefined();
  });

  // ---- FR-002 precondition (j) โ€” reply-to ---------------------------

  it('precondition (j) reply-to derivation fails (no primary contact) โ’ broadcast_member_missing_primary_contact_email', async () => {
    const { audit, deps } = makeDeps({
      primaryContact: null,
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe(
        'broadcast_member_missing_primary_contact_email',
      );
    }
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_member_missing_primary_contact_email',
      ),
    ).toBeDefined();
  });

  // ---- FR-002 precondition (c) โ€” subject ----------------------------

  it('precondition (c) subject too long (> 200 chars) โ’ broadcast_subject_too_long', async () => {
    const { audit, deps } = makeDeps({ primaryContact: 'me@example.com' });
    const tooLong = 'a'.repeat(201);
    const result = await submitBroadcast(deps, {
      ...baseInput,
      subject: tooLong,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_subject_too_long');
    }
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_subject_too_long'),
    ).toBeDefined();
  });

  it('subject empty / whitespace-only โ’ broadcast_subject_empty', async () => {
    const { audit, deps } = makeDeps({ primaryContact: 'me@example.com' });
    const result = await submitBroadcast(deps, {
      ...baseInput,
      subject: '   ',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_subject_empty');
    }
    // R6 W-R3 — audit event type now matches the Result kind.
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_subject_empty'),
    ).toBeDefined();
  });

  // R6 staff-review W-T6 fix — subject-length boundary tests. The
  // pre-fix suite tested 201 (rejected) but not the boundary at
  // exactly 200 (should pass). An off-by-one regression that flipped
  // the predicate from `> 200` to `>= 200` would not have been
  // caught.
  it('subject boundary: exactly 200 chars → subject preconditions never emit (audit-positive pin)', async () => {
    const { audit, deps } = makeDeps({ primaryContact: 'me@example.com' });
    const exact = 'a'.repeat(200);
    const result = await submitBroadcast(deps, {
      ...baseInput,
      subject: exact,
    });
    // R8 staff-review R8-T1 fix — replaced the conditional `if
    // (!result.ok) { ... }` (which silently no-op'd if `result.ok===true`,
    // failing to pin anything) with positive AUDIT assertions:
    // neither `broadcast_subject_too_long` NOR `broadcast_subject_empty`
    // audit may emit at the 200-char boundary. This test does NOT
    // assert `result.ok===true` because downstream preconditions
    // (rate-limit, member lookup, segment resolve) depend on wider
    // fixture state and aren't the subject-length contract under
    // test. The audit-positive pin guarantees that even if some
    // downstream precondition fails, the subject preconditions did
    // NOT fire.
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_subject_too_long'),
    ).toBeUndefined();
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_subject_empty'),
    ).toBeUndefined();
    // Defence-in-depth: if result.ok is false, kind must NOT be
    // either subject-length kind.
    if (!result.ok) {
      expect(result.error.kind).not.toBe('broadcast_subject_too_long');
      expect(result.error.kind).not.toBe('broadcast_subject_empty');
    }
  });

  it('subject boundary: 201 chars → broadcast_subject_too_long', async () => {
    const { deps } = makeDeps({ primaryContact: 'me@example.com' });
    const justOver = 'a'.repeat(201);
    const result = await submitBroadcast(deps, {
      ...baseInput,
      subject: justOver,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_subject_too_long');
    }
  });

  // ---- FR-002 preconditions (d, e) โ€” body sanitiser -----------------

  it('precondition (e) body sanitised to empty โ’ broadcast_body_unsafe_html', async () => {
    const { deps } = makeDeps({ primaryContact: 'me@example.com' });
    const result = await submitBroadcast(deps, {
      ...baseInput,
      bodyHtml: '<script>alert(1)</script>', // strips to empty
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_body_unsafe_html');
    }
  });

  it('precondition (d) body > 200 KB โ’ broadcast_body_too_large', async () => {
    const { deps } = makeDeps({ primaryContact: 'me@example.com' });
    const huge = '<p>' + 'a'.repeat(201 * 1024) + '</p>';
    const result = await submitBroadcast(deps, { ...baseInput, bodyHtml: huge });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_body_too_large');
    }
  });

  // ---- FR-002 precondition (h) โ€” custom-list validation -------------

  it('precondition (h) custom list has unknown emails โ’ broadcast_custom_recipient_unknown', async () => {
    const { audit, deps } = makeDeps({ primaryContact: 'me@example.com' });
    const result = await submitBroadcast(deps, {
      ...baseInput,
      segment: { kind: 'custom', emails: ['unknown@example.com'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_custom_recipient_unknown');
    }
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_custom_recipient_unknown',
      ),
    ).toBeDefined();
  });

  // ---- FR-002 preconditions (f, g, i) โ€” segment resolve --------------

  it('precondition (f) segment resolves to 0 recipients โ’ broadcast_empty_segment_blocked', async () => {
    const { audit, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [],
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_empty_segment_blocked');
    }
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_empty_segment_blocked'),
    ).toBeDefined();
  });

  it('precondition (g) audience > 5,000 โ’ broadcast_audience_too_large', async () => {
    const memberInBridge = Array.from({ length: 5001 }, (_, i) => ({
      memberId: `m-${i + 100}`,
      primaryContactEmail: `r${i}@example.com`,
    }));
    const { audit, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge,
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_audience_too_large');
    }
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_audience_too_large'),
    ).toBeDefined();
  });

  it('precondition (i) member missing primary contact email โ’ orphan emit (non-blocking)', async () => {
    const { audit, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-orphan', primaryContactEmail: null },
        { memberId: 'm-good', primaryContactEmail: 'r@example.com' },
      ],
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(true);
    expect(
      audit.emits.find(
        (e) => e.eventType === 'broadcast_member_missing_primary_contact_email',
      ),
    ).toBeDefined();
  });

  // ---- Happy path + atomicity ---------------------------------------

  it('happy path: all preconditions pass โ’ row inserted with status=submitted + reservation derived', async () => {
    const { broadcastsRepo, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.estimatedRecipientCount).toBe(1);
      expect(result.value.reservedQuotaSlot).toBe(true);
      expect(result.value.reviewSlaTargetHours).toBe(48);
    }
    expect(broadcastsRepo.inserted.length).toBe(1);
    expect(broadcastsRepo.transitions).toEqual([
      { broadcastId: result.ok ? result.value.broadcastId : '', status: 'submitted' },
    ]);
  });

  it('happy path: audit emit broadcast_submitted with actor_role + member_id + segment_type + estimated_count', async () => {
    const { audit, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    await submitBroadcast(deps, baseInput);
    const submitted = audit.emits.find(
      (e) => e.eventType === 'broadcast_submitted',
    );
    expect(submitted).toBeDefined();
    if (submitted !== undefined) {
      expect(submitted.payload['actorRole']).toBe('member_self_service');
      expect(submitted.payload['memberId']).toBe('m-1');
      expect(submitted.payload['segmentType']).toBe('all_members');
      expect(submitted.payload['estimatedRecipientCount']).toBe(1);
      // R2.1 H-test-1 (FR-022): startedFromTemplateId is always present
      // on broadcast_submitted (null for blank-canvas drafts, the
      // template UUID for snapshotted drafts). Static-shape contract
      // for forensic timeline + downstream analytics filters.
      expect('startedFromTemplateId' in submitted.payload).toBe(true);
      expect(submitted.payload['startedFromTemplateId']).toBeNull();
    }
  });

  it('R2.1 H-test-1: broadcast_submitted.startedFromTemplateId pass-through when draft snapshotted from template', async () => {
    const { audit, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
      // Pre-populate a draft that carries the snapshot provenance —
      // mirrors what snapshotTemplateToDraft would have written.
      draftRow: {
        startedFromTemplateId: '99999999-9999-9999-9999-999999999999',
        templateNameSnapshot: 'Monthly Newsletter',
      },
    });
    await submitBroadcast(deps, baseInput);
    const submitted = audit.emits.find(
      (e) => e.eventType === 'broadcast_submitted',
    );
    expect(submitted).toBeDefined();
    if (submitted !== undefined) {
      expect(submitted.payload['startedFromTemplateId']).toBe(
        '99999999-9999-9999-9999-999999999999',
      );
    }
  });

  // ---- DV-17 from_name composition ("<member> via <tenant>") --------

  it('DV-17 insert path: from_name = "<memberDisplayName> via <tenantDisplayName>"', async () => {
    const { broadcastsRepo, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(true);
    expect(broadcastsRepo.inserted).toHaveLength(1);
    expect(broadcastsRepo.inserted[0]!.fromName).toBe('Acme Co via Test Chamber');
  });

  it('DV-17 update-draft path: from_name = "<memberDisplayName> via <tenantDisplayName>"', async () => {
    const updates: Array<{ patch: Record<string, unknown> }> = [];
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    const draftId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
    const repo = deps.broadcastsRepo as unknown as {
      findByIdInTx: BroadcastsRepo['findByIdInTx'];
      updateDraft: BroadcastsRepo['updateDraft'];
    };
    repo.findByIdInTx = async (_tx, _t, broadcastIdArg) =>
      makeBroadcast({
        tenantId: tenant.slug,
        broadcastId: broadcastIdArg,
        requestedByMemberId: 'm-1',
        requestedByMemberPlanIdSnapshot: 'p',
        submittedByUserId: 'u-1',
        actorRole: 'member_self_service',
        subject: 'old',
        bodyHtml: '<p>old</p>',
        bodySource: 'old',
        fromName: 'stale name',
        replyToEmail: 'me@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 0,
        scheduledFor: null,
      });
    repo.updateDraft = async (_tx, _t, broadcastIdArg, patch) => {
      updates.push({ patch: patch as unknown as Record<string, unknown> });
      return {
        ...makeBroadcast({
          tenantId: tenant.slug,
          broadcastId: broadcastIdArg,
          requestedByMemberId: 'm-1',
          requestedByMemberPlanIdSnapshot: 'p',
          submittedByUserId: 'u-1',
          actorRole: 'member_self_service',
          subject: 'updated',
          bodyHtml: '<p>updated</p>',
          bodySource: 'updated',
          fromName: (patch.fromName as string) ?? 'stale name',
          replyToEmail: 'me@example.com',
          segmentType: 'all_members',
          segmentParams: null,
          customRecipientEmails: null,
          estimatedRecipientCount: 0,
          scheduledFor: null,
        }),
      };
    };

    const result = await submitBroadcast(deps, { ...baseInput, draftId });
    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch['fromName']).toBe('Acme Co via Test Chamber');
  });

  // ---- Sanitiser invocation ------------------------------------------

  it('sanitiser is invoked BEFORE persistence โ€” raw body NEVER stored', async () => {
    const { broadcastsRepo, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    await submitBroadcast(deps, {
      ...baseInput,
      bodyHtml: '<p>safe</p><script>alert(1)</script>',
    });
    expect(broadcastsRepo.inserted.length).toBe(1);
    const inserted = broadcastsRepo.inserted[0];
    expect(inserted!.bodyHtml).not.toContain('<script>');
    expect(inserted!.bodyHtml).not.toContain('alert(1)');
    expect(inserted!.bodyHtml).toContain('<p>safe</p>');
  });

  it('sanitiser deterministic โ€” same input produces same body_html', async () => {
    const ctx1 = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    const ctx2 = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    await submitBroadcast(ctx1.deps, baseInput);
    await submitBroadcast(ctx2.deps, baseInput);
    expect(ctx1.broadcastsRepo.inserted[0]!.bodyHtml).toBe(
      ctx2.broadcastsRepo.inserted[0]!.bodyHtml,
    );
  });

  // ---- Reservation atomicity ----------------------------------------

  it('precondition rejection does NOT insert a row (no reservation leak)', async () => {
    const { broadcastsRepo, deps } = makeDeps({
      planCap: 6,
      used: 6,
      primaryContact: 'me@example.com',
    });
    await submitBroadcast(deps, baseInput);
    expect(broadcastsRepo.inserted.length).toBe(0);
    expect(broadcastsRepo.transitions.length).toBe(0);
  });

  it('row insert atomic with audit emit (same tx)', async () => {
    const { broadcastsRepo, audit, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    await submitBroadcast(deps, baseInput);
    expect(broadcastsRepo.inserted.length).toBe(1);
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_submitted'),
    ).toBeDefined();
  });

  // ---- Admin proxy (Q12 dual-actor) ---------------------------------

  // ---- Audit failure swallowed: emitReject best-effort branch -------

  it('emitReject swallows audit emit failure (best-effort, never 5xx)', async () => {
    const { deps } = makeDeps({
      halted: ['m-1'], // triggers a precondition reject path that calls emitReject
      primaryContact: 'me@example.com',
    });
    // Override the audit port to throw on every emit
    (deps as { audit: AuditPort }).audit = {
      async emit() {
        throw new Error('audit DB unreachable');
      },
      async emitTyped() {
        throw new Error('audit DB unreachable');
      },
    };
    const result = await submitBroadcast(deps, baseInput);
    // Audit failed but the use-case still returned the precondition reject
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_member_halted_pending_review');
    }
  });

  // ---- Quota invariant violation (cap=0 from getPlanForMember) ------

  it('quota lookup returns invariant violation โ’ submit.server_error (round-4 MED-D)', async () => {
    // Round-4 MED-D โ€” counter internal-error (e.g. over-subscription
    // invariant from corrupt state) is NOT "quota full". The use-case
    // now returns `submit.server_error` so the route maps to 500
    // internal_error instead of misleading 422 `quota_blocked`.
    // computeQuotaCounter receives countForMemberQuota with high counts
    // vs small cap โ’ asQuotaCounter rejects with over_subscription
    // invariant.
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      planCap: 6,
      used: 5,
      reserved: 3, // 5+3 > 6 โ’ over_subscription
    });
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('submit.server_error');
    }
  });

  // ---- Branch coverage: existing-draft + tier / custom paths --------

  it('existing-draft + tier segment: updateDraft preserves tier params', async () => {
    const updates: Array<{ patch: Record<string, unknown> }> = [];
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    const draftId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const repo = deps.broadcastsRepo as unknown as {
      findByIdInTx: BroadcastsRepo['findByIdInTx'];
      updateDraft: BroadcastsRepo['updateDraft'];
    };
    repo.findByIdInTx = async (_tx, _t, broadcastIdArg) => ({
      tenantId: tenant.slug,
      broadcastId: broadcastIdArg,
      requestedByMemberId: 'm-1',
      requestedByMemberPlanIdSnapshot: 'p',
      submittedByUserId: 'u-1',
      actorRole: 'member_self_service',
      subject: 'old',
      bodyHtml: '<p>old</p>',
      bodySource: 'old',
      fromName: 'Test Chamber',
      replyToEmail: 'me@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 0,
      status: 'draft',
      submittedAt: null,
      approvedAt: null,
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
      resendBroadcastId: null,
      retentionYears: 5,
      manualRetryCount: 0,
      partialDeliveryAcceptedAt: null,
      partialDeliveryAcceptedByUserId: null,
      startedFromTemplateId: null,
      templateNameSnapshot: null,
      templateProvenance: null,
      createdAt: FROZEN_NOW,
      updatedAt: FROZEN_NOW,
    });
    repo.updateDraft = async (_tx, _t, broadcastIdArg, patch) => {
      updates.push({ patch: patch as unknown as Record<string, unknown> });
      return {
        tenantId: tenant.slug,
        broadcastId: broadcastIdArg,
        requestedByMemberId: 'm-1',
        requestedByMemberPlanIdSnapshot: 'p',
        submittedByUserId: 'u-1',
        actorRole: 'member_self_service',
        subject: 'updated',
        bodyHtml: '<p>updated</p>',
        bodySource: 'updated',
        fromName: 'Test Chamber',
        replyToEmail: 'me@example.com',
        segmentType: patch.segmentType ?? 'all_members',
        segmentParams: (patch.segmentParams ?? null) as Record<string, unknown> | null,
        customRecipientEmails: patch.customRecipientEmails ?? null,
        estimatedRecipientCount: patch.estimatedRecipientCount ?? 0,
        status: 'draft',
        submittedAt: null,
        approvedAt: null,
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
        resendBroadcastId: null,
        retentionYears: 5,
        manualRetryCount: 0,
        partialDeliveryAcceptedAt: null,
        partialDeliveryAcceptedByUserId: null,
        startedFromTemplateId: null,
        templateNameSnapshot: null,
        templateProvenance: null,
        createdAt: FROZEN_NOW,
        updatedAt: FROZEN_NOW,
      };
    };

    const result = await submitBroadcast(deps, {
      ...baseInput,
      draftId,
      segment: { kind: 'tier', tierCodes: ['premium'] },
    });
    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch['segmentType']).toBe('tier');
    expect(updates[0]!.patch['segmentParams']).toEqual({
      tierCodes: ['premium'],
    });
  });

  it('existing-draft + custom segment: updateDraft preserves customRecipientEmails', async () => {
    const updates: Array<{ patch: Record<string, unknown> }> = [];
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
    });
    const bridge = deps.membersBridge as MembersBridgePort & {
      lookupMemberPrimaryContactEmailInTenant: MembersBridgePort['lookupMemberPrimaryContactEmailInTenant'];
    };
    bridge.lookupMemberPrimaryContactEmailInTenant = async (_ctx, emailLower) => ({
      memberId: `m-of-${emailLower}`,
      displayName: 'Found',
      primaryContactEmail: emailLower,
      tierCode: null,
      broadcastsHaltedUntilAdminReview: false,
    });
    const draftId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const repo = deps.broadcastsRepo as unknown as {
      findByIdInTx: BroadcastsRepo['findByIdInTx'];
      updateDraft: BroadcastsRepo['updateDraft'];
    };
    repo.findByIdInTx = async (_tx, _t, broadcastIdArg) => ({
      tenantId: tenant.slug,
      broadcastId: broadcastIdArg,
      requestedByMemberId: 'm-1',
      requestedByMemberPlanIdSnapshot: 'p',
      submittedByUserId: 'u-1',
      actorRole: 'member_self_service',
      subject: 'old',
      bodyHtml: '<p>old</p>',
      bodySource: 'old',
      fromName: 'Test Chamber',
      replyToEmail: 'me@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 0,
      status: 'draft',
      submittedAt: null,
      approvedAt: null,
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
      resendBroadcastId: null,
      retentionYears: 5,
      manualRetryCount: 0,
      partialDeliveryAcceptedAt: null,
      partialDeliveryAcceptedByUserId: null,
      startedFromTemplateId: null,
      templateNameSnapshot: null,
      templateProvenance: null,
      createdAt: FROZEN_NOW,
      updatedAt: FROZEN_NOW,
    });
    repo.updateDraft = async (_tx, _t, broadcastIdArg, patch) => {
      updates.push({ patch: patch as unknown as Record<string, unknown> });
      return {
        tenantId: tenant.slug,
        broadcastId: broadcastIdArg,
        requestedByMemberId: 'm-1',
        requestedByMemberPlanIdSnapshot: 'p',
        submittedByUserId: 'u-1',
        actorRole: 'member_self_service',
        subject: 'updated',
        bodyHtml: '<p>updated</p>',
        bodySource: 'updated',
        fromName: 'Test Chamber',
        replyToEmail: 'me@example.com',
        segmentType: patch.segmentType ?? 'custom',
        segmentParams: null,
        customRecipientEmails: patch.customRecipientEmails ?? null,
        estimatedRecipientCount: patch.estimatedRecipientCount ?? 0,
        status: 'draft',
        submittedAt: null,
        approvedAt: null,
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
        resendBroadcastId: null,
        retentionYears: 5,
        manualRetryCount: 0,
        partialDeliveryAcceptedAt: null,
        partialDeliveryAcceptedByUserId: null,
        startedFromTemplateId: null,
        templateNameSnapshot: null,
        templateProvenance: null,
        createdAt: FROZEN_NOW,
        updatedAt: FROZEN_NOW,
      };
    };

    const result = await submitBroadcast(deps, {
      ...baseInput,
      draftId,
      segment: { kind: 'custom', emails: ['valid@example.com'] },
    });
    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch['customRecipientEmails']).toEqual([
      'valid@example.com',
    ]);
  });

  // ---- Branch coverage: tier + custom segment paths -----------------

  it('tier segment: segmentType + segmentParams persisted with tier codes', async () => {
    const { broadcastsRepo, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    // Override getMembersBySegment so tier filter passes (mock returns the
    // single recipient regardless of tier code in this test fixture)
    const result = await submitBroadcast(deps, {
      ...baseInput,
      segment: { kind: 'tier', tierCodes: ['premium'] },
    });
    expect(result.ok).toBe(true);
    expect(broadcastsRepo.inserted[0]!.segmentType).toBe('tier');
    expect(broadcastsRepo.inserted[0]!.segmentParams).toEqual({
      tierCodes: ['premium'],
    });
  });

  it('custom segment with resolved recipients: customRecipientEmails persisted', async () => {
    // Members bridge needs to resolve the custom email so validate-custom
    // -recipients accepts it.
    const { broadcastsRepo, deps } = makeDeps({
      primaryContact: 'me@example.com',
    });
    const bridge = deps.membersBridge as MembersBridgePort & {
      lookupMemberPrimaryContactEmailInTenant: MembersBridgePort['lookupMemberPrimaryContactEmailInTenant'];
    };
    bridge.lookupMemberPrimaryContactEmailInTenant = async (_ctx, emailLower) => ({
      memberId: `m-of-${emailLower}`,
      displayName: 'Found',
      primaryContactEmail: emailLower,
      tierCode: null,
      broadcastsHaltedUntilAdminReview: false,
    });
    const result = await submitBroadcast(deps, {
      ...baseInput,
      segment: { kind: 'custom', emails: ['valid@example.com'] },
    });
    expect(result.ok).toBe(true);
    expect(broadcastsRepo.inserted[0]!.segmentType).toBe('custom');
    expect(broadcastsRepo.inserted[0]!.customRecipientEmails).toEqual([
      'valid@example.com',
    ]);
  });

  // ---- Existing-draft submit path + server_error fall-through -------

  it('existing-draft submit: updateDraft is called instead of insertDraft', async () => {
    const updates: Array<unknown> = [];
    const { audit, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    const draftId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    // Override findByIdInTx to return an existing draft + record updateDraft calls
    const repo = deps.broadcastsRepo as unknown as {
      findByIdInTx: BroadcastsRepo['findByIdInTx'];
      updateDraft: BroadcastsRepo['updateDraft'];
    };
    repo.findByIdInTx = async (_tx, _t, broadcastIdArg) => ({
      tenantId: tenant.slug,
      broadcastId: broadcastIdArg,
      requestedByMemberId: 'm-1',
      requestedByMemberPlanIdSnapshot: 'p',
      submittedByUserId: 'u-1',
      actorRole: 'member_self_service',
      subject: 'old',
      bodyHtml: '<p>old</p>',
      bodySource: 'old',
      fromName: 'Test Chamber',
      replyToEmail: 'me@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 0,
      status: 'draft',
      submittedAt: null,
      approvedAt: null,
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
      resendBroadcastId: null,
      retentionYears: 5,
      manualRetryCount: 0,
      partialDeliveryAcceptedAt: null,
      partialDeliveryAcceptedByUserId: null,
      startedFromTemplateId: null,
      templateNameSnapshot: null,
      templateProvenance: null,
      createdAt: FROZEN_NOW,
      updatedAt: FROZEN_NOW,
    });
    repo.updateDraft = async (_tx, _t, broadcastIdArg, patch) => {
      updates.push({ broadcastId: broadcastIdArg, patch });
      return {
        tenantId: tenant.slug,
        broadcastId: broadcastIdArg,
        requestedByMemberId: 'm-1',
        requestedByMemberPlanIdSnapshot: 'p',
        submittedByUserId: 'u-1',
        actorRole: 'member_self_service',
        subject: patch.subject ?? 'unchanged',
        bodyHtml: patch.bodyHtml ?? '<p>unchanged</p>',
        bodySource: patch.bodySource ?? '',
        fromName: 'Test Chamber',
        replyToEmail: 'me@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: patch.estimatedRecipientCount ?? 0,
        status: 'draft',
        submittedAt: null,
        approvedAt: null,
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
        resendBroadcastId: null,
        retentionYears: 5,
        manualRetryCount: 0,
        partialDeliveryAcceptedAt: null,
        partialDeliveryAcceptedByUserId: null,
        startedFromTemplateId: null,
        templateNameSnapshot: null,
        templateProvenance: null,
        createdAt: FROZEN_NOW,
        updatedAt: FROZEN_NOW,
      };
    };

    const result = await submitBroadcast(deps, { ...baseInput, draftId });
    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_submitted'),
    ).toBeDefined();
  });

  it('existing-non-draft submit: returns submit.server_error', async () => {
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    const draftId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const repo = deps.broadcastsRepo as unknown as {
      findByIdInTx: BroadcastsRepo['findByIdInTx'];
    };
    repo.findByIdInTx = async (_tx, _t, broadcastIdArg) => ({
      tenantId: tenant.slug,
      broadcastId: broadcastIdArg,
      requestedByMemberId: 'm-1',
      requestedByMemberPlanIdSnapshot: 'p',
      submittedByUserId: 'u-1',
      actorRole: 'member_self_service',
      subject: 'old',
      bodyHtml: '<p>old</p>',
      bodySource: 'old',
      fromName: 'Test Chamber',
      replyToEmail: 'me@example.com',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      estimatedRecipientCount: 0,
      status: 'submitted',
      submittedAt: FROZEN_NOW,
      approvedAt: null,
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
      resendBroadcastId: null,
      retentionYears: 5,
      manualRetryCount: 0,
      partialDeliveryAcceptedAt: null,
      partialDeliveryAcceptedByUserId: null,
      startedFromTemplateId: null,
      templateNameSnapshot: null,
      templateProvenance: null,
      createdAt: FROZEN_NOW,
      updatedAt: FROZEN_NOW,
    });
    const result = await submitBroadcast(deps, { ...baseInput, draftId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('submit.server_error');
    }
  });

  it('repo throw inside withTx โ’ submit.server_error', async () => {
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    const repo = deps.broadcastsRepo as unknown as {
      insertDraft: BroadcastsRepo['insertDraft'];
    };
    repo.insertDraft = async () => {
      throw new Error('database connection lost');
    };
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('submit.server_error');
      if (result.error.kind === 'submit.server_error') {
        expect(result.error.message).toContain('database connection lost');
      }
    }
  });

  it('repo throw with non-Error value โ’ submit.server_error with "unknown error" message', async () => {
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    const repo = deps.broadcastsRepo as unknown as {
      insertDraft: BroadcastsRepo['insertDraft'];
    };
    repo.insertDraft = async () => {
      // Throw a non-Error value (string) to exercise the fallback branch
      // in `e instanceof Error ? e.message : 'unknown error'`.
      throw 'plain-string-thrown';
    };
    const result = await submitBroadcast(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('submit.server_error');
      if (result.error.kind === 'submit.server_error') {
        expect(result.error.message).toBe('unknown error');
      }
    }
  });

  it('admin_proxy: requested_by_member_id != submitted_by_user_id; both recorded', async () => {
    const { broadcastsRepo, audit, deps } = makeDeps({
      primaryContact: 'me@example.com',
      memberInBridge: [
        { memberId: 'm-2', primaryContactEmail: 'r@example.com' },
      ],
    });
    await submitBroadcast(deps, {
      ...baseInput,
      memberId: 'm-1',
      submittedByUserId: 'admin-99',
      actorRole: 'admin_proxy',
    });
    expect(broadcastsRepo.inserted[0]!.requestedByMemberId).toBe('m-1');
    expect(broadcastsRepo.inserted[0]!.submittedByUserId).toBe('admin-99');
    expect(broadcastsRepo.inserted[0]!.actorRole).toBe('admin_proxy');
    const submitted = audit.emits.find(
      (e) => e.eventType === 'broadcast_submitted',
    );
    expect(submitted!.payload['actorRole']).toBe('admin_proxy');
  });
});

// Ensure ts-tooling consumes asBroadcastId from import (treeshake guard).
void asBroadcastId;
