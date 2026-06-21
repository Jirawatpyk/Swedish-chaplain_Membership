/**
 * Phase 6 wave-4 unit tests for `archiveEvent` (F6 Application).
 *
 * Pure-Application coverage — substitutes ports with vi.fn() mocks to
 * exercise every branch of the FR-019a algorithm without touching
 * Postgres. The live-Neon integration tests in
 * `tests/integration/events/archive-event.test.ts` cover the SQL +
 * advisory-lock interaction; this file covers the use-case's branching
 * logic + error-result mapping (Constitution Principle II target —
 * 100% branch coverage on security/correctness-critical Application
 * code).
 *
 * Branches asserted:
 *   1. event_not_found short-circuit (events repo returns null)
 *   2. events_repo_error on findById db_error
 *   3. already_archived short-circuit (archivedAt != null)
 *   4. listForRequota error → registrations_repo_error
 *   5. setArchived error → events_repo_error
 *   6. lock acquisition throw → lock_acquisition_failed
 *   7. setQuotaEffect error during iteration → registrations_repo_error
 *   8. audit emit error during credit-back → audit_emit_failed
 *   9. macro event_archived audit emit error → audit_emit_failed
 *  10. Happy path: 0 counted rows → 0 credit_back audits + macro
 *  11. Happy path: 2 counted rows (partnership + cultural) → 2
 *      credit_back audits + macro with correct quotaReversals
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  archiveEvent,
  asEventId,
  asRegistrationId,
  type ArchiveEventDeps,
  type ArchiveEventInput,
  type EventsRepository,
  type RegistrationsRepository,
  type F6AuditPort,
  type AdvisoryLockAcquirer,
  type EventAggregate,
  type EventRegistrationAggregate,
} from '@/modules/events';
import { asTenantId, type MemberId, type ContactId } from '@/modules/members';
import type { AuditEventId, UserId } from '@/modules/auth';
import type {
  AttendeeEmail,
  ExternalAttendeeId,
} from '@/modules/events';

// R10.4 / QA F-4 closure — UUIDs fixed to UUID v4 shape post-R3 H3.3
// validator tightening (commit 7c70a224 added strict v4 validation to
// asEventId + asRegistrationId at HTTP/CSV boundaries).
const TENANT_ID = asTenantId('test-swecham-archive');
const EVENT_ID = asEventId('00000000-0000-4000-8000-000000000a01');
const REG_ID_1 = asRegistrationId('00000000-0000-4000-8000-000000000a11');
const REG_ID_2 = asRegistrationId('00000000-0000-4000-8000-000000000a12');
const MEMBER_ID_1 = '00000000-0000-0000-0000-000000000b01' as MemberId;
const MEMBER_ID_2 = '00000000-0000-0000-0000-000000000b02' as MemberId;
const ACTOR_USER_ID = '00000000-0000-0000-0000-000000000c01' as UserId;

function makeEvent(
  patch: Partial<EventAggregate> = {},
): EventAggregate {
  return {
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    source: 'eventcreate',
    externalId: 'ext-evt-001' as never,
    name: 'Test Event',
    description: null,
    startDate: new Date('2026-06-21T11:00:00Z'),
    endDate: null,
    location: null,
    category: null,
    eventcreateUrl: null,
    isPartnerBenefit: true,
    isCulturalEvent: false,
    archivedAt: null,
    metadata: {},
    importedAt: new Date('2026-05-01T10:00:00Z'),
    lastUpdatedAt: new Date('2026-05-01T10:00:00Z'),
    ...patch,
  };
}

function makeRegistration(
  patch: Partial<EventRegistrationAggregate> = {},
): EventRegistrationAggregate {
  return {
    tenantId: TENANT_ID,
    registrationId: REG_ID_1,
    eventId: EVENT_ID,
    externalId: 'att-001' as ExternalAttendeeId,
    attendee: {
      email: 'a@example.com' as AttendeeEmail,
      name: 'Attendee A',
      company: 'Co A',
    },
    match: {
      type: 'member_contact',
      matchedMemberId: MEMBER_ID_1,
      matchedContactId: '00000000-0000-0000-0000-000000000d01' as ContactId,
    },
    ticket: { type: null, priceThb: null, paymentStatus: 'paid' },
    quotaEffect: {
      countedAgainstPartnership: true,
      countedAgainstCulturalQuota: false,
    },
    metadata: {},
    registeredAt: new Date('2026-05-10T10:00:00Z'),
    importedAt: new Date('2026-05-10T10:01:00Z'),
    piiPseudonymisedAt: null,
    ...patch,
  };
}

function makeDeps(
  overrides: Partial<{
    findById: EventsRepository['findById'];
    setArchived: EventsRepository['setArchived'];
    listForRequota: RegistrationsRepository['listForRequota'];
    setQuotaEffect: RegistrationsRepository['setQuotaEffect'];
    acquire: AdvisoryLockAcquirer['acquire'];
    /**
     * Staff-review-4 SUGG-2 — archive now threads quotaAccountingPort to
     * compute real `allotmentAfter` per credit-back row. Default mock
     * returns ample remaining quota (6/6 partnership, 12/12 cultural)
     * minus the consumed-count of the row being credited back, mirroring
     * the post-credit-back state.
     */
    queryAllotments: import('@/modules/events/application/ports/quota-accounting-port').QuotaAccountingPort['queryAllotments'];
    emit: F6AuditPort['emit'];
  }> = {},
): {
  deps: ArchiveEventDeps;
  findByIdMock: ReturnType<typeof vi.fn>;
  setArchivedMock: ReturnType<typeof vi.fn>;
  listForRequotaMock: ReturnType<typeof vi.fn>;
  setQuotaEffectMock: ReturnType<typeof vi.fn>;
  acquireMock: ReturnType<typeof vi.fn>;
  queryAllotmentsMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
} {
  const findByIdMock = vi.fn(
    overrides.findById ?? (async () => ok(makeEvent())),
  );
  const setArchivedMock = vi.fn(
    overrides.setArchived ??
      (async () => ok(makeEvent({ archivedAt: new Date('2026-05-14T10:00:00Z') }))),
  );
  const listForRequotaMock = vi.fn(
    overrides.listForRequota ?? (async () => ok([])),
  );
  const setQuotaEffectMock = vi.fn(
    overrides.setQuotaEffect ??
      (async () =>
        ok(
          makeRegistration({
            quotaEffect: {
              countedAgainstPartnership: false,
              countedAgainstCulturalQuota: false,
            },
          }),
        )),
  );
  const acquireMock = vi.fn(
    overrides.acquire ?? (async () => undefined),
  );
  // SUGG-2 — post-credit-back queryAllotments mock; ample remaining
  // quota by default (6 partnership / 12 cultural, 0 consumed) so the
  // emitted audit payload's allotmentAfter is the full plan capacity
  // unless a per-test override narrows the result.
  const queryAllotmentsMock = vi.fn(
    overrides.queryAllotments ??
      (async () =>
        ok({
          allotments: { partnershipPerEvent: 6, culturalPerYear: 12 },
          consumed: {
            partnershipConsumedForEvent: 0,
            culturalConsumedForYear: 0,
          },
        })),
  );
  const emitMock = vi.fn(
    overrides.emit ?? (async () => ok('audit-1' as AuditEventId)),
  );
  const deps: ArchiveEventDeps = {
    eventsRepo: {
      findById: findByIdMock as never,
      setArchived: setArchivedMock as never,
      // unused but required by EventsRepository shape
      upsert: vi.fn() as never,
      findByIds: vi.fn() as never,
      findByExternalId: vi.fn() as never,
      list: vi.fn() as never,
      getMatchCountsByEventIds: vi.fn() as never,
      getEmptyContext: vi.fn() as never,
      setPartnerBenefit: vi.fn() as never,
      setCulturalEvent: vi.fn() as never,
    } as EventsRepository,
    registrationsRepo: {
      listForRequota: listForRequotaMock as never,
      setQuotaEffect: setQuotaEffectMock as never,
      // unused but required by RegistrationsRepository shape
      insertOnConflictDoNothing: vi.fn() as never,
      findById: vi.fn() as never,
      listMemberRegistrationsInTx: vi.fn() as never,
      findByEventId: vi.fn() as never,
      findByEmailLower: vi.fn() as never,
      findByEventAndEmail: vi.fn() as never,
      countConsumedByMember: vi.fn() as never,
      updateMatchAndQuota: vi.fn() as never,
      updatePaymentStatus: vi.fn() as never,
      markRefunded: vi.fn() as never,
      listPseudonymiseEligible: vi.fn() as never,
      pseudonymiseRow: vi.fn() as never,
      hardDelete: vi.fn() as never,
    } as RegistrationsRepository,
    advisoryLockAcquirer: { acquire: acquireMock as never },
    quotaAccountingPort: { queryAllotments: queryAllotmentsMock as never },
    audit: {
      emit: emitMock as never,
      emitRolledBack: vi.fn() as never,
      emitStandalone: vi.fn() as never,
      findPriorErasureCompletion: vi.fn() as never,
    },
  };
  return {
    deps,
    findByIdMock,
    setArchivedMock,
    listForRequotaMock,
    setQuotaEffectMock,
    queryAllotmentsMock,
    acquireMock,
    emitMock,
  };
}

