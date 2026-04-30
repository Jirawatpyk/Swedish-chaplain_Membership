/**
 * Wave 6b — Unit tests for `save-draft.ts` Application use-case.
 *
 * Covers FR-001 (multi-draft per member, no quota reservation) +
 * FR-004 (audit broadcast_drafted on create only, NOT on edit) +
 * Q3 immutable-after-submit (update rejects non-draft status).
 *
 * Strategy: Dependency-injected port mocks, similar to submit-broadcast
 * tests. Exercises every branch in save-draft.ts.
 */
import { describe, expect, it } from 'vitest';
import { saveDraft } from '@/modules/broadcasts';
import { dompurifySanitizer } from '@/modules/broadcasts/infrastructure/sanitizer/dompurify-sanitizer';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';
import type {
  BroadcastsRepo,
  NewBroadcastDraftInput,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';

const tenant: TenantContext = asTenantContext('test-tenant');
const FROZEN_NOW = new Date('2026-06-15T05:00:00Z');

interface FixtureOpts {
  readonly primaryContact?: string | null;
  readonly existingDraft?: Pick<Broadcast, 'broadcastId' | 'status'> | null;
  readonly insertThrows?: boolean;
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
    createdAt: FROZEN_NOW,
    updatedAt: FROZEN_NOW,
  };
}

interface BroadcastsRepoStub extends BroadcastsRepo {
  readonly inserted: Array<NewBroadcastDraftInput>;
  readonly updates: Array<{ broadcastId: string; patch: unknown }>;
}

function makeBroadcastsRepo(opts: FixtureOpts = {}): BroadcastsRepoStub {
  const inserted: Array<NewBroadcastDraftInput> = [];
  const updates: Array<{ broadcastId: string; patch: unknown }> = [];
  return {
    inserted,
    updates,
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(null);
    },
    async insertDraft(_tx, input): Promise<Broadcast> {
      if (opts.insertThrows) {
        throw new Error('database connection lost');
      }
      inserted.push(input);
      return makeBroadcast(input);
    },
    async updateDraft(_tx, _t, broadcastId, patch): Promise<Broadcast> {
      updates.push({ broadcastId: broadcastId as string, patch });
      const synthetic: NewBroadcastDraftInput = {
        tenantId: tenant.slug,
        broadcastId,
        requestedByMemberId: 'm-1',
        requestedByMemberPlanIdSnapshot: 'p',
        submittedByUserId: 'u-1',
        actorRole: 'member_self_service',
        subject: 'Updated',
        bodyHtml: '<p>updated</p>',
        bodySource: 'updated',
        fromName: 'Test Chamber',
        replyToEmail: 'me@example.com',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        estimatedRecipientCount: 0,
        scheduledFor: null,
      };
      return makeBroadcast(synthetic);
    },
    async findById() {
      return null;
    },
    async findByIdInTx(_tx, _t, broadcastId): Promise<Broadcast | null> {
      if (opts.existingDraft === null || opts.existingDraft === undefined) {
        return null;
      }
      return {
        ...makeBroadcast({
          tenantId: tenant.slug,
          broadcastId,
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
          scheduledFor: null,
        }),
        status: opts.existingDraft.status,
      };
    },
    async lockForUpdate() {
      return null;
    },
    async applyTransition() {
      throw new Error('not used in save-draft tests');
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
  };
}

function makeMembersBridge(opts: FixtureOpts = {}): MembersBridgePort {
  return {
    async getMembersBySegment() {
      return [];
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
      return [];
    },
    async setMemberHalt() {
      return { ok: true, value: undefined };
    },
    async memberExistsInTenant() { return true; },
    async markBroadcastsAcknowledged() {
      return { ok: true, value: undefined };
    },
  };
}

function makeAudit(): {
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
    },
  };
}

function makeDeps(opts: FixtureOpts = {}) {
  const audit = makeAudit();
  const broadcastsRepo = makeBroadcastsRepo(opts);
  return {
    audit,
    broadcastsRepo,
    deps: {
      tenant,
      broadcastsRepo,
      sanitizer: dompurifySanitizer,
      membersBridge: makeMembersBridge(opts),
      audit: audit.port,
      clock: { now: () => FROZEN_NOW },
    },
  };
}

const baseInput = {
  memberId: 'm-1',
  submittedByUserId: 'u-1',
  actorRole: 'member_self_service' as const,
  memberPlanIdSnapshot: 'plan-2026',
  tenantDisplayName: 'Test Chamber',
  subject: 'Welcome',
  bodySource: 'plain',
  bodyHtml: '<p>Hello</p>',
  segmentType: 'all_members' as const,
  segmentParams: null,
  customRecipientEmails: null,
  scheduledFor: null,
  requestId: 'req-test',
};

