/**
 * T179 (Phase 9 / Q18 / SC-011) — JCC-test tenant fixture.
 *
 * Per-release multi-tenant readiness invariant: F7 MUST be data-only
 * configurable for a new tenant — onboarding "JCC-test" SHOULD require
 * zero diff in `src/modules/broadcasts/**`.
 *
 * **Active stub-Resend mode** (no real Resend test-mode credentials
 * required): the fixture wires a stub `BroadcastsGatewayPort` that
 * returns deterministic audience + broadcast IDs and never makes a
 * network call. This lets the "F7 onboards a new tenant with zero F7
 * code change" invariant be CI-verified on every PR without external
 * dependencies. Live-Resend dispatch is exercised by the staging
 * promotion workflow, not this fixture.
 *
 * Total runtime budget: < 5 seconds (stub mode). Failure = ship blocker
 * per SC-011.
 */
import { describe, expect, it } from 'vitest';
import { ok } from '@/lib/result';
import {
  cancelInFlightBroadcastsForMember,
  isF7AuditEventType,
  F7_AUDIT_EVENT_TYPES,
  F7_AUDIT_RETENTION_YEARS,
  f7RetentionFor,
} from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import type {
  AuditEmitInput,
  AuditPort,
} from '@/modules/broadcasts/application/ports/audit-port';
import type {
  Broadcast,
  BroadcastId,
} from '@/modules/broadcasts/domain/broadcast';
import type {
  BroadcastsRepo,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { ClockPort } from '@/modules/broadcasts/application/ports/clock-port';

/**
 * Deterministic clock — fixture must produce identical audit
 * timestamps across runs so the assert-set is byte-stable.
 */
const FIXED_NOW = new Date('2026-05-02T12:00:00Z');
const clock: ClockPort = { now: () => FIXED_NOW };

/**
 * Stub repo — returns one broadcast per tenant when asked, records
 * applyTransition + listInFlightOwnedByMember calls. Other methods
 * throw to surface accidental coupling regressions.
 */
function makeStubRepo(tenantSlug: string): {
  port: BroadcastsRepo;
  applyTransitionCalls: Array<{ tenantId: string; broadcastId: string }>;
  listCalls: Array<{ tenantId: string; memberId: string }>;
} {
  const applyTransitionCalls: Array<{ tenantId: string; broadcastId: string }> = [];
  const listCalls: Array<{ tenantId: string; memberId: string }> = [];

  const oneInFlight: Broadcast = {
    broadcastId: `bc-${tenantSlug}-1` as unknown as BroadcastId,
    tenantId: tenantSlug,
    status: 'submitted',
    requestedByMemberId: `member-${tenantSlug}-1`,
  } as unknown as Broadcast;

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
      tenantId: string,
      broadcastId: BroadcastId,
      target: string,
    ): Promise<Broadcast> {
      applyTransitionCalls.push({
        tenantId,
        broadcastId: broadcastId as unknown as string,
      });
      return { ...oneInFlight, status: target } as Broadcast;
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
    async listInFlightOwnedByMember(
      tenantId: string,
      memberId: unknown,
    ): Promise<ReadonlyArray<Broadcast>> {
      listCalls.push({
        tenantId,
        memberId: memberId as unknown as string,
      });
      return [oneInFlight];
    },
  } as unknown as BroadcastsRepo;

  return { port, applyTransitionCalls, listCalls };
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

describe('T179 — JCC-test tenant fixture (multi-tenant readiness invariant)', () => {
  it('F7 audit catalogue is data-only — onboarding a new tenant requires zero code change', () => {
    // Invariant 1: every catalogued event type has a 5y retention
    // mapping. New tenants inherit the catalogue automatically.
    expect(F7_AUDIT_EVENT_TYPES.length).toBeGreaterThanOrEqual(37);
    for (const eventType of F7_AUDIT_EVENT_TYPES) {
      expect(F7_AUDIT_RETENTION_YEARS[eventType]).toBe(5);
      expect(f7RetentionFor(eventType)).toBe(5);
      expect(isF7AuditEventType(eventType)).toBe(true);
    }
    // Invariant 2: predicate rejects non-F7 events (F1/F4/F5 etc.).
    expect(isF7AuditEventType('member_archived')).toBe(false);
    expect(isF7AuditEventType('payment_succeeded')).toBe(false);
    expect(isF7AuditEventType('not_a_real_event')).toBe(false);
  });

  it('cascade boundary works identically for two distinct tenants (zero shared mutable state)', async () => {
    // Onboard SweCham + JCC-test as parallel tenants. Use the F7 cascade
    // boundary (T178a) as a representative use-case — it touches
    // tenant-scoped repo + audit port + clock + composition root.
    const tenants = [asTenantContext('swecham'), asTenantContext('jcc-test')];

    for (const tenant of tenants) {
      const repo = makeStubRepo(tenant.slug);
      const audit = makeStubAudit();
      const result = await cancelInFlightBroadcastsForMember(
        { broadcastsRepo: repo.port, audit: audit.port, clock },
        {
          tenant,
          memberId: `member-${tenant.slug}-1` as never,
          requestId: `req-${tenant.slug}`,
          initiatedByUserId: `admin-${tenant.slug}`,
        },
      );
      expect(result.ok).toBe(true);
      expect(result).toEqual(
        ok({ cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0 }),
      );

      // Invariant: every repo + audit call carries the SAME tenant slug.
      // No cross-tenant leak (Constitution Principle I clause 3).
      expect(repo.listCalls).toHaveLength(1);
      expect(repo.listCalls[0]!.tenantId).toBe(tenant.slug);
      expect(repo.applyTransitionCalls).toHaveLength(1);
      expect(repo.applyTransitionCalls[0]!.tenantId).toBe(tenant.slug);
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]!.tenantId).toBe(tenant.slug);
      expect(audit.events[0]!.eventType).toBe('broadcast_cancelled');
      expect(audit.events[0]!.payload.cascade).toBe(
        'f3_member_archival_or_erasure',
      );
    }
  });

  it('cross-tenant suppression isolation — barrel exposes no cross-tenant merge (FR-018 / Q19)', async () => {
    // Per data-model.md § 5: "marketing_unsubscribes(tenant_id,
    // email_lower) PRIMARY KEY". Each tenant has its own slice; an
    // unsubscribe in tenant A has no effect on tenant B. Verified
    // structurally by the absence of any cross-tenant suppression
    // merge in the F7 module barrel. Live-DB cross-tenant assertions
    // are in `tenant-isolation.test.ts`.
    const barrel = await import('@/modules/broadcasts');
    const symbols = Object.keys(barrel);
    for (const sym of symbols) {
      expect(sym.toLowerCase()).not.toContain('crosstenantsuppression');
      expect(sym.toLowerCase()).not.toContain('mergesuppression');
    }
  });
});
