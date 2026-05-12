/**
 * Unit tests for `loadEventDetail` use-case branches that need
 * direct coverage beyond what the contract test mocks reach.
 *
 * M4 round-3 (2026-05-12): UUID v4 regex guard on `input.eventId`
 * — malformed IDs must surface as `{ kind: 'not_found' }` BEFORE
 * the repo is invoked (avoids Postgres parse-error noise in alerts).
 *
 * M5 round-3 (2026-05-12): `isOverQuota` derived flag — the contract
 * tests pin the `false` branch; here we cover the `true` branch (event
 * is partner-benefit OR cultural AND registration is non-quota match
 * type) + the cross-cell boundaries.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok } from '@/lib/result';
import { loadEventDetail } from '@/modules/events/application/use-cases/load-event-detail';
import type {
  EventsRepository,
  RegistrationsRepository,
} from '@/modules/events';
import { asTenantId } from '@/modules/members';
import { asEventId, asExternalEventId, asRegistrationId, asExternalAttendeeId, asAttendeeEmail } from '@/modules/events';

const VALID_UUID = 'a1b2c3d4-1234-4abc-89de-fedcba987654';
const TENANT_ID = asTenantId('test-tenant');

function makeMockEventsRepo(): EventsRepository {
  return {
    findById: vi.fn(),
    findByExternalId: vi.fn(),
    upsert: vi.fn(),
    list: vi.fn(),
    getMatchCountsByEventIds: vi.fn(),
    getEmptyContext: vi.fn(),
    setArchived: vi.fn(),
    setPartnerBenefit: vi.fn(),
    setCulturalEvent: vi.fn(),
  } as unknown as EventsRepository;
}

function makeMockRegistrationsRepo(): RegistrationsRepository {
  return {
    insertOnConflictDoNothing: vi.fn(),
    findById: vi.fn(),
    findByEventId: vi.fn(),
    findByEmailLower: vi.fn(),
    countConsumedByMember: vi.fn(),
    updateMatchAndQuota: vi.fn(),
    listPseudonymiseEligible: vi.fn(),
    pseudonymiseRow: vi.fn(),
    hardDelete: vi.fn(),
  } as unknown as RegistrationsRepository;
}

describe('loadEventDetail — UUID v4 guard (M4 round-3)', () => {
  it('returns not_found on malformed eventId WITHOUT hitting the repo', async () => {
    const eventsRepo = makeMockEventsRepo();
    const registrationsRepo = makeMockRegistrationsRepo();
    const result = await loadEventDetail(
      { eventsRepo, registrationsRepo },
      {
        tenantId: TENANT_ID,
        eventId: 'not-a-uuid',
        page: 1,
        pageSize: 50,
        unmatchedOnly: false,
        matchTypeFilter: null,
        q: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not_found');
    }
    // Repo must NOT be called when format is invalid — that's the
    // whole point of the early-return guard.
    expect(eventsRepo.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['empty string', ''],
    ['SQL injection attempt', "a1b2c3d4-1234-4abc-89de-fedcba987654'; DROP TABLE events; --"],
    ['UUID v1 (timestamp variant)', 'a1b2c3d4-1234-1abc-89de-fedcba987654'],
    ['UUID v7 (sortable variant)', 'a1b2c3d4-1234-7abc-89de-fedcba987654'],
    ['UUID with bad variant byte', 'a1b2c3d4-1234-4abc-79de-fedcba987654'],
    ['too short', '01958e58'],
    ['way too long', 'a'.repeat(200)],
  ])('rejects %s as not_found', async (_label, badId) => {
    const eventsRepo = makeMockEventsRepo();
    const registrationsRepo = makeMockRegistrationsRepo();
    const result = await loadEventDetail(
      { eventsRepo, registrationsRepo },
      {
        tenantId: TENANT_ID,
        eventId: badId,
        page: 1,
        pageSize: 50,
        unmatchedOnly: false,
        matchTypeFilter: null,
        q: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(eventsRepo.findById).not.toHaveBeenCalled();
  });
});

describe('loadEventDetail — isOverQuota truth table (M5 round-3)', () => {
  function makeEvent(opts: { isPartnerBenefit: boolean; isCulturalEvent: boolean }) {
    return {
      tenantId: TENANT_ID,
      eventId: asEventId(VALID_UUID),
      source: 'eventcreate' as const,
      externalId: asExternalEventId('evt-ext-1'),
      name: 'Test',
      description: null,
      startDate: new Date('2026-06-01T10:00:00Z'),
      endDate: null,
      location: null,
      category: null,
      eventcreateUrl: null,
      isPartnerBenefit: opts.isPartnerBenefit,
      isCulturalEvent: opts.isCulturalEvent,
      archivedAt: null,
      metadata: {},
      importedAt: new Date('2026-06-01T10:00:00Z'),
      lastUpdatedAt: new Date('2026-06-01T10:00:00Z'),
    };
  }

  function makeReg(matchType: 'member_contact' | 'non_member' | 'unmatched') {
    return {
      tenantId: TENANT_ID,
      registrationId: asRegistrationId(VALID_UUID),
      eventId: asEventId(VALID_UUID),
      externalId: asExternalAttendeeId('att-ext-1'),
      attendee: {
        email: asAttendeeEmail('test@example.com'),
        name: 'Test',
        company: null,
      },
      match: {
        type: matchType,
        matchedMemberId: null,
        matchedContactId: null,
      },
      ticket: {
        type: null,
        priceThb: null,
        paymentStatus: 'paid' as const,
      },
      quotaEffect: {
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      metadata: {},
      registeredAt: new Date('2026-06-01T10:00:00Z'),
      importedAt: new Date('2026-06-01T10:00:00Z'),
      piiPseudonymisedAt: null,
    };
  }

  it.each([
    // [isPartnerBenefit, isCulturalEvent, matchType, expectedIsOverQuota, label]
    [true, false, 'non_member', true, 'partner-benefit + non_member → over quota'],
    [false, true, 'unmatched', true, 'cultural + unmatched → over quota'],
    [true, true, 'non_member', true, 'both flags + non_member → over quota'],
    [false, false, 'non_member', false, 'neither flag + non_member → NOT over quota'],
    [true, false, 'member_contact', false, 'partner-benefit + member_contact → NOT over quota'],
    [false, true, 'member_contact', false, 'cultural + member_contact → NOT over quota'],
    [false, false, 'member_contact', false, 'neither + member_contact → NOT over quota'],
  ])(
    'isPartnerBenefit=%s isCulturalEvent=%s matchType=%s → isOverQuota=%s (%s)',
    async (isPartner, isCultural, matchType, expected) => {
      const eventsRepo = makeMockEventsRepo();
      const registrationsRepo = makeMockRegistrationsRepo();
      const event = makeEvent({ isPartnerBenefit: isPartner, isCulturalEvent: isCultural });
      const reg = makeReg(matchType as 'member_contact' | 'non_member' | 'unmatched');
      vi.mocked(eventsRepo.findById).mockResolvedValueOnce(ok(event));
      vi.mocked(registrationsRepo.findByEventId).mockResolvedValueOnce(
        ok({
          items: [reg],
          totalCount: 1,
          matchCounts: {
            memberContact: matchType === 'member_contact' ? 1 : 0,
            memberDomain: 0,
            memberFuzzy: 0,
            nonMember: matchType === 'non_member' ? 1 : 0,
            unmatched: matchType === 'unmatched' ? 1 : 0,
          },
        }),
      );
      const result = await loadEventDetail(
        { eventsRepo, registrationsRepo },
        {
          tenantId: TENANT_ID,
          eventId: VALID_UUID,
          page: 1,
          pageSize: 50,
          unmatchedOnly: false,
          matchTypeFilter: null,
          q: null,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.registrations[0]!.isOverQuota).toBe(expected);
    },
  );
});
