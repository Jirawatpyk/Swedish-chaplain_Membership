/**
 * Unit tests for `ingestWebhookAttendee` covering the round-2 hardening
 * branches that integration tests don't exercise:
 *
 *   - CRITICAL-2: `kind: 'invariant_violation'` from either repo →
 *     logger.fatal + TxStageError + rolled_back
 *   - gap-audit_emit-mid-tx: `audit.emit` returning err mid-tx →
 *     emitOrThrow throws → failureStage='audit_emit' on rolled_back
 *   - CRITICAL-1: `auditFallbackFailed: true` when
 *     `emitRolledBackStandalone` itself fails → double-failure metric +
 *     logger.fatal
 *
 * Strategy: mock `runInTenantTx` to invoke the use-case callback with
 * controllable port stubs. The use-case's `try/catch` orchestrator +
 * dual-write fallback are exercised directly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import {
  ingestWebhookAttendee,
  type IngestWebhookAttendeeDeps,
  type TxScopedPorts,
} from '@/modules/events';
import { makeWebhookPayload } from '../../integration/events/helpers/sign-webhook';

function buildPorts(overrides: Partial<TxScopedPorts> = {}): TxScopedPorts {
  return {
    eventsRepo: {
      upsert: vi.fn().mockResolvedValue(
        ok({
          event: {
            tenantId: 'test',
            eventId: 'evt-1',
            source: 'eventcreate',
            externalId: 'ext-evt-1',
            name: 'Test',
            description: null,
            startDate: new Date(),
            endDate: null,
            location: null,
            category: null,
            eventcreateUrl: null,
            isPartnerBenefit: false,
            isCulturalEvent: false,
            archivedAt: null,
            metadata: {},
            importedAt: new Date(),
            lastUpdatedAt: new Date(),
          },
          eventCreated: true,
        }),
      ),
      findById: vi.fn(),
      findByExternalId: vi.fn(),
      list: vi.fn(),
      getEmptyContext: vi.fn(),
      setArchived: vi.fn(),
      setPartnerBenefit: vi.fn(),
      setCulturalEvent: vi.fn(),
    },
    registrationsRepo: {
      insertOnConflictDoNothing: vi.fn().mockResolvedValue(
        ok({
          registration: {
            tenantId: 'test',
            registrationId: 'reg-1',
            eventId: 'evt-1',
            externalId: 'ext-att-1',
            attendee: { email: 'a@b.com', name: 'A', company: null },
            match: { type: 'non_member', matchedMemberId: null, matchedContactId: null },
            ticket: { type: null, priceThb: null, paymentStatus: 'free' },
            quotaEffect: { countedAgainstPartnership: false, countedAgainstCulturalQuota: false },
            metadata: {},
            registeredAt: new Date(),
            importedAt: new Date(),
            piiPseudonymisedAt: null,
          },
          isNewRegistration: true,
        }),
      ),
      findById: vi.fn(),
      findByEventId: vi.fn(),
      findByEmailLower: vi.fn(),
      countConsumedByMember: vi.fn(),
      updateMatchAndQuota: vi.fn(),
      listPseudonymiseEligible: vi.fn(),
      pseudonymiseRow: vi.fn(),
      hardDelete: vi.fn(),
    },
    idempotencyStore: {
      tryInsert: vi.fn().mockResolvedValue(
        ok({ wasFresh: true, originalProcessedAt: null }),
      ),
      sweepExpired: vi.fn(),
    },
    attendeeMatcher: {
      match: vi.fn().mockResolvedValue(
        ok({
          resolution: { type: 'non_member', matchedMemberId: null, matchedContactId: null },
          fuzzyDetail: null,
          unmatchedCandidates: null,
        }),
      ),
    },
    audit: {
      emit: vi.fn().mockResolvedValue(ok('audit-id')),
      emitRolledBack: vi.fn().mockResolvedValue(ok('audit-id')),
      emitStandalone: vi.fn().mockResolvedValue(ok('audit-id')),
    },
    ...overrides,
  } as TxScopedPorts;
}

function buildDeps(ports: TxScopedPorts, opts: {
  emitRolledBackStandaloneFails?: boolean;
} = {}): IngestWebhookAttendeeDeps {
  return {
    runInTenantTx: async (_tenantId, fn) => fn(ports),
    emitRolledBackStandalone: vi.fn().mockResolvedValue(
      opts.emitRolledBackStandaloneFails
        ? err({ kind: 'db_error', message: 'fallback failed' })
        : ok('audit-id'),
    ),
    emitStandalone: vi.fn().mockResolvedValue(ok('audit-id')),
  };
}

const VALID_INPUT = {
  tenantId: 'test-chamber',
  requestId: 'req-1',
  source: 'eventcreate_webhook' as const,
  rawPayload: makeWebhookPayload(),
  sourceIp: '127.0.0.1',
};

describe('ingestWebhookAttendee — round-2 hardening branches', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  });

  // CRITICAL-2 — events repo invariant_violation
  it('events.upsert invariant_violation → logger.fatal + rolled_back at event_upsert', async () => {
    const ports = buildPorts();
    (ports.eventsRepo.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'invariant_violation', invariant: 'forced for test' }),
    );
    const deps = buildDeps(ports);

    const result = await ingestWebhookAttendee(VALID_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('rolled_back');
    if (result.error.kind !== 'rolled_back') throw new Error('unreachable');
    expect(result.error.failureStage).toBe('event_upsert');
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_events_repo_invariant_violation' }),
      expect.any(String),
    );
  });

  // CRITICAL-2 — registrations repo invariant_violation
  it('registrations.insert invariant_violation → logger.fatal + rolled_back at registration_insert', async () => {
    const ports = buildPorts();
    (ports.registrationsRepo.insertOnConflictDoNothing as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'invariant_violation', invariant: 'forced for test' }),
    );
    const deps = buildDeps(ports);

    const result = await ingestWebhookAttendee(VALID_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('rolled_back');
    if (result.error.kind !== 'rolled_back') throw new Error('unreachable');
    expect(result.error.failureStage).toBe('registration_insert');
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_registrations_repo_invariant_violation' }),
      expect.any(String),
    );
  });

  // gap-audit_emit-mid-tx — emitOrThrow exercises audit_emit stage
  it('audit.emit returning err mid-tx → failureStage="audit_emit" on rolled_back', async () => {
    const ports = buildPorts();
    // Verified path emits `webhook_receipt_verified`; force that to fail.
    (ports.audit.emit as ReturnType<typeof vi.fn>).mockImplementation(async (entry) => {
      if (entry.eventType === 'webhook_receipt_verified') {
        return err({ kind: 'db_error', message: 'simulated audit insert failure' });
      }
      return ok('audit-id');
    });
    const deps = buildDeps(ports);

    const result = await ingestWebhookAttendee(VALID_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('rolled_back');
    if (result.error.kind !== 'rolled_back') throw new Error('unreachable');
    expect(result.error.failureStage).toBe('audit_emit');
  });

  // CRITICAL-1 — auditFallbackFailed: true round-trip
  it('emitRolledBackStandalone failure → auditFallbackFailed=true + double-failure metric + logger.fatal', async () => {
    const counterSpy = vi.spyOn(eventcreateMetrics, 'auditFallbackDoubleFailure');
    const ports = buildPorts();
    (ports.eventsRepo.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'db_error', message: 'forced primary failure' }),
    );
    const deps = buildDeps(ports, { emitRolledBackStandaloneFails: true });

    const result = await ingestWebhookAttendee(VALID_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('rolled_back');
    if (result.error.kind !== 'rolled_back') throw new Error('unreachable');
    expect(result.error.auditFallbackFailed).toBe(true);
    expect(result.error.ingestLatencyMs).toBeGreaterThanOrEqual(0);
    expect(counterSpy).toHaveBeenCalledWith(VALID_INPUT.tenantId, 'event_upsert');
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_audit_fallback_double_failure' }),
      expect.any(String),
    );
  });

  it('happy path → auditFallbackFailed not relevant; result.value.ingestLatencyMs ≥ 0', async () => {
    const ports = buildPorts();
    const deps = buildDeps(ports);

    const result = await ingestWebhookAttendee(VALID_INPUT, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.ingestLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