describe('save-draft — Wave 6b coverage push', () => {
  // ---- Happy path: create new draft ---------------------------------

  it('happy path create: inserts new broadcast row + emits broadcast_drafted audit', async () => {
    const { audit, broadcastsRepo, deps } = makeDeps({
      primaryContact: 'me@example.com',
    });
    const result = await saveDraft(deps, baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.created).toBe(true);
      expect(result.value.broadcast.subject).toBe('Welcome');
    }
    expect(broadcastsRepo.inserted).toHaveLength(1);
    expect(
      audit.emits.find((e) => e.eventType === 'broadcast_drafted'),
    ).toBeDefined();
  });

  // ---- Update existing draft (FR-004 — no audit on edit) -------------

  it('update existing draft: calls updateDraft + does NOT emit audit', async () => {
    const { audit, broadcastsRepo, deps } = makeDeps({
      primaryContact: 'me@example.com',
      existingDraft: {
        broadcastId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as never,
        status: 'draft',
      },
    });
    const result = await saveDraft(deps, {
      ...baseInput,
      draftId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.created).toBe(false);
    }
    expect(broadcastsRepo.updates).toHaveLength(1);
    expect(audit.emits).toHaveLength(0);
  });

  // ---- Subject validation -------------------------------------------

  it('rejects empty subject with broadcast_subject_empty', async () => {
    const { deps } = makeDeps({ primaryContact: 'me@example.com' });
    const result = await saveDraft(deps, { ...baseInput, subject: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_subject_empty');
    }
  });

  it('rejects subject > 200 chars with broadcast_subject_too_long', async () => {
    const { deps } = makeDeps({ primaryContact: 'me@example.com' });
    const result = await saveDraft(deps, {
      ...baseInput,
      subject: 'a'.repeat(201),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_subject_too_long');
    }
  });

  // ---- Body sanitiser -----------------------------------------------

  it('rejects body that sanitises to empty (broadcast_body_unsafe_html)', async () => {
    const { deps } = makeDeps({ primaryContact: 'me@example.com' });
    const result = await saveDraft(deps, {
      ...baseInput,
      bodyHtml: '<script>alert(1)</script>',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_body_unsafe_html');
    }
  });

  it('rejects body > 200 KB (broadcast_body_too_large)', async () => {
    const { deps } = makeDeps({ primaryContact: 'me@example.com' });
    const huge = '<p>' + 'a'.repeat(201 * 1024) + '</p>';
    const result = await saveDraft(deps, { ...baseInput, bodyHtml: huge });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_body_too_large');
    }
  });

  it('persists sanitised body (raw never reaches DB)', async () => {
    const { broadcastsRepo, deps } = makeDeps({
      primaryContact: 'me@example.com',
    });
    await saveDraft(deps, {
      ...baseInput,
      bodyHtml: '<p>safe</p><script>alert(1)</script>',
    });
    expect(broadcastsRepo.inserted[0]!.bodyHtml).not.toContain('<script>');
    expect(broadcastsRepo.inserted[0]!.bodyHtml).toContain('<p>safe</p>');
  });

  // ---- Reply-to derivation ------------------------------------------

  it('rejects when member has no primary contact email', async () => {
    const { deps } = makeDeps({ primaryContact: null });
    const result = await saveDraft(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe(
        'broadcast_member_missing_primary_contact_email',
      );
    }
  });

  // ---- Update path edge cases ---------------------------------------

  it('update with non-existent draftId → broadcast_not_found', async () => {
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      existingDraft: null,
    });
    const result = await saveDraft(deps, {
      ...baseInput,
      draftId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_not_found');
    }
  });

  it('update existing non-draft (already submitted) → broadcast_immutable_after_submit', async () => {
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      existingDraft: {
        broadcastId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as never,
        status: 'submitted',
      },
    });
    const result = await saveDraft(deps, {
      ...baseInput,
      draftId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_immutable_after_submit');
    }
  });

  // ---- Server error fall-through ------------------------------------

  it('repo throw inside withTx → save_draft.server_error', async () => {
    const { deps } = makeDeps({
      primaryContact: 'me@example.com',
      insertThrows: true,
    });
    const result = await saveDraft(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('save_draft.server_error');
      if (result.error.kind === 'save_draft.server_error') {
        expect(result.error.message).toContain('database connection lost');
      }
    }
  });

  it('repo throw with non-Error value → save_draft.server_error with "unknown error"', async () => {
    const { deps } = makeDeps({ primaryContact: 'me@example.com' });
    const repo = deps.broadcastsRepo as unknown as {
      insertDraft: BroadcastsRepo['insertDraft'];
    };
    repo.insertDraft = async () => {
      throw 'plain-string';
    };
    const result = await saveDraft(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'save_draft.server_error') {
      expect(result.error.message).toBe('unknown error');
    }
  });

  // ---- Field passthrough --------------------------------------------

  it('passes scheduledFor + segmentParams + customRecipientEmails through to repo', async () => {
    const { broadcastsRepo, deps } = makeDeps({
      primaryContact: 'me@example.com',
    });
    const future = new Date('2026-12-31T10:00:00Z');
    await saveDraft(deps, {
      ...baseInput,
      segmentType: 'tier',
      segmentParams: { tierCodes: ['premium'] },
      customRecipientEmails: null,
      scheduledFor: future,
    });
    expect(broadcastsRepo.inserted[0]!.segmentType).toBe('tier');
    expect(broadcastsRepo.inserted[0]!.segmentParams).toEqual({
      tierCodes: ['premium'],
    });
    expect(broadcastsRepo.inserted[0]!.scheduledFor).toEqual(future);
  });
});
