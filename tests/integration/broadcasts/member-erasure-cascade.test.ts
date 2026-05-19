/**
 * T178a — F3 archival/erasure → F7 in-flight broadcasts cascade.
 *
 * Spec § Edge Cases L353 / Coverage Gap C2 from /speckit.analyze.
 *
 * Asserts the contract: when a member with `submitted` + `approved`
 * broadcasts is archived/erased, every in-flight broadcast transitions
 * to `cancelled` with `actor_role='system'` + `cancelled_by_user_id=NULL`,
 * the quota reservation is released, and one `broadcast_cancelled` audit
 * event fires per broadcast.
 *
 * Uses stub repo + audit ports — same pattern as the rest of the F7
 * integration suite (see `audience-cap.test.ts`, `halt-flag-precondition.test.ts`).
 * Live-DB cross-tenant assertions live in `tenant-isolation.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { cancelInFlightBroadcastsForMember } from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';
import type {
  Broadcast,
  BroadcastId,
} from '@/modules/broadcasts/domain/broadcast';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type {
  BroadcastsRepo,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { ClockPort } from '@/modules/broadcasts/application/ports/clock-port';

const tenant = asTenantContext('test-tenant');
const memberId = 'mem-archived-1' as BroadcastsRepo extends infer _ ? string : never;
const NOW = new Date('2026-05-02T12:00:00Z');

// R6 staff-review W-T2 fix — drop the `as unknown as Broadcast` cast.
// The prior fixture carried stale field names (`segmentDefinitionId`,
// `quotaYearReserved`, `rejectionReasonHash`, `sendStartedAt`) that
// did not match the `Broadcast` interface in
// `src/modules/broadcasts/domain/broadcast.ts`. The cast made
// TypeScript silently accept the drift; removing it forces compile-
// time alignment with the real interface and surfaces future schema
// changes immediately.
function makeBroadcast(
  id: string,
  status: 'submitted' | 'approved' | 'sending',
): Broadcast {
  return {
    broadcastId: asBroadcastId(id),
    tenantId: tenant.slug,
    requestedByMemberId: memberId,
    requestedByMemberPlanIdSnapshot: 'plan-snap-1',
    submittedByUserId: 'user-1',
    actorRole: 'member_self_service',
    subject: 'subj',
    bodyHtml: '<p>hi</p>',
    bodySource: '<p>hi</p>',
    fromName: 'Test',
    replyToEmail: unsafeBrandEmailLower('reply@example.com'),
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: null,
    estimatedRecipientCount: 100,
    status,
    submittedAt: NOW,
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
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeStubRepo(opts: {
  inFlight: ReadonlyArray<Broadcast>;
  applyTransitionThrows?: number; // index of broadcast that throws
}): {
  port: BroadcastsRepo;
  transitions: Array<{ id: string; target: string; cancelledByUserId: string | null }>;
} {
  const transitions: Array<{
    id: string;
    target: string;
    cancelledByUserId: string | null;
  }> = [];
  let applyCallIdx = 0;

  // Minimal stub — only the methods cancelInFlightBroadcastsForMember calls.
  // Other methods throw to surface accidental coupling regressions.
  const port = {
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({ stub: true });
    },
    insertDraft: () => Promise.reject(new Error('not used')),
    updateDraft: () => Promise.reject(new Error('not used')),
    findById: () => Promise.resolve(null),
    findByIdInTx: () => Promise.resolve(null),
    lockForUpdate: () => Promise.reject(new Error('not used')),
    async applyTransition(
      _tx: unknown,
      _tenantId: string,
      broadcastId: BroadcastId,
      target: string,
      fields: { cancelledByUserId: string | null },
      _expected: string,
    ): Promise<Broadcast> {
      const idx = applyCallIdx++;
      if (
        opts.applyTransitionThrows !== undefined &&
        idx === opts.applyTransitionThrows
      ) {
        // QA fix (2026-05-03) — must be the typed sentinel because
        // `cancelInFlightBroadcastsForMember` narrows catch to
        // `instanceof BroadcastConcurrentMutationError` (R7 W-R2
        // pattern); plain `Error` re-throws and the test counts
        // 0 skippedConcurrent instead of 1.
        throw new BroadcastConcurrentMutationError(
          tenant.slug,
          broadcastId,
          'sending',
        );
      }
      transitions.push({
        id: broadcastId as unknown as string,
        target,
        cancelledByUserId: fields.cancelledByUserId,
      });
      // Find the corresponding broadcast in opts and return a mutated
      // copy with the new status.
      const original = opts.inFlight.find(
        (b) => (b.broadcastId as unknown as string) === (broadcastId as unknown as string),
      );
      if (!original) throw new Error(`stub: unknown broadcast ${broadcastId as unknown as string}`);
      return {
        ...original,
        status: target,
        cancelledByUserId: fields.cancelledByUserId,
      } as Broadcast;
    },
    attachResendIds: () => Promise.reject(new Error('not used')),
    attachAudienceId: () => Promise.reject(new Error('not used')),
    listByTenantStatus: () => Promise.reject(new Error('not used')),
    countForMemberQuota: () =>
      Promise.resolve({ submittedOrApproved: 0, sent: 0 }),
    findByResendBroadcastIdBypassRls: () => Promise.resolve(null),
    listForMemberPaginated: () =>
      Promise.resolve({ rows: [], total: 0, totalPages: 0, page: 1 }),
    findOwnedByMember: () =>
      Promise.resolve({ probeKind: 'not_found' as const, broadcast: null }),
    aggregateDeliveryCountsForBroadcast: () =>
      Promise.resolve({
        delivered: 0,
        bounced: 0,
        softBounced: 0,
        complained: 0,
        sent: 0,
      }),
    pruneExpiredDrafts: () => Promise.resolve({ prunedCount: 0 }),
    async listInFlightOwnedByMember(): Promise<ReadonlyArray<Broadcast>> {
      return opts.inFlight;
    },
  } as unknown as BroadcastsRepo;

  return { port, transitions };
}

function makeStubAudit(): {
  port: AuditPort;
  events: Array<AuditEmitInput>;
} {
  const events: Array<AuditEmitInput> = [];
  return {
    events,
    port: {
      async emit(_tx, event): Promise<void> {
        events.push(event);
      },
    },
  };
}

const clock: ClockPort = { now: () => NOW };

describe('T178a — cancelInFlightBroadcastsForMember (F3 cascade boundary)', () => {
  it('cancels every submitted + approved broadcast and emits one audit per row', async () => {
    const inFlight = [
      makeBroadcast('bc-001', 'submitted'),
      makeBroadcast('bc-002', 'submitted'),
      makeBroadcast('bc-003', 'approved'),
    ];
    const repo = makeStubRepo({ inFlight });
    const audit = makeStubAudit();

    const result = await cancelInFlightBroadcastsForMember(
      { broadcastsRepo: repo.port, audit: audit.port, clock },
      {
        tenant,
        memberId: memberId as never,
        requestId: 'req-1',
        initiatedByUserId: 'admin-actor-1',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cancelledCount).toBe(3);
    expect(result.value.skippedConcurrentCount).toBe(0);

    // Every transition has cancelled_by_user_id=NULL (system-initiated)
    // — task spec L353 explicit requirement.
    expect(repo.transitions).toHaveLength(3);
    for (const t of repo.transitions) {
      expect(t.target).toBe('cancelled');
      expect(t.cancelledByUserId).toBeNull();
    }

    // 3 audit events, all `broadcast_cancelled` with actor_role='system'
    // + cancellationReason='originator_member_deleted' (default).
    const cancelledEvents = audit.events.filter(
      (e) => e.eventType === 'broadcast_cancelled',
    );
    expect(cancelledEvents).toHaveLength(3);
    for (const ev of cancelledEvents) {
      expect(ev.payload.actorKind).toBe('system');
      expect(ev.payload.actorRole).toBe('system');
      expect(ev.payload.cancellationReason).toBe('originator_member_deleted');
      expect(ev.payload.cascade).toBe('f3_member_archival_or_erasure');
      expect(ev.payload.initiatedByUserId).toBe('admin-actor-1');
      expect(ev.actorUserId).toBe('admin-actor-1');
      expect(ev.tenantId).toBe(tenant.slug);
    }
  });

  it('returns zero counts when member has no in-flight broadcasts (idempotent replay)', async () => {
    const repo = makeStubRepo({ inFlight: [] });
    const audit = makeStubAudit();

    const result = await cancelInFlightBroadcastsForMember(
      { broadcastsRepo: repo.port, audit: audit.port, clock },
      {
        tenant,
        memberId: memberId as never,
        requestId: 'req-2',
        initiatedByUserId: 'admin-actor-1',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cancelledCount).toBe(0);
    expect(result.value.skippedConcurrentCount).toBe(0);
    expect(repo.transitions).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  it('skips broadcast that races to `sending` and emits concurrent-action audit', async () => {
    const inFlight = [
      makeBroadcast('bc-100', 'submitted'),
      makeBroadcast('bc-101', 'approved'), // <- this one races
      makeBroadcast('bc-102', 'submitted'),
    ];
    const repo = makeStubRepo({ inFlight, applyTransitionThrows: 1 });
    const audit = makeStubAudit();

    const result = await cancelInFlightBroadcastsForMember(
      { broadcastsRepo: repo.port, audit: audit.port, clock },
      {
        tenant,
        memberId: memberId as never,
        requestId: 'req-3',
        initiatedByUserId: 'admin-actor-1',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cancelledCount).toBe(2);
    expect(result.value.skippedConcurrentCount).toBe(1);

    const cancelledEvents = audit.events.filter(
      (e) => e.eventType === 'broadcast_cancelled',
    );
    const concurrentEvents = audit.events.filter(
      (e) => e.eventType === 'broadcast_concurrent_action_blocked',
    );
    expect(cancelledEvents).toHaveLength(2);
    expect(concurrentEvents).toHaveLength(1);
    expect(concurrentEvents[0]!.payload.cascade).toBe(
      'f3_member_archival_or_erasure',
    );
  });

  it('honours custom cancellationReason override', async () => {
    const inFlight = [makeBroadcast('bc-200', 'submitted')];
    const repo = makeStubRepo({ inFlight });
    const audit = makeStubAudit();

    const result = await cancelInFlightBroadcastsForMember(
      { broadcastsRepo: repo.port, audit: audit.port, clock },
      {
        tenant,
        memberId: memberId as never,
        cancellationReason: 'gdpr_erasure_request',
        requestId: 'req-4',
        initiatedByUserId: 'admin-actor-2',
      },
    );

    expect(result.ok).toBe(true);
    const cancelledEvent = audit.events.find(
      (e) => e.eventType === 'broadcast_cancelled',
    );
    expect(cancelledEvent?.payload.cancellationReason).toBe(
      'gdpr_erasure_request',
    );
  });
});
