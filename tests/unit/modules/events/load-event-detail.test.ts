/**
 * Unit tests for `loadEventDetail` use-case branches that need
 * direct coverage beyond what the contract test mocks reach.
 *
 * M4 round-3 (2026-05-12): UUID v4 regex guard on `input.eventId`
 * — malformed IDs must surface as `{ kind: 'not_found' }` BEFORE
 * the repo is invoked (avoids Postgres parse-error noise in alerts).
 *
 * PR 1.2 (F6 remediation #7, 2026-07-07) — `isOverQuota` was derived
 * from `isNonQuotaMatchType(r.match.type)`, which is true ONLY for
 * `non_member`/`unmatched`. That inverted the signal:
 *   - the REAL over-quota case (a matched member whose seat couldn't
 *     be counted because the allotment was exhausted →
 *     `counted_against_*=false`) never showed the badge (US4 AS2 /
 *     FR-017 violated), and
 *   - every `non_member`/`unmatched` attendee on a partner/cultural
 *     event showed a SPURIOUS "over quota" badge (FR-013 — these rows
 *     never had quota to exhaust).
 *
 * The fixed derivation mirrors the NEGATION of `apply-quota-effect.ts`'s
 * `quota_over_quota_warning` emission condition (also gated the same
 * way `processAttendeeInTx`'s `shouldApplyQuota` gates the call):
 * active (non-archived) benefit event + matched member + confirmed
 * seat (`paid`/`free`) + the scope's `counted_against_*` flag is
 * false. `makeReg` below independently parameterises `matchedMemberId`,
 * `paymentStatus`, and BOTH `countedAgainst*` flags so each cell of
 * that truth table can be exercised on its own.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok } from '@/lib/result';
import { loadEventDetail } from '@/modules/events/application/use-cases/load-event-detail';
import type {
  EventsRepository,
  RegistrationsRepository,
  PaymentStatus,
} from '@/modules/events';
import { asTenantId, asMemberId, asContactId, type MemberId } from '@/modules/members';
import { asEventId, asExternalEventId, asRegistrationId, asExternalAttendeeId, asAttendeeEmail } from '@/modules/events';

const VALID_UUID = 'a1b2c3d4-1234-4abc-89de-fedcba987654';
const TENANT_ID = asTenantId('test-tenant');

// T-LOW-3: use a Record mapped over the EventsRepository keys so a
// future port-method addition (e.g., Phase 6 `archiveById`) fails this
// test at compile time instead of silently being missing from the mock.
type MockRecord<T> = { [K in keyof T]: ReturnType<typeof vi.fn> };

function makeMockEventsRepo(): EventsRepository {
  const mock: MockRecord<EventsRepository> = {
    findById: vi.fn(),
    findByIds: vi.fn(),
    findByExternalId: vi.fn(),
    upsert: vi.fn(),
    list: vi.fn(),
    getMatchCountsByEventIds: vi.fn(),
    getEmptyContext: vi.fn(),
    setArchived: vi.fn(),
    setPartnerBenefit: vi.fn(),
    setCulturalEvent: vi.fn(),
  };
  return mock as unknown as EventsRepository;
}

function makeMockRegistrationsRepo(): RegistrationsRepository {
  const mock: MockRecord<RegistrationsRepository> = {
    insertOnConflictDoNothing: vi.fn(),
    findById: vi.fn(),
    listMemberRegistrationsInTx: vi.fn(),
    findByEventId: vi.fn(),
    findByEmailLower: vi.fn(),
    findByEventAndEmail: vi.fn(),
    countConsumedByMember: vi.fn(),
    updateMatchAndQuota: vi.fn(),
    updatePaymentStatus: vi.fn(),
    setQuotaEffect: vi.fn(),
    markRefunded: vi.fn(),
    listForRequota: vi.fn(),
    listPseudonymiseEligible: vi.fn(),
    pseudonymiseRow: vi.fn(),
    hardDelete: vi.fn(),
  };
  return mock as unknown as RegistrationsRepository;
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
        paymentStatusFilter: null,
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
        paymentStatusFilter: null,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(eventsRepo.findById).not.toHaveBeenCalled();
  });
});

describe('loadEventDetail — isOverQuota truth table (PR 1.2 F6 remediation #7)', () => {
  function makeEvent(opts: {
    isPartnerBenefit: boolean;
    isCulturalEvent: boolean;
    archived?: boolean;
  }) {
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
      archivedAt: opts.archived === true ? new Date('2026-06-15T00:00:00Z') : null,
      metadata: {},
      importedAt: new Date('2026-06-01T10:00:00Z'),
      lastUpdatedAt: new Date('2026-06-01T10:00:00Z'),
    };
  }

  /**
   * Independently parameterises the four axes the fixed `isOverQuota`
   * derivation reads: whether the row is matched to a member, the
   * ticket's payment status, and the two `countedAgainst*` scope
   * flags. `matchedMemberId: null` maps to `match.type: 'non_member'`
   * (both `non_member` and `unmatched` are quota-neutral per FR-013 —
   * `non_member` is enough to exercise that branch here).
   */
  function makeReg(opts: {
    matchedMemberId: MemberId | null;
    paymentStatus: PaymentStatus;
    countedAgainstPartnership: boolean;
    countedAgainstCulturalQuota: boolean;
  }) {
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
      match:
        opts.matchedMemberId !== null
          ? {
              type: 'member_contact' as const,
              matchedMemberId: opts.matchedMemberId,
              matchedContactId: asContactId(VALID_UUID),
            }
          : {
              type: 'non_member' as const,
              matchedMemberId: null,
              matchedContactId: null,
            },
      ticket: {
        type: null,
        priceThb: null,
        paymentStatus: opts.paymentStatus,
      },
      quotaEffect: {
        countedAgainstPartnership: opts.countedAgainstPartnership,
        countedAgainstCulturalQuota: opts.countedAgainstCulturalQuota,
      },
      metadata: {},
      registeredAt: new Date('2026-06-01T10:00:00Z'),
      importedAt: new Date('2026-06-01T10:00:00Z'),
      piiPseudonymisedAt: null,
    };
  }

  const MEMBER_ID = asMemberId(VALID_UUID);

  it.each<
    [
      label: string,
      eventOpts: { isPartnerBenefit: boolean; isCulturalEvent: boolean; archived?: boolean },
      regOpts: {
        matchedMemberId: MemberId | null;
        paymentStatus: PaymentStatus;
        countedAgainstPartnership: boolean;
        countedAgainstCulturalQuota: boolean;
      },
      expected: boolean,
    ]
  >([
    // ---- 1-5: partnership scope --------------------------------------
    [
      '1. partner + member_contact + paid + partnership counted=false → TRUE (the real over-quota case)',
      { isPartnerBenefit: true, isCulturalEvent: false },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'paid',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      true,
    ],
    [
      '2. partner + member_contact + paid + partnership counted=true → FALSE',
      { isPartnerBenefit: true, isCulturalEvent: false },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'paid',
        countedAgainstPartnership: true,
        countedAgainstCulturalQuota: false,
      },
      false,
    ],
    [
      '3. partner + non_member + paid → FALSE (never had quota to exhaust)',
      { isPartnerBenefit: true, isCulturalEvent: false },
      {
        matchedMemberId: null,
        paymentStatus: 'paid',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      false,
    ],
    [
      '4. partner + member_contact + pending + counted=false → FALSE (unconfirmed seat)',
      { isPartnerBenefit: true, isCulturalEvent: false },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'pending',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      false,
    ],
    [
      '5. partner + member_contact + refunded + counted=false → FALSE',
      { isPartnerBenefit: true, isCulturalEvent: false },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'refunded',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      false,
    ],
    // ---- 6a-6e: cultural mirrors of 1-5 -------------------------------
    [
      '6a. cultural + member_contact + paid + cultural counted=false → TRUE',
      { isPartnerBenefit: false, isCulturalEvent: true },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'paid',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      true,
    ],
    [
      '6b. cultural + member_contact + paid + cultural counted=true → FALSE',
      { isPartnerBenefit: false, isCulturalEvent: true },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'paid',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: true,
      },
      false,
    ],
    [
      '6c. cultural + non_member + paid → FALSE',
      { isPartnerBenefit: false, isCulturalEvent: true },
      {
        matchedMemberId: null,
        paymentStatus: 'paid',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      false,
    ],
    [
      '6d. cultural + member_contact + pending + counted=false → FALSE',
      { isPartnerBenefit: false, isCulturalEvent: true },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'pending',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      false,
    ],
    [
      '6e. cultural + member_contact + refunded + counted=false → FALSE',
      { isPartnerBenefit: false, isCulturalEvent: true },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'refunded',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      false,
    ],
    // ---- 7: independent scopes on a dual-flag event -------------------
    [
      '7. BOTH flags + member_contact + paid + partnership counted=true + cultural counted=false → TRUE',
      { isPartnerBenefit: true, isCulturalEvent: true },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'paid',
        countedAgainstPartnership: true,
        countedAgainstCulturalQuota: false,
      },
      true,
    ],
    // ---- 8: archived event gate ----------------------------------------
    [
      '8. archived partner event + member_contact + paid + counted=false → FALSE (eventActiveBenefit gate)',
      { isPartnerBenefit: true, isCulturalEvent: false, archived: true },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'paid',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      false,
    ],
    // ---- bonus: neither flag on the event never shows the badge --------
    [
      '9. neither flag + member_contact + paid + counted=false (both scopes) → FALSE',
      { isPartnerBenefit: false, isCulturalEvent: false },
      {
        matchedMemberId: MEMBER_ID,
        paymentStatus: 'paid',
        countedAgainstPartnership: false,
        countedAgainstCulturalQuota: false,
      },
      false,
    ],
  ])('%s', async (_label, eventOpts, regOpts, expected) => {
    const eventsRepo = makeMockEventsRepo();
    const registrationsRepo = makeMockRegistrationsRepo();
    const event = makeEvent(eventOpts);
    const reg = makeReg(regOpts);
    vi.mocked(eventsRepo.findById).mockResolvedValueOnce(ok(event));
    vi.mocked(registrationsRepo.findByEventId).mockResolvedValueOnce(
      ok({
        items: [reg],
        totalCount: 1,
        matchCounts: {
          memberContact: regOpts.matchedMemberId !== null ? 1 : 0,
          memberDomain: 0,
          memberFuzzy: 0,
          nonMember: regOpts.matchedMemberId === null ? 1 : 0,
          unmatched: 0,
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
        paymentStatusFilter: null,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.registrations[0]!.isOverQuota).toBe(expected);
  });
});