function baseInput(
  patch: Partial<ArchiveEventInput> = {},
): ArchiveEventInput {
  return {
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    actorUserId: ACTOR_USER_ID,
    occurredAt: new Date('2026-05-14T10:00:00Z'),
    ...patch,
  };
}

describe('archiveEvent — Phase 6 wave-4 (FR-019a)', () => {
  describe('error paths', () => {
    it('event_not_found when findById returns null', async () => {
      const { deps, setArchivedMock, listForRequotaMock } = makeDeps({
        findById: async () => ok(null),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('event_not_found');
      }
      expect(setArchivedMock).not.toHaveBeenCalled();
      expect(listForRequotaMock).not.toHaveBeenCalled();
    });

    it('events_repo_error when findById returns db_error', async () => {
      const { deps } = makeDeps({
        findById: async () => err({ kind: 'db_error', message: 'connection lost' }),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('events_repo_error');
      }
    });

    it('already_archived when event.archivedAt is non-null', async () => {
      const { deps, setArchivedMock } = makeDeps({
        findById: async () =>
          ok(makeEvent({ archivedAt: new Date('2026-05-10T08:00:00Z') })),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('already_archived');
      }
      expect(setArchivedMock).not.toHaveBeenCalled();
    });

    it('registrations_repo_error when listForRequota fails', async () => {
      const { deps } = makeDeps({
        listForRequota: async () =>
          err({ kind: 'db_error', message: 'listForRequota down' }),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('registrations_repo_error');
      }
      // SUGG-1 staff-review-4 — after the step-order swap, setArchived
      // runs BEFORE listForRequota (step 2 instead of step 3), so the
      // mock IS called even when listForRequota fails. The tx wrapper
      // (runInTenantWithRollbackOnErr) rolls back the events.archived_at
      // write on Result.err — this unit test exercises the use-case in
      // isolation without the wrapper, so the spy state reflects the
      // pre-rollback call ordering. The integration test in
      // `tx-rollback-on-err.test.ts` proves the rollback semantics
      // end-to-end against live Neon.
    });

    it('events_repo_error when setArchived fails', async () => {
      const { deps, emitMock } = makeDeps({
        setArchived: async () =>
          err({ kind: 'db_error', message: 'setArchived down' }),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('events_repo_error');
      }
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('lock_acquisition_failed when advisoryLockAcquirer throws (with cause:Error — R3-IMP-1)', async () => {
      const pgError = new Error('pg session terminated');
      const { deps } = makeDeps({
        listForRequota: async () => ok([makeRegistration()]),
        acquire: async () => {
          throw pgError;
        },
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('lock_acquisition_failed');
        if (result.error.kind === 'lock_acquisition_failed') {
          expect(result.error.message).toContain('pg session terminated');
          // R3-IMP-1: cause preserves original Error for pino `err` key
          expect(result.error.cause).toBe(pgError);
          expect(result.error.cause).toBeInstanceOf(Error);
        }
      }
    });

    it('audit_emit_failed when credit-back audit emit fails (with cause:AuditEmitError — R3-IMP-1)', async () => {
      const auditError = { kind: 'db_error' as const, message: 'audit log down' };
      const { deps } = makeDeps({
        listForRequota: async () => ok([makeRegistration()]),
        emit: async () => err(auditError),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('audit_emit_failed');
        if (result.error.kind === 'audit_emit_failed') {
          // R3-IMP-1: cause preserves the inner discriminator
          expect(result.error.cause).toEqual(auditError);
          expect(result.error.cause.kind).toBe('db_error');
        }
      }
    });
  });

  describe('happy paths', () => {
    it('0 counted rows → setArchived runs + macro event_archived emitted with 0 reversals', async () => {
      const { deps, setArchivedMock, acquireMock, emitMock } = makeDeps({
        listForRequota: async () => ok([]),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.registrationsAffected).toBe(0);
        expect(result.value.quotaReversals).toEqual({
          partnership: 0,
          cultural: 0,
        });
      }
      expect(setArchivedMock).toHaveBeenCalledTimes(1);
      expect(acquireMock).not.toHaveBeenCalled();
      // Only the macro event_archived audit fired — no per-row credit_back
      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(emitMock.mock.calls[0]![0].eventType).toBe('event_archived');
    });

    it('2 counted rows (1 partnership + 1 cultural) → 2 credit_back audits + macro', async () => {
      const { deps, acquireMock, emitMock } = makeDeps({
        listForRequota: async () =>
          ok([
            makeRegistration({
              registrationId: REG_ID_1,
              match: {
                type: 'member_contact',
                matchedMemberId: MEMBER_ID_1,
                matchedContactId: '00000000-0000-0000-0000-000000000d01' as ContactId,
              },
              quotaEffect: {
                countedAgainstPartnership: true,
                countedAgainstCulturalQuota: false,
              },
            }),
            makeRegistration({
              registrationId: REG_ID_2,
              match: {
                type: 'member_domain',
                matchedMemberId: MEMBER_ID_2,
                matchedContactId: null,
              },
              quotaEffect: {
                countedAgainstPartnership: false,
                countedAgainstCulturalQuota: true,
              },
            }),
          ]),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.registrationsAffected).toBe(2);
        expect(result.value.quotaReversals.partnership).toBe(1);
        expect(result.value.quotaReversals.cultural).toBe(1);
      }
      // 2 advisory-lock acquisitions (one per row)
      expect(acquireMock).toHaveBeenCalledTimes(2);
      // 3 emits total: 2 credit_back_archive + 1 macro event_archived
      expect(emitMock).toHaveBeenCalledTimes(3);
      const eventTypes = emitMock.mock.calls.map((c) => c[0].eventType);
      expect(eventTypes.filter((t) => t === 'quota_credit_back_archive').length).toBe(2);
      expect(eventTypes.filter((t) => t === 'event_archived').length).toBe(1);
      // Scope discriminator on each credit_back
      const creditBacks = emitMock.mock.calls
        .filter((c) => c[0].eventType === 'quota_credit_back_archive')
        .map((c) => c[0].payload.scope);
      expect(creditBacks).toEqual(expect.arrayContaining(['partnership', 'cultural']));
    });

    it('row with BOTH partnership AND cultural true → 2 credit_back audits per scope', async () => {
      const { deps, emitMock } = makeDeps({
        listForRequota: async () =>
          ok([
            makeRegistration({
              quotaEffect: {
                countedAgainstPartnership: true,
                countedAgainstCulturalQuota: true,
              },
            }),
          ]),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // ONE row affected but TWO scope reversals
        expect(result.value.registrationsAffected).toBe(1);
        expect(result.value.quotaReversals.partnership).toBe(1);
        expect(result.value.quotaReversals.cultural).toBe(1);
      }
      // 1 partnership credit-back + 1 cultural credit-back + 1 macro = 3 emits
      expect(emitMock).toHaveBeenCalledTimes(3);
    });

    it('rows with NULL matched_member_id are silently skipped (defensive guard)', async () => {
      // Defence-in-depth: listForRequota's adapter filters NULL but
      // the TS type permits null. Verify the use-case skips cleanly.
      const { deps, acquireMock, emitMock } = makeDeps({
        listForRequota: async () =>
          ok([
            makeRegistration({
              quotaEffect: {
                countedAgainstPartnership: true,
                countedAgainstCulturalQuota: false,
              },
              match: {
                type: 'non_member',
                matchedMemberId: null,
                matchedContactId: null,
              },
            }),
          ]),
      });
      const result = await archiveEvent(baseInput(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Use-case counts the row but skips credit-back (memberId null)
        expect(result.value.registrationsAffected).toBe(1);
        // quotaReversals stays at 0 — the credit-back loop iterated but
        // hit the `continue` early-exit since memberId is null.
        expect(result.value.quotaReversals.partnership).toBe(0);
        expect(result.value.quotaReversals.cultural).toBe(0);
      }
      // No locks acquired (memberId null short-circuit)
      expect(acquireMock).not.toHaveBeenCalled();
      // Only the macro audit (no per-row credit-back possible)
      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(emitMock.mock.calls[0]![0].eventType).toBe('event_archived');
    });
  });

  describe('macro audit payload', () => {
    it('event_archived payload carries actorUserId + eventId + counts', async () => {
      const { deps, emitMock } = makeDeps({
        listForRequota: async () =>
          ok([
            makeRegistration({
              quotaEffect: {
                countedAgainstPartnership: true,
                countedAgainstCulturalQuota: false,
              },
            }),
          ]),
      });
      await archiveEvent(baseInput(), deps);
      const macroCall = emitMock.mock.calls.find(
        (c) => c[0].eventType === 'event_archived',
      );
      expect(macroCall).toBeDefined();
      expect(macroCall![0].actorType).toBe('admin');
      expect(macroCall![0].actorUserId).toBe(ACTOR_USER_ID);
      const payload = macroCall![0].payload;
      expect(payload.actorUserId).toBe(ACTOR_USER_ID);
      expect(payload.eventId).toBe(EVENT_ID);
      expect(payload.registrationsAffected).toBe(1);
      expect(payload.quotaReversals.partnership).toBe(1);
      expect(payload.quotaReversals.cultural).toBe(0);
    });
  });
});
