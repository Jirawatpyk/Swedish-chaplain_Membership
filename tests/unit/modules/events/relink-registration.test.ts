/**
 * F6 Phase 9 / US6 unit tests for `relinkRegistration` (Round-1
 * code-H1 closure).
 *
 * Pure-Application coverage — substitutes ports with vi.fn() mocks so
 * every branch of the FR-014 algorithm runs without touching Postgres.
 * The live-Neon integration test in
 * `tests/integration/events/relink-registration.test.ts` covers the
 * SQL + advisory-lock interaction + cross-tenant probe; this file
 * covers branch-level error mapping that integration alone can't
 * easily exercise (audit-emit failures, queryAllotments db errors,
 * lock-key invariant violations, mid-flight credit-back failures).
 *
 * Branches asserted:
 *   1. registration_not_found short-circuit
 *   2. registrations_repo_error from findById db_error
 *   3. pseudonymised_row_rejected Application pre-check
 *   4. event_not_found / events_repo_error after registration load
 *   5. event_archived short-circuit
 *   6. same-member noop short-circuit (no audit, no DB write)
 *   7. lock_acquisition_failed (acquire throws plain Error)
 *   8. new_member_not_found (queryAllotments returns member_not_found
 *      or plan_not_found — both collapsed)
 *   9. quota_lookup_failed (queryAllotments db_error on OLD member)
 *  10. audit_emit_failed on credit-back path
 *  11. audit_emit_failed on macro `registration_relinked` emit
 *  12. happy path: non_member→member with NO credit-back (only NEW
 *      member's decrement audit + macro)
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  relinkRegistration,
  asEventId,
  asRegistrationId,
  type EventsRepository,
  type RegistrationsRepository,
  type F6AuditPort,
  type AdvisoryLockAcquirer,
  type EventAggregate,
  type EventRegistrationAggregate,
  type AttendeeEmail,
  type ExternalAttendeeId,
  type RelinkRegistrationDeps,
  type RelinkRegistrationInput,
} from '@/modules/events';
import type { QuotaAccountingPort } from '@/modules/events/application/ports/quota-accounting-port';
import { asTenantId, type MemberId, type ContactId } from '@/modules/members';
import type { AuditEventId, UserId } from '@/modules/auth';

const TENANT_ID = asTenantId('test-swecham-relink');
const EVENT_ID = asEventId('11111111-1111-4111-8111-111111111111');
const REG_ID = asRegistrationId('22222222-2222-4222-8222-222222222222');
const MEMBER_A = '33333333-3333-4333-8333-333333333333' as MemberId;
const MEMBER_B = '44444444-4444-4444-8444-444444444444' as MemberId;
const ACTOR = '55555555-5555-4555-8555-555555555555' as UserId;
const CONTACT_A = '66666666-6666-4666-8666-666666666666' as ContactId;

function makeEvent(patch: Partial<EventAggregate> = {}): EventAggregate {
  return {
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    source: 'eventcreate',
    externalId: 'ext-evt-relink' as never,
    name: 'Relink Test Event',
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
    registrationId: REG_ID,
    eventId: EVENT_ID,
    externalId: 'att-relink' as ExternalAttendeeId,
    attendee: {
      email: 'a@example.com' as AttendeeEmail,
      name: 'Attendee A',
      company: 'Co A',
    },
    match: {
      type: 'member_contact',
      matchedMemberId: MEMBER_A,
      matchedContactId: CONTACT_A,
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

interface MockOverrides {
  findRegistrationById?: RegistrationsRepository['findById'];
  findEventById?: EventsRepository['findById'];
  updateMatchAndQuota?: RegistrationsRepository['updateMatchAndQuota'];
  acquire?: AdvisoryLockAcquirer['acquire'];
  queryAllotments?: QuotaAccountingPort['queryAllotments'];
  emit?: F6AuditPort['emit'];
}

function makeDeps(o: MockOverrides = {}): {
  deps: RelinkRegistrationDeps;
  findRegistrationByIdMock: ReturnType<typeof vi.fn>;
  findEventByIdMock: ReturnType<typeof vi.fn>;
  updateMatchAndQuotaMock: ReturnType<typeof vi.fn>;
  acquireMock: ReturnType<typeof vi.fn>;
  queryAllotmentsMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
} {
  const findRegistrationByIdMock = vi.fn(
    o.findRegistrationById ?? (async () => ok(makeRegistration())),
  );
  const findEventByIdMock = vi.fn(
    o.findEventById ?? (async () => ok(makeEvent())),
  );
  const updateMatchAndQuotaMock = vi.fn(
    o.updateMatchAndQuota ??
      (async () =>
        ok(
          makeRegistration({
            match: {
              type: 'member_contact',
              matchedMemberId: MEMBER_B,
              matchedContactId: null,
            },
            quotaEffect: {
              countedAgainstPartnership: true,
              countedAgainstCulturalQuota: false,
            },
          }),
        )),
  );
  const acquireMock = vi.fn(o.acquire ?? (async () => undefined));
  // Default queryAllotments returns ample quota for both old (consumed=1
  // pre-credit-back) and new (consumed=0 pre-decrement) members.
  const queryAllotmentsMock = vi.fn(
    o.queryAllotments ??
      (async (input: { memberId: MemberId }) =>
        ok({
          allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
          consumed: {
            partnershipConsumedForEvent: input.memberId === MEMBER_A ? 1 : 0,
            culturalConsumedForYear: 0,
          },
        })),
  );
  const emitMock = vi.fn(
    o.emit ?? (async () => ok('audit-1' as AuditEventId)),
  );
  const deps: RelinkRegistrationDeps = {
    eventsRepo: {
      findById: findEventByIdMock as never,
      upsert: vi.fn() as never,
      findByExternalId: vi.fn() as never,
      list: vi.fn() as never,
      getMatchCountsByEventIds: vi.fn() as never,
      getEmptyContext: vi.fn() as never,
      setPartnerBenefit: vi.fn() as never,
      setCulturalEvent: vi.fn() as never,
      setArchived: vi.fn() as never,
    } as EventsRepository,
    registrationsRepo: {
      findById: findRegistrationByIdMock as never,
      updateMatchAndQuota: updateMatchAndQuotaMock as never,
      insertOnConflictDoNothing: vi.fn() as never,
      findByEventId: vi.fn() as never,
      findByEmailLower: vi.fn() as never,
      findByEventAndEmail: vi.fn() as never,
      countConsumedByMember: vi.fn() as never,
      updatePaymentStatus: vi.fn() as never,
      markRefunded: vi.fn() as never,
      listForRequota: vi.fn() as never,
      setQuotaEffect: vi.fn() as never,
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
    },
  };
  return {
    deps,
    findRegistrationByIdMock,
    findEventByIdMock,
    updateMatchAndQuotaMock,
    acquireMock,
    queryAllotmentsMock,
    emitMock,
  };
}

function baseInput(
  patch: Partial<RelinkRegistrationInput> = {},
): RelinkRegistrationInput {
  return {
    tenantId: TENANT_ID,
    registrationId: REG_ID,
    newMatchedMemberId: MEMBER_B,
    // Round-2 code-H1 closure — default to the same event the seeded
    // registration carries so the path-mismatch guard does NOT fire
    // in baseline scenarios; tests that want to exercise the mismatch
    // override `eventIdFromPath` explicitly.
    eventIdFromPath: EVENT_ID,
    actorUserId: ACTOR,
    occurredAt: new Date('2026-05-14T10:00:00Z'),
    ...patch,
  };
}

describe('relinkRegistration — F6 Phase 9 / US6 (Round-1 code-H1)', () => {
  describe('error paths', () => {
    it('registration_not_found when findById returns null', async () => {
      const { deps, findEventByIdMock, updateMatchAndQuotaMock, emitMock } =
        makeDeps({
          findRegistrationById: async () => ok(null),
        });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('registration_not_found');
      expect(findEventByIdMock).not.toHaveBeenCalled();
      expect(updateMatchAndQuotaMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('registrations_repo_error when findById returns db_error', async () => {
      const { deps } = makeDeps({
        findRegistrationById: async () =>
          err({ kind: 'db_error', message: 'connection lost' }),
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('registrations_repo_error');
    });

    it('pseudonymised_row_rejected Application pre-check (before event lookup)', async () => {
      const { deps, findEventByIdMock } = makeDeps({
        findRegistrationById: async () =>
          ok(
            makeRegistration({
              piiPseudonymisedAt: new Date('2025-01-01T00:00:00Z'),
            }),
          ),
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('pseudonymised_row_rejected');
      expect(findEventByIdMock).not.toHaveBeenCalled();
    });

    it('event_not_found when eventsRepo.findById returns null', async () => {
      const { deps } = makeDeps({
        findEventById: async () => ok(null),
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('event_not_found');
    });

    it('events_repo_error when eventsRepo.findById returns db_error (Round-2 test-K closure)', async () => {
      const { deps, updateMatchAndQuotaMock } = makeDeps({
        findEventById: async () =>
          err({ kind: 'db_error', message: 'event lookup blip' }),
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('events_repo_error');
        if (r.error.kind === 'events_repo_error') {
          expect(r.error.message).toContain('event lookup blip');
        }
      }
      expect(updateMatchAndQuotaMock).not.toHaveBeenCalled();
    });

    it('event_path_mismatch (Round-2 code-H1) — URL eventId != registration.eventId → refuse BEFORE any mutation', async () => {
      const otherEvent = asEventId(
        '99999999-9999-4999-8999-999999999999',
      );
      const {
        deps,
        findEventByIdMock,
        updateMatchAndQuotaMock,
        emitMock,
        acquireMock,
      } = makeDeps();
      const r = await relinkRegistration(
        baseInput({ eventIdFromPath: otherEvent }),
        deps,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('event_path_mismatch');
        if (r.error.kind === 'event_path_mismatch') {
          expect(r.error.eventIdInPath).toBe(otherEvent);
          expect(r.error.eventIdOnRegistration).toBe(EVENT_ID);
        }
      }
      // Defence-in-depth: NO downstream calls reached.
      expect(findEventByIdMock).not.toHaveBeenCalled();
      expect(acquireMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
      expect(updateMatchAndQuotaMock).not.toHaveBeenCalled();
    });

    it('event_path_mismatch is skipped when eventIdFromPath=null (callers without URL context)', async () => {
      const {
        deps,
        findEventByIdMock,
        acquireMock,
        emitMock,
        updateMatchAndQuotaMock,
      } = makeDeps();
      const r = await relinkRegistration(
        baseInput({ eventIdFromPath: null }),
        deps,
      );
      // No mismatch firing → happy path proceeds through ALL downstream
      // steps. Round-3 test-M closure — affirmatively assert the
      // happy-path execution (was: only `r.ok === true`, which would
      // pass a regression that silently returns noop on null path).
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.noop).toBe(false);
      // Event lookup ran (would NOT run if path-mismatch had fired).
      expect(findEventByIdMock).toHaveBeenCalled();
      // Locks acquired (sorted-key dual-lock per OLD + NEW members).
      expect(acquireMock).toHaveBeenCalled();
      // Audit emit happened (at least the macro registration_relinked).
      expect(emitMock).toHaveBeenCalled();
      // Final repo write happened.
      expect(updateMatchAndQuotaMock).toHaveBeenCalled();
    });

    it('event_archived when event.archivedAt is non-null', async () => {
      const { deps, updateMatchAndQuotaMock } = makeDeps({
        findEventById: async () =>
          ok(makeEvent({ archivedAt: new Date('2026-05-13T10:00:00Z') })),
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('event_archived');
      expect(updateMatchAndQuotaMock).not.toHaveBeenCalled();
    });

    it('same-member noop short-circuit emits no audit and skips updateMatchAndQuota', async () => {
      const { deps, updateMatchAndQuotaMock, acquireMock, emitMock } =
        makeDeps();
      const r = await relinkRegistration(
        baseInput({ newMatchedMemberId: MEMBER_A }),
        deps,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.noop).toBe(true);
        if (r.value.noop) expect(r.value.matchedMemberId).toBe(MEMBER_A);
      }
      expect(updateMatchAndQuotaMock).not.toHaveBeenCalled();
      expect(acquireMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('lock_acquisition_failed when acquire throws a plain Error', async () => {
      const { deps } = makeDeps({
        acquire: async () => {
          throw new Error('pg lock timeout');
        },
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('lock_acquisition_failed');
        if (r.error.kind === 'lock_acquisition_failed') {
          expect(r.error.cause).toBeInstanceOf(Error);
        }
      }
    });

    it('new_member_not_found collapses queryAllotments member_not_found + plan_not_found', async () => {
      // First call (OLD member) ok; second call (NEW member) returns
      // member_not_found.
      const calls: Array<{ memberId: MemberId }> = [];
      const { deps, updateMatchAndQuotaMock } = makeDeps({
        queryAllotments: async (input) => {
          calls.push({ memberId: input.memberId });
          if (input.memberId === MEMBER_A) {
            return ok({
              allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
              consumed: {
                partnershipConsumedForEvent: 1,
                culturalConsumedForYear: 0,
              },
            });
          }
          return err({ kind: 'member_not_found', memberId: input.memberId });
        },
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('new_member_not_found');
      expect(updateMatchAndQuotaMock).not.toHaveBeenCalled();
    });

    // Round-2 test-H1 closure — split into TWO scenarios (OLD path
    // credit-back vs NEW path decrement) so a regression that reorders
    // the two queryAllotments calls would surface as a message-prefix
    // mismatch in the OPPOSITE test, not silently pass against the
    // wrong path.
    it('quota_lookup_failed (OLD path) — credit-back queryAllotments db_error', async () => {
      const { deps } = makeDeps({
        queryAllotments: async (input) => {
          if (input.memberId === MEMBER_A) {
            return err({
              kind: 'db_error',
              message: 'plan lookup timed out',
            });
          }
          // NEW path returns ok — proves the OLD path failure short-
          // circuited BEFORE the NEW queryAllotments fired.
          return ok({
            allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
            consumed: {
              partnershipConsumedForEvent: 0,
              culturalConsumedForYear: 0,
            },
          });
        },
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('quota_lookup_failed');
        if (r.error.kind === 'quota_lookup_failed') {
          // Prefix uniquely identifies the OLD-member credit-back
          // queryAllotments call site (relink-registration.ts ~line 388).
          expect(r.error.message).toContain('relink credit-back');
        }
      }
    });

    it('quota_lookup_failed (NEW path) — decrement queryAllotments db_error (not member_not_found/plan_not_found)', async () => {
      const { deps } = makeDeps({
        queryAllotments: async (input) => {
          // OLD member resolves cleanly (credit-back proceeds).
          if (input.memberId === MEMBER_A) {
            return ok({
              allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
              consumed: {
                partnershipConsumedForEvent: 1,
                culturalConsumedForYear: 0,
              },
            });
          }
          // NEW member's lookup throws a non-{member,plan}_not_found
          // db_error — must surface as `quota_lookup_failed` (NOT
          // `new_member_not_found`, which is reserved for the 404
          // mapping of member_not_found + plan_not_found).
          return err({
            kind: 'db_error',
            message: 'decrement queryAllotments db error',
          });
        },
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('quota_lookup_failed');
        if (r.error.kind === 'quota_lookup_failed') {
          // Prefix uniquely identifies the NEW-member decrement
          // queryAllotments call site (relink-registration.ts ~line 462).
          expect(r.error.message).toContain('relink decrement');
        }
      }
    });

    it('audit_emit_failed on credit-back path bubbles up', async () => {
      const { deps, updateMatchAndQuotaMock } = makeDeps({
        emit: async (entry) => {
          if (entry.eventType === 'quota_credit_back_archive') {
            return err({ kind: 'db_error', message: 'audit_log full' });
          }
          return ok('audit-x' as AuditEventId);
        },
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('audit_emit_failed');
      expect(updateMatchAndQuotaMock).not.toHaveBeenCalled();
    });

    it('audit_emit_failed on macro registration_relinked emit bubbles up', async () => {
      const { deps } = makeDeps({
        emit: async (entry) => {
          if (entry.eventType === 'registration_relinked') {
            return err({ kind: 'db_error', message: 'audit_log full at macro' });
          }
          return ok('audit-y' as AuditEventId);
        },
      });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('audit_emit_failed');
    });
  });

  describe('happy paths', () => {
    it('non_member → member relink: no credit-back, only NEW decrement + macro', async () => {
      const { deps, emitMock, acquireMock, updateMatchAndQuotaMock } =
        makeDeps({
          findRegistrationById: async () =>
            ok(
              makeRegistration({
                match: {
                  type: 'non_member',
                  matchedMemberId: null,
                  matchedContactId: null,
                },
                quotaEffect: {
                  countedAgainstPartnership: false,
                  countedAgainstCulturalQuota: false,
                },
              }),
            ),
        });
      const r = await relinkRegistration(baseInput(), deps);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.noop).toBe(false);
      if (r.value.noop) return;
      expect(r.value.previousMatchedMemberId).toBeNull();
      expect(r.value.newMatchedMemberId).toBe(MEMBER_B);
      expect(r.value.quotaImpact.creditedBackFor).toBeNull();
      expect(r.value.quotaImpact.decrementedFor).toBe(MEMBER_B);
      expect(r.value.quotaImpact.scopes).toEqual(['partnership']);

      // No credit-back lock; only NEW lock acquired.
      expect(acquireMock).toHaveBeenCalledTimes(1);
      // Audit emits: 1× quota_partnership_decremented + 1× macro.
      const eventTypes = emitMock.mock.calls.map(
        (call) => (call[0] as { eventType: string }).eventType,
      );
      expect(eventTypes).toContain('quota_partnership_decremented');
      expect(eventTypes).toContain('registration_relinked');
      // No credit-back audit (no OLD member, no counted scope).
      expect(eventTypes).not.toContain('quota_credit_back_archive');
      expect(updateMatchAndQuotaMock).toHaveBeenCalledTimes(1);
    });
  });
});
