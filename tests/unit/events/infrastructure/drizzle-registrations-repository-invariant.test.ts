/**
 * R5.2.1 / Round 4 I-1 — read-time invariant defense unit test.
 *
 * Pins the R3.4.2 contract: `drizzleRegistrationsRepository.toAggregate`
 * catches `MatchResolutionInvariantError` from the H3.2
 * `asMatchResolutionView` boundary, emits a structured forensic log,
 * bumps the P1-alert metric, and re-throws.
 *
 * Without this test, a future refactor that drops the
 * `eventcreateMetrics.matchResolutionInvariantViolation(...)` call
 * silently disables the P1 alert. The throw still happens and
 * integration tests still see row failures, but the *observability*
 * layer (which the SRE incident runbook depends on) goes dark.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { _toAggregateForTesting } from '@/modules/events/infrastructure/drizzle-registrations-repository';
import { MatchResolutionInvariantError } from '@/modules/events/domain/event-registration';
import type { EventRegistrationRow } from '@/modules/events/infrastructure/schema';

// Tenant + IDs as plain UUIDs (the brand cast happens inside toAggregate).
const TENANT = 'tenant-slug';
const REG_ID = '11111111-2222-4333-8444-555555555555';
const EVT_ID = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';
const MEMBER_ID = '99999999-8888-4777-bccc-666666666666';
const CONTACT_ID = '77777777-6666-4555-9444-333333333333';
const EXT_ID = 'ext-attendee-1';

function makeRow(overrides: Partial<EventRegistrationRow>): EventRegistrationRow {
  return {
    registrationId: REG_ID,
    tenantId: TENANT,
    eventId: EVT_ID,
    externalId: EXT_ID,
    attendeeEmail: 'attendee@example.com',
    attendeeEmailLower: 'attendee@example.com',
    attendeeName: 'Test Attendee',
    attendeeCompany: 'Test Co',
    matchType: 'member_contact',
    matchedMemberId: MEMBER_ID,
    matchedContactId: CONTACT_ID,
    ticketType: 'Standard',
    ticketPriceThb: 1000,
    paymentStatus: 'paid',
    countedAgainstPartnership: false,
    countedAgainstCulturalQuota: false,
    metadata: {},
    registeredAt: new Date('2026-05-01T00:00:00Z'),
    importedAt: new Date('2026-05-01T00:00:00Z'),
    piiPseudonymisedAt: null,
    attendeePdpaConsentAcknowledged: null,
    ...overrides,
  } as EventRegistrationRow;
}

describe('R5.2.1 — drizzleRegistrationsRepository.toAggregate read-time invariant defense', () => {
  let metricSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    metricSpy = vi
      .spyOn(eventcreateMetrics, 'matchResolutionInvariantViolation')
      .mockImplementation(() => {});
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('valid member_contact row → returns aggregate + does NOT bump metric or log', () => {
    const aggregate = _toAggregateForTesting(makeRow({}));
    expect(aggregate.match.type).toBe('member_contact');
    expect(aggregate.registrationId).toBe(REG_ID);
    expect(metricSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_match_resolution_invariant_violation',
      }),
      expect.any(String),
    );
  });

  it('valid non_member row with both nulls → returns aggregate + does NOT bump metric', () => {
    const aggregate = _toAggregateForTesting(
      makeRow({
        matchType: 'non_member',
        matchedMemberId: null,
        matchedContactId: null,
      }),
    );
    expect(aggregate.match.type).toBe('non_member');
    expect(metricSpy).not.toHaveBeenCalled();
  });

  it('INVARIANT VIOLATION — member_contact with matchedContactId=null → bumps metric + emits structured log + re-throws', () => {
    const badRow = makeRow({
      matchType: 'member_contact',
      matchedMemberId: MEMBER_ID,
      matchedContactId: null, // <-- violates invariant
    });

    expect(() => _toAggregateForTesting(badRow)).toThrow(MatchResolutionInvariantError);

    expect(metricSpy).toHaveBeenCalledTimes(1);
    expect(metricSpy).toHaveBeenCalledWith(TENANT);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_match_resolution_invariant_violation',
        tenantId: TENANT,
        registrationId: REG_ID,
        eventId: EVT_ID,
        matchType: 'member_contact',
        matchedMemberId: 'set',
        matchedContactId: null,
      }),
      expect.stringContaining('READ time'),
    );
  });

  it('INVARIANT VIOLATION — unmatched with matchedContactId set → bumps metric + emits log + re-throws', () => {
    const badRow = makeRow({
      matchType: 'unmatched',
      matchedMemberId: null,
      matchedContactId: CONTACT_ID, // <-- violates invariant
    });

    expect(() => _toAggregateForTesting(badRow)).toThrow(MatchResolutionInvariantError);
    expect(metricSpy).toHaveBeenCalledWith(TENANT);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'f6_match_resolution_invariant_violation',
        matchType: 'unmatched',
        matchedMemberId: null,
        matchedContactId: 'set',
      }),
      expect.any(String),
    );
  });

  it('INVARIANT VIOLATION — error preserves MatchResolutionInvariantError instance shape', () => {
    const badRow = makeRow({
      matchType: 'member_domain',
      matchedMemberId: null,
      matchedContactId: null, // member_domain requires matchedMemberId !== null
    });

    let captured: unknown;
    try {
      _toAggregateForTesting(badRow);
    } catch (e) {
      captured = e;
    }

    expect(captured).toBeInstanceOf(MatchResolutionInvariantError);
    expect((captured as MatchResolutionInvariantError).name).toBe(
      'MatchResolutionInvariantError',
    );
    expect((captured as MatchResolutionInvariantError).raw.type).toBe(
      'member_domain',
    );
  });
});
