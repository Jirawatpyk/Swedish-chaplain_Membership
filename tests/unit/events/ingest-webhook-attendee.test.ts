/**
 * Unit tests for `ingestWebhookAttendee` covering hardening branches
 * that integration tests don't exercise:
 *
 *   - `kind: 'invariant_violation'` from either repo →
 *     logger.fatal + TxStageError + rolled_back
 *   - `audit.emit` returning err mid-tx → emitOrThrow throws →
 *     failureStage='audit_emit' on rolled_back
 *   - `auditFallbackFailed: true` when `emitRolledBackStandalone`
 *     itself fails → double-failure metric + logger.fatal
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
      markRefunded: vi.fn(),
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
    quotaAccountingPort: {
      queryAllotments: vi.fn().mockResolvedValue(
        ok({
          allotments: { partnershipPerEvent: 6, culturalPerYear: 12 },
          consumed: {
            partnershipConsumedForEvent: 0,
            culturalConsumedForYear: 0,
          },
        }),
      ),
    },
    advisoryLockAcquirer: {
      acquire: vi.fn().mockResolvedValue(undefined),
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

  /**
   * Phase 6 staff-review-4 WARN-6 — `isRefundTransition` branch unit test.
   * AS4 (refund credit-back) end-to-end is covered at the integration
   * layer (`tests/integration/events/quota-accounting.test.ts:578-756`)
   * but the 5-condition guard at `ingest-webhook-attendee.ts:689-695`
   * had no pure-unit coverage. A regression dropping the
   * `existingPaymentStatus !== 'refunded'` idempotency check would
   * break the integration test only — costly to surface.
   *
   * This test forces `insertOnConflictDoNothing` to return
   * `isNewRegistration: false` with an existing row carrying
   * `paymentStatus: 'paid'` + `countedAgainstPartnership: true`, then
   * delivers an incoming payload with `paymentStatus: 'refunded'`. The
   * expected outcomes:
   *
   *   1. `markRefunded` is invoked (the flip-to-refunded UPDATE)
   *   2. The audit port receives `quota_credit_back_refund` for the
   *      partnership scope (and NOT for cultural — that flag was false)
   *   3. The advisory lock is acquired exactly once in the refund block
   *   4. `quotaAccountingPort.queryAllotments` is called to read
   *      `allotmentAfter` (the value emitted in the audit payload)
   *   5. Use-case still returns Result.ok (the refund transition is
   *      not an error path; it is a normal state transition).
   */
  it('isRefundTransition (paid→refunded with partnership counted) → markRefunded + quota_credit_back_refund + ok', async () => {
    const memberIdLiteral = '11111111-1111-1111-1111-111111111111';
    const existingRegPaidPartnership = {
      tenantId: 'test',
      registrationId: 'reg-prior-paid',
      eventId: 'evt-1',
      externalId: 'ext-att-refund-1',
      attendee: {
        email: 'refunder@example.com',
        name: 'Refund Sample',
        company: 'Diamond Co',
      },
      match: {
        type: 'member_contact' as const,
        matchedMemberId: memberIdLiteral,
        matchedContactId: 'contact-1',
      },
      ticket: { type: null, priceThb: null, paymentStatus: 'paid' as const },
      quotaEffect: {
        countedAgainstPartnership: true,
        countedAgainstCulturalQuota: false,
      },
      metadata: {},
      registeredAt: new Date(),
      importedAt: new Date(),
      piiPseudonymisedAt: null,
    };

    const ports = buildPorts();
    // Event is partner-benefit so apply-quota would normally fire,
    // but the refund branch short-circuits BEFORE shouldApplyQuota
    // for the existing-row case.
    (ports.eventsRepo.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        event: {
          tenantId: 'test',
          eventId: 'evt-1',
          source: 'eventcreate',
          externalId: 'ext-evt-1',
          name: 'Refund Test Event',
          description: null,
          startDate: new Date('2026-06-15T18:00:00+07:00'),
          endDate: null,
          location: null,
          category: null,
          eventcreateUrl: null,
          isPartnerBenefit: true,
          isCulturalEvent: false,
          archivedAt: null,
          metadata: {},
          importedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
        eventCreated: false,
      }),
    );
    // Existing row already counted=true on partnership.
    (
      ports.registrationsRepo.insertOnConflictDoNothing as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({
        registration: existingRegPaidPartnership,
        isNewRegistration: false,
      }),
    );
    // markRefunded returns the flipped row + previous-state markers
    // that the use-case reads via `flip.value.previousQuotaEffect` to
    // decide which scope audits to emit.
    (
      ports.registrationsRepo.markRefunded as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({
        registration: {
          ...existingRegPaidPartnership,
          ticket: {
            ...existingRegPaidPartnership.ticket,
            paymentStatus: 'refunded',
          },
          quotaEffect: {
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
          },
        },
        previousQuotaEffect: existingRegPaidPartnership.quotaEffect,
        previousPaymentStatus: 'paid',
      }),
    );
    // Attendee matcher returns the same matched member as the existing row.
    (ports.attendeeMatcher.match as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        resolution: {
          type: 'member_contact',
          matchedMemberId: memberIdLiteral,
          matchedContactId: 'contact-1',
        },
        fuzzyDetail: null,
        unmatchedCandidates: null,
      }),
    );

    const deps = buildDeps(ports);
    const refundInput = {
      ...VALID_INPUT,
      rawPayload: makeWebhookPayload({
        attendee: {
          externalId: 'ext-att-refund-1',
          email: 'refunder@example.com',
          companyName: 'Diamond Co',
          fullName: 'Refund Sample',
          paymentStatus: 'refunded',
        },
      }),
    };

    const result = await ingestWebhookAttendee(refundInput, deps);

    expect(result.ok).toBe(true);
    // markRefunded MUST be called exactly once.
    expect(ports.registrationsRepo.markRefunded).toHaveBeenCalledTimes(1);
    // queryAllotments MUST be called (to source the allotmentAfter
    // value baked into the audit payload).
    expect(ports.quotaAccountingPort.queryAllotments).toHaveBeenCalled();
    // R6 TEST-R6-02 — advisory lock MUST be acquired before the
    // refund-credit-back path proceeds. Lock absence would create a
    // TOCTOU window with concurrent ingest workers that ALSO try to
    // touch this (member, event) registration.
    expect(ports.advisoryLockAcquirer.acquire).toHaveBeenCalledTimes(1);
    // The audit port should have received a quota_credit_back_refund
    // emit for partnership scope.
    const emitCalls = (ports.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const creditBackRefundCalls = emitCalls.filter(([entry]) => {
      return (entry as { eventType: string }).eventType === 'quota_credit_back_refund';
    });
    expect(creditBackRefundCalls.length).toBe(1);
    const refundEntry = creditBackRefundCalls[0]![0] as {
      payload: { scope: string; allotmentAfter: number };
    };
    expect(refundEntry.payload.scope).toBe('partnership');
    expect(refundEntry.payload.allotmentAfter).toBe(6); // 6 partnership − 0 consumed
  });

  /**
   * R6 REL-R6-04 — pin the `allotmentAfter` formula against the
   * `consumed` subtraction. The existing happy-path test uses
   * `consumed=0` so it cannot detect a regression where the formula
   * silently drops the subtraction term (e.g.,
   * `allotmentAfter = partnershipPerEvent` instead of
   * `partnershipPerEvent - partnershipConsumedForEvent`). This test
   * uses `consumed=2` and asserts `allotmentAfter === 4` (6 − 2).
   */
  it('isRefundTransition with non-zero consumed: allotmentAfter correctly subtracts (REL-R6-04)', async () => {
    const memberIdLiteral = '11111111-1111-1111-1111-111111111111';
    const existingRegPaidPartnership = {
      tenantId: 'test',
      registrationId: 'reg-prior-paid-2',
      eventId: 'evt-1',
      externalId: 'ext-att-consumed-2',
      attendee: { email: 'refunder@example.com', name: 'Refund Sample', company: 'Diamond Co' },
      match: {
        type: 'member_contact' as const,
        matchedMemberId: memberIdLiteral,
        matchedContactId: 'contact-1',
      },
      ticket: { type: null, priceThb: null, paymentStatus: 'paid' as const },
      quotaEffect: {
        countedAgainstPartnership: true,
        countedAgainstCulturalQuota: false,
      },
      metadata: {},
      registeredAt: new Date(),
      importedAt: new Date(),
      piiPseudonymisedAt: null,
    };

    const ports = buildPorts({
      // queryAllotments returns consumed=2 (other rows still counted
      // post-this-refund-flip) so allotmentAfter = 6 - 2 = 4.
      quotaAccountingPort: {
        queryAllotments: vi.fn().mockResolvedValue(
          ok({
            allotments: { partnershipPerEvent: 6, culturalPerYear: 12 },
            consumed: {
              partnershipConsumedForEvent: 2,
              culturalConsumedForYear: 0,
            },
          }),
        ),
      } as never,
    });
    (ports.eventsRepo.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        event: {
          tenantId: 'test',
          eventId: 'evt-1',
          source: 'eventcreate',
          externalId: 'ext-evt-1',
          name: 'Refund Consumed-Subtraction Test',
          description: null,
          startDate: new Date('2026-06-15T18:00:00+07:00'),
          endDate: null,
          location: null,
          category: null,
          eventcreateUrl: null,
          isPartnerBenefit: true,
          isCulturalEvent: false,
          archivedAt: null,
          metadata: {},
          importedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
        eventCreated: false,
      }),
    );
    (
      ports.registrationsRepo.insertOnConflictDoNothing as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({ registration: existingRegPaidPartnership, isNewRegistration: false }),
    );
    (
      ports.registrationsRepo.markRefunded as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({
        registration: {
          ...existingRegPaidPartnership,
          ticket: { ...existingRegPaidPartnership.ticket, paymentStatus: 'refunded' },
          quotaEffect: {
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
          },
        },
        previousQuotaEffect: existingRegPaidPartnership.quotaEffect,
        previousPaymentStatus: 'paid',
      }),
    );
    (ports.attendeeMatcher.match as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        resolution: {
          type: 'member_contact',
          matchedMemberId: memberIdLiteral,
          matchedContactId: 'contact-1',
        },
        fuzzyDetail: null,
        unmatchedCandidates: null,
      }),
    );

    const result = await ingestWebhookAttendee(
      {
        ...VALID_INPUT,
        rawPayload: makeWebhookPayload({
          attendee: {
            externalId: 'ext-att-consumed-2',
            email: 'refunder@example.com',
            companyName: 'Diamond Co',
            fullName: 'Refund Sample',
            paymentStatus: 'refunded',
          },
        }),
      },
      buildDeps(ports),
    );

    expect(result.ok).toBe(true);
    const emitCalls = (ports.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const creditBackRefundCalls = emitCalls.filter(([entry]) => {
      return (entry as { eventType: string }).eventType === 'quota_credit_back_refund';
    });
    expect(creditBackRefundCalls.length).toBe(1);
    const refundEntry = creditBackRefundCalls[0]![0] as {
      payload: { scope: string; allotmentAfter: number };
    };
    // 6 partnership allotment − 2 still-consumed = 4 remaining
    expect(refundEntry.payload.allotmentAfter).toBe(4);
  });

  /**
   * R6 TEST-R6-03 — cultural-only scope credit-back. Mirror of the
   * partnership happy-path test but with the existing row's quota flags
   * inverted. Catches a typo regression where the dispatcher might
   * check `previousQuotaEffect.countedAgainstPartnership` twice instead
   * of once for cultural scope.
   */
  it('isRefundTransition cultural-only scope → only cultural credit-back fires (TEST-R6-03)', async () => {
    const memberIdLiteral = '33333333-3333-3333-3333-333333333333';
    const existingRegCulturalOnly = {
      tenantId: 'test',
      registrationId: 'reg-prior-cultural',
      eventId: 'evt-cultural',
      externalId: 'ext-att-cultural',
      attendee: { email: 'cultural@example.com', name: 'Cultural Sample', company: 'Premium Co' },
      match: {
        type: 'member_contact' as const,
        matchedMemberId: memberIdLiteral,
        matchedContactId: 'contact-cultural',
      },
      ticket: { type: null, priceThb: null, paymentStatus: 'paid' as const },
      quotaEffect: {
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: true,
      },
      metadata: {},
      registeredAt: new Date(),
      importedAt: new Date(),
      piiPseudonymisedAt: null,
    };

    const ports = buildPorts();
    (ports.eventsRepo.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        event: {
          tenantId: 'test',
          eventId: 'evt-cultural',
          source: 'eventcreate',
          externalId: 'ext-evt-cultural',
          name: 'Cultural Refund Test',
          description: null,
          startDate: new Date('2026-08-15T18:00:00+07:00'),
          endDate: null,
          location: null,
          category: null,
          eventcreateUrl: null,
          isPartnerBenefit: false,
          isCulturalEvent: true,
          archivedAt: null,
          metadata: {},
          importedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
        eventCreated: false,
      }),
    );
    (
      ports.registrationsRepo.insertOnConflictDoNothing as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({ registration: existingRegCulturalOnly, isNewRegistration: false }),
    );
    (
      ports.registrationsRepo.markRefunded as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({
        registration: {
          ...existingRegCulturalOnly,
          ticket: { ...existingRegCulturalOnly.ticket, paymentStatus: 'refunded' },
          quotaEffect: {
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
          },
        },
        previousQuotaEffect: existingRegCulturalOnly.quotaEffect,
        previousPaymentStatus: 'paid',
      }),
    );
    (ports.attendeeMatcher.match as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        resolution: {
          type: 'member_contact',
          matchedMemberId: memberIdLiteral,
          matchedContactId: 'contact-cultural',
        },
        fuzzyDetail: null,
        unmatchedCandidates: null,
      }),
    );

    const result = await ingestWebhookAttendee(
      {
        ...VALID_INPUT,
        rawPayload: makeWebhookPayload({
          attendee: {
            externalId: 'ext-att-cultural',
            email: 'cultural@example.com',
            companyName: 'Premium Co',
            fullName: 'Cultural Sample',
            paymentStatus: 'refunded',
          },
        }),
      },
      buildDeps(ports),
    );

    expect(result.ok).toBe(true);
    const emitCalls = (ports.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const creditBackCalls = emitCalls.filter(
      ([entry]) =>
        (entry as { eventType: string }).eventType === 'quota_credit_back_refund',
    );
    expect(creditBackCalls.length).toBe(1);
    const culturalEntry = creditBackCalls[0]![0] as {
      payload: { scope: string };
    };
    expect(culturalEntry.payload.scope).toBe('cultural');
  });

  /**
   * R6 TEST-R6-03 — both scopes counted simultaneously. Some corporate
   * tiers grant BOTH partnership-per-event tickets AND cultural-per-year
   * tickets, so a refund could trigger 2 credit-back audits in a single
   * tx. Asserts the loop emits both, not one or zero.
   */
  it('isRefundTransition both scopes counted → 2 credit-back audits emitted (TEST-R6-03)', async () => {
    const memberIdLiteral = '44444444-4444-4444-4444-444444444444';
    const existingRegBothScopes = {
      tenantId: 'test',
      registrationId: 'reg-both-scopes',
      eventId: 'evt-dual',
      externalId: 'ext-att-dual',
      attendee: { email: 'dual@example.com', name: 'Dual', company: 'Diamond+Premium Co' },
      match: {
        type: 'member_contact' as const,
        matchedMemberId: memberIdLiteral,
        matchedContactId: 'contact-dual',
      },
      ticket: { type: null, priceThb: null, paymentStatus: 'paid' as const },
      quotaEffect: {
        countedAgainstPartnership: true,
        countedAgainstCulturalQuota: true,
      },
      metadata: {},
      registeredAt: new Date(),
      importedAt: new Date(),
      piiPseudonymisedAt: null,
    };

    const ports = buildPorts();
    (ports.eventsRepo.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        event: {
          tenantId: 'test',
          eventId: 'evt-dual',
          source: 'eventcreate',
          externalId: 'ext-evt-dual',
          name: 'Dual-Scope Refund Test',
          description: null,
          startDate: new Date('2026-09-15T18:00:00+07:00'),
          endDate: null,
          location: null,
          category: null,
          eventcreateUrl: null,
          isPartnerBenefit: true,
          isCulturalEvent: true,
          archivedAt: null,
          metadata: {},
          importedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
        eventCreated: false,
      }),
    );
    (
      ports.registrationsRepo.insertOnConflictDoNothing as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({ registration: existingRegBothScopes, isNewRegistration: false }),
    );
    (
      ports.registrationsRepo.markRefunded as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({
        registration: {
          ...existingRegBothScopes,
          ticket: { ...existingRegBothScopes.ticket, paymentStatus: 'refunded' },
          quotaEffect: {
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
          },
        },
        previousQuotaEffect: existingRegBothScopes.quotaEffect,
        previousPaymentStatus: 'paid',
      }),
    );
    (ports.attendeeMatcher.match as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        resolution: {
          type: 'member_contact',
          matchedMemberId: memberIdLiteral,
          matchedContactId: 'contact-dual',
        },
        fuzzyDetail: null,
        unmatchedCandidates: null,
      }),
    );

    const result = await ingestWebhookAttendee(
      {
        ...VALID_INPUT,
        rawPayload: makeWebhookPayload({
          attendee: {
            externalId: 'ext-att-dual',
            email: 'dual@example.com',
            companyName: 'Diamond+Premium Co',
            fullName: 'Dual',
            paymentStatus: 'refunded',
          },
        }),
      },
      buildDeps(ports),
    );

    expect(result.ok).toBe(true);
    const emitCalls = (ports.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const creditBackCalls = emitCalls.filter(
      ([entry]) =>
        (entry as { eventType: string }).eventType === 'quota_credit_back_refund',
    );
    expect(creditBackCalls.length).toBe(2);
    const scopes = creditBackCalls.map(
      (call) => (call[0] as { payload: { scope: string } }).payload.scope,
    );
    expect(scopes.sort()).toEqual(['cultural', 'partnership']);
  });

  /**
   * R6 TEST-R6-03 — non-member existing row (matchedMemberId === null).
   *
   * F6.1 Phase 4 US2 (T033) — semantics adjusted: the row-flip itself
   * (markRefunded) NOW runs even for non-member rows so the CSV
   * cancellation cascade can flip an unmatched attendee's payment
   * status to refunded. The `quota_credit_back_refund` audit remains
   * gated on matchedMember + counted_against_* — non-members never had
   * quota counted, so no credit-back audit emits.
   *
   * This test pins both invariants after the F6.1 relaxation.
   */
  it('isRefundTransition non-member (matchedMemberId=null) → flip runs, no quota credit-back audit (TEST-R6-03 / F6.1 T033)', async () => {
    const existingRegNonMember = {
      tenantId: 'test',
      registrationId: 'reg-non-member',
      eventId: 'evt-1',
      externalId: 'ext-att-non-member',
      attendee: { email: 'nonmember@example.com', name: 'Non Member', company: 'Random Inc' },
      match: {
        type: 'non_member' as const,
        matchedMemberId: null,
        matchedContactId: null,
      },
      ticket: { type: null, priceThb: null, paymentStatus: 'paid' as const },
      quotaEffect: {
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      metadata: {},
      registeredAt: new Date(),
      importedAt: new Date(),
      piiPseudonymisedAt: null,
    };

    const ports = buildPorts();
    (
      ports.registrationsRepo.insertOnConflictDoNothing as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({ registration: existingRegNonMember, isNewRegistration: false }),
    );
    // F6.1 T033 — markRefunded now runs for non-member refund transitions
    // (the row flip is unconditional; quota credit-back audit remains
    // member-gated). Provide a successful return so the call site doesn't
    // throw `TxStageError('quota_decrement')` on an undefined Result.
    (ports.registrationsRepo.markRefunded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        registration: { ...existingRegNonMember, ticket: { ...existingRegNonMember.ticket, paymentStatus: 'refunded' as const } },
        previousQuotaEffect: {
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
        },
        previousPaymentStatus: 'paid' as const,
      }),
    );
    (ports.attendeeMatcher.match as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        resolution: { type: 'non_member', matchedMemberId: null, matchedContactId: null },
        fuzzyDetail: null,
        unmatchedCandidates: null,
      }),
    );

    const result = await ingestWebhookAttendee(
      {
        ...VALID_INPUT,
        rawPayload: makeWebhookPayload({
          attendee: {
            externalId: 'ext-att-non-member',
            email: 'nonmember@example.com',
            companyName: 'Random Inc',
            fullName: 'Non Member',
            paymentStatus: 'refunded',
          },
        }),
      },
      buildDeps(ports),
    );

    expect(result.ok).toBe(true);
    // F6.1 T033 — markRefunded IS called even for non-member rows.
    expect(ports.registrationsRepo.markRefunded).toHaveBeenCalledTimes(1);
    // No quota credit-back audit (non-member never had counted_against_*).
    const emitCalls = (ports.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const creditBackCalls = emitCalls.filter(
      ([entry]) =>
        (entry as { eventType: string }).eventType === 'quota_credit_back_refund',
    );
    expect(creditBackCalls.length).toBe(0);
  });

  /**
   * Idempotency guard: re-delivery of an already-refunded row must
   * NOT re-fire `markRefunded` or emit another `quota_credit_back_refund`.
   * Locks the `existingReg.ticket.paymentStatus !== 'refunded'` check
   * at the unit layer.
   */
  it('isRefundTransition idempotent: existing row already refunded → no re-emit, no markRefunded', async () => {
    const memberIdLiteral = '22222222-2222-2222-2222-222222222222';
    const alreadyRefundedReg = {
      tenantId: 'test',
      registrationId: 'reg-already-refunded',
      eventId: 'evt-1',
      externalId: 'ext-att-already-refunded',
      attendee: {
        email: 'idemp@example.com',
        name: 'Idempotent',
        company: 'Diamond Co',
      },
      match: {
        type: 'member_contact' as const,
        matchedMemberId: memberIdLiteral,
        matchedContactId: 'contact-2',
      },
      ticket: { type: null, priceThb: null, paymentStatus: 'refunded' as const },
      quotaEffect: {
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      metadata: {},
      registeredAt: new Date(),
      importedAt: new Date(),
      piiPseudonymisedAt: null,
    };

    const ports = buildPorts();
    (ports.eventsRepo.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        event: {
          tenantId: 'test',
          eventId: 'evt-1',
          source: 'eventcreate',
          externalId: 'ext-evt-1',
          name: 'Refund Idempotent Test',
          description: null,
          startDate: new Date(),
          endDate: null,
          location: null,
          category: null,
          eventcreateUrl: null,
          isPartnerBenefit: true,
          isCulturalEvent: false,
          archivedAt: null,
          metadata: {},
          importedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
        eventCreated: false,
      }),
    );
    (
      ports.registrationsRepo.insertOnConflictDoNothing as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(
      ok({
        registration: alreadyRefundedReg,
        isNewRegistration: false,
      }),
    );
    (ports.attendeeMatcher.match as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        resolution: {
          type: 'member_contact',
          matchedMemberId: memberIdLiteral,
          matchedContactId: 'contact-2',
        },
        fuzzyDetail: null,
        unmatchedCandidates: null,
      }),
    );

    const deps = buildDeps(ports);
    const refundReplayInput = {
      ...VALID_INPUT,
      rawPayload: makeWebhookPayload({
        attendee: {
          externalId: 'ext-att-already-refunded',
          email: 'idemp@example.com',
          companyName: 'Diamond Co',
          fullName: 'Idempotent',
          paymentStatus: 'refunded',
        },
      }),
    };

    const result = await ingestWebhookAttendee(refundReplayInput, deps);

    expect(result.ok).toBe(true);
    expect(ports.registrationsRepo.markRefunded).not.toHaveBeenCalled();
    const emitCalls = (ports.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const creditBackRefundCalls = emitCalls.filter(([entry]) => {
      return (entry as { eventType: string }).eventType === 'quota_credit_back_refund';
    });
    expect(creditBackRefundCalls.length).toBe(0);
  });
});
