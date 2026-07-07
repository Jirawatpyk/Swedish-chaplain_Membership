/**
 * F6 remediation PR 2.1 / P2 (FR-032a by-email erasure BACKEND) — unit tests
 * for the `searchAttendeeRegistrationsByEmail` read-only use-case.
 *
 * The use-case enumerates every registration sharing an attendee email (via
 * `registrationsRepo.findByEmailLower`) and enriches each with its event name +
 * CE start date via a SINGLE batched `eventDetailsBatchLookup.findByIds` (no
 * N+1 — mirrors runListEventNamesByIds). The contract these tests lock:
 *
 *   - MAPPING: each aggregate → { registrationId, eventId, eventName,
 *     eventStartDateIso, matchType, countedPartnership, countedCultural,
 *     attendeeName, attendeeEmail, isPseudonymised } with the enriched name/date.
 *   - EMPTY PASSTHROUGH: no rows → { matches: [] } WITHOUT calling findByIds.
 *   - REPO ERROR: findByEmailLower err → Result.err (registrations_repo_error).
 *   - DEGRADE: findByIds err → eventName/eventStartDateIso null (non-critical
 *     enrichment), NOT a use-case error (mirrors runListEventNamesByIds).
 *
 * Pure Application — the two collaborators are plain deps so the use-case is
 * unit-testable without a real tx.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  searchAttendeeRegistrationsByEmail,
  type SearchAttendeeRegistrationsByEmailDeps,
} from '@/modules/events/application/use-cases/search-attendee-registrations-by-email';
import type {
  EventRegistrationAggregate,
  MatchResolutionView,
} from '@/modules/events/domain/event-registration';
import type { EventAggregate } from '@/modules/events/domain/event';
import type { TenantId } from '@/modules/members';

const TENANT = 't-1' as TenantId;

function makeAggregate(
  overrides: Partial<EventRegistrationAggregate> = {},
): EventRegistrationAggregate {
  const base = {
    tenantId: TENANT,
    registrationId: 'r-1',
    eventId: 'e-1',
    externalId: 'ext-1',
    attendee: { email: 'guest@x.com', name: 'Guest One', company: null },
    match: {
      type: 'non_member',
      matchedMemberId: null,
      matchedContactId: null,
    } satisfies MatchResolutionView,
    ticket: { type: null, priceThb: null, paymentStatus: 'free' },
    quotaEffect: {
      countedAgainstPartnership: false,
      countedAgainstCulturalQuota: false,
    },
    metadata: {},
    registeredAt: new Date('2026-06-01T00:00:00Z'),
    importedAt: new Date('2026-06-01T00:00:00Z'),
    piiPseudonymisedAt: null,
  };
  return { ...base, ...overrides } as unknown as EventRegistrationAggregate;
}

function makeEvent(name: string, startIso: string): EventAggregate {
  return { name, startDate: new Date(startIso) } as unknown as EventAggregate;
}

describe('searchAttendeeRegistrationsByEmail (F6 P2 read-only)', () => {
  it('maps each row and enriches event name + CE start date via ONE batched lookup', async () => {
    const partnershipReg = makeAggregate({
      registrationId: 'r-a' as EventRegistrationAggregate['registrationId'],
      eventId: 'e-a' as EventRegistrationAggregate['eventId'],
      match: {
        type: 'member_contact',
        matchedMemberId: 'm-1',
        matchedContactId: null,
      } as MatchResolutionView,
      quotaEffect: {
        countedAgainstPartnership: true,
        countedAgainstCulturalQuota: false,
      },
      attendee: { email: 'guest@x.com', name: 'Guest A', company: 'Acme' } as EventRegistrationAggregate['attendee'],
    });
    const culturalReg = makeAggregate({
      registrationId: 'r-b' as EventRegistrationAggregate['registrationId'],
      eventId: 'e-b' as EventRegistrationAggregate['eventId'],
      match: {
        type: 'member_domain',
        matchedMemberId: 'm-1',
        matchedContactId: null,
      } as MatchResolutionView,
      quotaEffect: {
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: true,
      },
      piiPseudonymisedAt: new Date('2026-06-10T00:00:00Z') as unknown as Date,
      attendee: { email: 'guest@x.com', name: 'Guest B', company: null } as EventRegistrationAggregate['attendee'],
    });

    const findByIds = vi.fn(
      async (
        _tenantId: TenantId,
        _eventIds: ReadonlyArray<EventAggregate['eventId']>,
      ) =>
        ok(
          new Map([
            ['e-a', makeEvent('Cultural Night', '2026-05-01T12:00:00Z')],
            ['e-b', makeEvent('Trade Mixer', '2026-06-15T09:00:00Z')],
          ] as unknown as [EventAggregate['eventId'], EventAggregate][]),
        ),
    );
    const deps: SearchAttendeeRegistrationsByEmailDeps = {
      registrationsRepo: {
        findByEmailLower: vi.fn(async () =>
          ok({ rows: [partnershipReg, culturalReg], truncated: false }),
        ),
      },
      eventDetailsBatchLookup: { findByIds },
    };

    const res = await searchAttendeeRegistrationsByEmail(
      { tenantId: TENANT, emailLower: 'guest@x.com' },
      deps,
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.value.matches).toHaveLength(2);
    expect(res.value.truncated).toBe(false);

    // Exactly ONE batched lookup (no N+1), with both unique event ids.
    expect(findByIds).toHaveBeenCalledTimes(1);
    const eventIdsArg = findByIds.mock.calls[0]?.[1] ?? [];
    expect(new Set(eventIdsArg.map(String))).toEqual(new Set(['e-a', 'e-b']));

    const [m0, m1] = res.value.matches;
    expect(m0).toMatchObject({
      registrationId: 'r-a',
      eventId: 'e-a',
      eventName: 'Cultural Night',
      eventStartDateIso: '2026-05-01T12:00:00.000Z',
      matchType: 'member_contact',
      countedPartnership: true,
      countedCultural: false,
      attendeeName: 'Guest A',
      attendeeEmail: 'guest@x.com',
      isPseudonymised: false,
    });
    expect(m1).toMatchObject({
      registrationId: 'r-b',
      eventId: 'e-b',
      eventName: 'Trade Mixer',
      eventStartDateIso: '2026-06-15T09:00:00.000Z',
      matchType: 'member_domain',
      countedPartnership: false,
      countedCultural: true,
      attendeeName: 'Guest B',
      attendeeEmail: 'guest@x.com',
      isPseudonymised: true,
    });
  });

  it('empty passthrough — no rows returns { matches: [] } WITHOUT calling findByIds', async () => {
    const findByIds = vi.fn(async () => ok(new Map()));
    const deps: SearchAttendeeRegistrationsByEmailDeps = {
      registrationsRepo: {
        findByEmailLower: vi.fn(async () => ok({ rows: [], truncated: false })),
      },
      eventDetailsBatchLookup: { findByIds },
    };

    const res = await searchAttendeeRegistrationsByEmail(
      { tenantId: TENANT, emailLower: 'nobody@x.com' },
      deps,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.matches).toEqual([]);
    expect(res.value.truncated).toBe(false);
    expect(findByIds).not.toHaveBeenCalled();
  });

  it('findByEmailLower repo error → Result.err (registrations_repo_error)', async () => {
    const deps: SearchAttendeeRegistrationsByEmailDeps = {
      registrationsRepo: {
        findByEmailLower: vi.fn(async () =>
          err({ kind: 'db_error' as const, message: 'connection reset' }),
        ),
      },
      eventDetailsBatchLookup: { findByIds: vi.fn(async () => ok(new Map())) },
    };

    const res = await searchAttendeeRegistrationsByEmail(
      { tenantId: TENANT, emailLower: 'guest@x.com' },
      deps,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('registrations_repo_error');
    expect(res.error.cause).toMatchObject({ kind: 'db_error' });
  });

  it('batch-lookup error DEGRADES to null event name/date, not a use-case error', async () => {
    const reg = makeAggregate();
    const deps: SearchAttendeeRegistrationsByEmailDeps = {
      registrationsRepo: {
        findByEmailLower: vi.fn(async () => ok({ rows: [reg], truncated: false })),
      },
      eventDetailsBatchLookup: {
        findByIds: vi.fn(async () =>
          err({ kind: 'db_error' as const, message: 'events read blip' }),
        ),
      },
    };

    const res = await searchAttendeeRegistrationsByEmail(
      { tenantId: TENANT, emailLower: 'guest@x.com' },
      deps,
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.value.matches).toHaveLength(1);
    expect(res.value.matches[0]).toMatchObject({
      eventName: null,
      eventStartDateIso: null,
      registrationId: 'r-1',
    });
  });

  it('propagates truncated:true from the repo to the output (completeness signal)', async () => {
    // >CAP rows sharing the email → the repo caps the returned set and reports
    // truncated:true. The preview MUST surface this so an admin knows the list
    // is incomplete (residual PII survives beyond the cap) — I-1 review finding.
    const reg = makeAggregate();
    const deps: SearchAttendeeRegistrationsByEmailDeps = {
      registrationsRepo: {
        findByEmailLower: vi.fn(async () => ok({ rows: [reg], truncated: true })),
      },
      eventDetailsBatchLookup: { findByIds: vi.fn(async () => ok(new Map())) },
    };

    const res = await searchAttendeeRegistrationsByEmail(
      { tenantId: TENANT, emailLower: 'guest@x.com' },
      deps,
    );

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.value.truncated).toBe(true);
    expect(res.value.matches).toHaveLength(1);
  });
});
