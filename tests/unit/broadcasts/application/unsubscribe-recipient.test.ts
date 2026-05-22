/**
 * T137 — Unit tests for `unsubscribe-recipient.ts` Application use-case
 * (F7 US4).
 *
 * Covers:
 *   - Happy-path first unsubscribe: row inserted, member resolved,
 *     `broadcast_unsubscribed` + `broadcast_suppression_applied` audits emitted.
 *   - Idempotent replay: second click returns `wasNew: false`, no
 *     duplicate audit emit (FR-030).
 *   - Tenant-mismatch guard: deps.tenant ≠ input.tenantId returns
 *     `unsubscribe.tenant_mismatch` and never touches the repo.
 *   - Repo error surfaces: `marketingUnsubscribes.upsert` throws →
 *     `unsubscribe.repo_error`.
 *   - Member resolution best-effort: `lookupMemberPrimaryContactEmailInTenant`
 *     throws → row still inserted with memberId=null + audit still emitted.
 *   - Broadcast lookup best-effort: `findByIdInTx` throws → row still
 *     inserted with `sourceBroadcastId=null` + audit still emitted.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  unsubscribeRecipient,
  type UnsubscribeRecipientDeps,
} from '@/modules/broadcasts/application/use-cases/unsubscribe-recipient';
import { asTenantContext, unsafeBrandTenantSlug } from '@/modules/tenants';
import {
  asBroadcastId,
  type Broadcast,
} from '@/modules/broadcasts/domain/broadcast';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type {
  BroadcastsRepo,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type {
  MarketingUnsubscribesRepo,
} from '@/modules/broadcasts/application/ports/marketing-unsubscribes-repo';
import type { MembersBridgePort } from '@/modules/broadcasts/application/ports/members-bridge-port';

const TENANT_SLUG = unsafeBrandTenantSlug('test-tenant');
const OTHER_TENANT = unsafeBrandTenantSlug('other-tenant');
const tenantCtx = asTenantContext(TENANT_SLUG);
const broadcastId = asBroadcastId('33333333-3333-3333-3333-333333333333');
const recipient = unsafeBrandEmailLower('alice@example.com');

function frozenClock() {
  return { now: () => new Date('2026-05-01T10:00:00Z') };
}

function makeDeps(
  overrides: Partial<UnsubscribeRecipientDeps> = {},
): UnsubscribeRecipientDeps {
  const upsertSpy = vi.fn().mockResolvedValue({
    wasNew: true,
    suppression: {
      tenantId: TENANT_SLUG,
      emailLower: recipient,
      memberId: 'mem-1',
      reason: 'recipient_initiated',
      reasonText: null,
      sourceBroadcastId: broadcastId,
      sourceTokenHash: 'abc',
      unsubscribedAt: new Date('2026-05-01T10:00:00Z'),
    },
  });
  const auditEmit = vi.fn().mockResolvedValue(undefined);

  const broadcast: Broadcast = {
    tenantId: TENANT_SLUG,
    broadcastId,
    requestedByMemberId: 'mem-1',
    requestedByMemberPlanIdSnapshot: 'plan-snap',
    submittedByUserId: 'usr-1',
    actorRole: 'member_self_service',
    subject: 'subj',
    bodyHtml: '<p>x</p>',
    bodySource: 'x',
    fromName: 'X',
    replyToEmail: 'x@example.com',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 5,
    status: 'sent',
    submittedAt: new Date(),
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
    // R4.1 C-4 — R3.3 H-4 made templateProvenance REQUIRED on
    // Broadcast. This literal carries `as unknown as Broadcast` so
    // the compile-time check is bypassed; add the field by hand to
    // keep production-vs-test shape aligned.
    templateProvenance: null,
  } as unknown as Broadcast;

  const broadcastsRepo: Partial<BroadcastsRepo> = {
    withTx: vi.fn(async (fn) => fn({ tx: 'fake' } as unknown)),
    findByIdInTx: vi.fn().mockResolvedValue(broadcast),
  };

  const marketingUnsubscribes: Partial<MarketingUnsubscribesRepo> = {
    upsert: upsertSpy,
  };

  const membersBridge: Partial<MembersBridgePort> = {
    lookupMemberPrimaryContactEmailInTenant: vi.fn().mockResolvedValue({
      memberId: 'mem-1',
      displayName: 'Alice',
      primaryContactEmail: recipient,
      tierCode: 'premium',
      broadcastsHaltedUntilAdminReview: false,
    }),
  };

  const audit: AuditPort = {
    emit: auditEmit,
    // R6.2 H1 — typed emit pass-through; tests assert on auditEmit.calls
    // regardless of which method the use-case invokes.
    emitTyped: auditEmit as unknown as AuditPort['emitTyped'],
  };

  return {
    tenant: tenantCtx,
    broadcastsRepo: broadcastsRepo as BroadcastsRepo,
    marketingUnsubscribes: marketingUnsubscribes as MarketingUnsubscribesRepo,
    membersBridge: membersBridge as MembersBridgePort,
    audit,
    clock: frozenClock(),
    tenantDisplayName: 'Test Chamber',
    tenantSupportEmail: 'support@test.example.org',
    ...overrides,
  };
}

describe('unsubscribeRecipient (T137)', () => {
  it('first unsubscribe inserts row, resolves member, emits audits, returns wasNew=true', async () => {
    const deps = makeDeps();

    const result = await unsubscribeRecipient(deps, {
      tenantId: TENANT_SLUG,
      broadcastId,
      emailLower: recipient,
      tokenPlaintext: 'v1.fake.fakemac',
      requestId: 'req-1',
      reasonText: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wasNew).toBe(true);
    expect(result.value.tenantDisplayName).toBe('Test Chamber');

    expect(deps.marketingUnsubscribes.upsert).toHaveBeenCalledTimes(1);
    const upsertCall = (deps.marketingUnsubscribes.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(upsertCall.tenantId).toBe(TENANT_SLUG);
    expect(upsertCall.emailLower).toBe(recipient);
    expect(upsertCall.memberId).toBe('mem-1');
    expect(upsertCall.reason).toBe('recipient_initiated');
    expect(upsertCall.sourceTokenHash).toMatch(/^[a-f0-9]{64}$/);

    // Two audits emitted on first unsubscribe
    expect(deps.audit.emit).toHaveBeenCalledTimes(2);
    const eventTypes = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1].eventType,
    );
    expect(eventTypes).toContain('broadcast_unsubscribed');
    expect(eventTypes).toContain('broadcast_suppression_applied');
  });

  it('idempotent replay returns wasNew=false and emits NO additional audits', async () => {
    const deps = makeDeps();
    (deps.marketingUnsubscribes.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      wasNew: false,
      suppression: {
        tenantId: TENANT_SLUG,
        emailLower: recipient,
        memberId: 'mem-1',
        reason: 'recipient_initiated',
        reasonText: null,
        sourceBroadcastId: broadcastId,
        sourceTokenHash: 'abc',
        unsubscribedAt: new Date('2026-04-29T10:00:00Z'),
      },
    });

    const result = await unsubscribeRecipient(deps, {
      tenantId: TENANT_SLUG,
      broadcastId,
      emailLower: recipient,
      tokenPlaintext: 'v1.fake.fakemac',
      requestId: 'req-2',
      reasonText: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wasNew).toBe(false);
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('tenant mismatch returns unsubscribe.tenant_mismatch and never touches repo', async () => {
    const deps = makeDeps();
    const result = await unsubscribeRecipient(deps, {
      tenantId: OTHER_TENANT,
      broadcastId,
      emailLower: recipient,
      tokenPlaintext: 'v1.fake.fakemac',
      requestId: 'req-3',
      reasonText: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unsubscribe.tenant_mismatch');
    expect(deps.broadcastsRepo.withTx).not.toHaveBeenCalled();
    expect(deps.marketingUnsubscribes.upsert).not.toHaveBeenCalled();
  });

  it('marketingUnsubscribes.upsert throw → unsubscribe.repo_error', async () => {
    const cause = new Error('connection refused');
    const deps = makeDeps();
    (deps.marketingUnsubscribes.upsert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(cause);

    const result = await unsubscribeRecipient(deps, {
      tenantId: TENANT_SLUG,
      broadcastId,
      emailLower: recipient,
      tokenPlaintext: 'v1.fake.fakemac',
      requestId: 'req-4',
      reasonText: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unsubscribe.repo_error');
    // Atomicity: audit MUST NOT have been emitted when the upsert failed.
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('member lookup throw → memberId is null but row + audits still emitted', async () => {
    const deps = makeDeps();
    (deps.membersBridge.lookupMemberPrimaryContactEmailInTenant as ReturnType<
      typeof vi.fn
    >).mockRejectedValueOnce(new Error('rls denied'));

    const result = await unsubscribeRecipient(deps, {
      tenantId: TENANT_SLUG,
      broadcastId,
      emailLower: recipient,
      tokenPlaintext: 'v1.fake.fakemac',
      requestId: 'req-5',
      reasonText: null,
    });

    expect(result.ok).toBe(true);
    const upsertCall = (deps.marketingUnsubscribes.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(upsertCall.memberId).toBeNull();
    expect(deps.audit.emit).toHaveBeenCalledTimes(2);
  });

  it('broadcast lookup throw → sourceBroadcastId null, suppression still inserted', async () => {
    const deps = makeDeps();
    (deps.broadcastsRepo.findByIdInTx as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('tx aborted'),
    );

    const result = await unsubscribeRecipient(deps, {
      tenantId: TENANT_SLUG,
      broadcastId,
      emailLower: recipient,
      tokenPlaintext: 'v1.fake.fakemac',
      requestId: 'req-6',
      reasonText: null,
    });

    expect(result.ok).toBe(true);
    const upsertCall = (deps.marketingUnsubscribes.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(upsertCall.sourceBroadcastId).toBeNull();
    expect(deps.audit.emit).toHaveBeenCalledTimes(2);
  });

  it('reasonText longer than 500 chars is truncated', async () => {
    const deps = makeDeps();
    const longText = 'a'.repeat(600);
    await unsubscribeRecipient(deps, {
      tenantId: TENANT_SLUG,
      broadcastId,
      emailLower: recipient,
      tokenPlaintext: 'v1.fake.fakemac',
      requestId: 'req-7',
      reasonText: longText,
    });
    const upsertCall = (deps.marketingUnsubscribes.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(upsertCall.reasonText).toHaveLength(500);
  });

  // Verify-fix: ensure truncation preserves the START of the string, not
  // the end (a regression to `.slice(-500)` would silently drop user-
  // supplied feedback prefix and pass the previous length-only assertion).
  it('reasonText truncation preserves start-of-string content', async () => {
    const deps = makeDeps();
    const distinctive = 'BEGIN_FEEDBACK_';
    const longText = distinctive + 'x'.repeat(600);
    await unsubscribeRecipient(deps, {
      tenantId: TENANT_SLUG,
      broadcastId,
      emailLower: recipient,
      tokenPlaintext: 'v1.fake.fakemac',
      requestId: 'req-8',
      reasonText: longText,
    });
    const upsertCall = (deps.marketingUnsubscribes.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect((upsertCall.reasonText as string).startsWith(distinctive)).toBe(
      true,
    );
    expect(upsertCall.reasonText).toHaveLength(500);
  });
});
