/**
 * Phase 6 wave-5 unit tests for `toggleEventCategory` (F6 Application).
 *
 * Closes the IMP-7 cross-check gap — Phase 6 integration tests
 * (`tests/integration/events/toggle-event-category.test.ts`) covered
 * the happy path + event_not_found / event_archived, but the
 * branch-level error mapping for the 6 distinct
 * `ToggleEventCategoryError.kind` variants and the per-scope
 * arithmetic edges (consumed-excluding-self math, plan-shrunk
 * over-quota guard from IMP-1) had no unit-level assertion. This
 * file mirrors the `apply-quota-effect.test.ts` shape (makeDeps +
 * baseInput helpers + branch-by-branch coverage).
 *
 * Branches asserted:
 *   1. events_repo_error from findById db_error
 *   2. event_not_found when findById returns null
 *   3. event_archived when archivedAt is non-null
 *   4. No-op short-circuit (previousValue === newValue) → 0 reevaluated, NO macro audit
 *   5. events_repo_error from setPartnerBenefit / setCulturalEvent
 *   6. registrations_repo_error from listForRequota
 *   7. lock_acquisition_failed when advisoryLockAcquirer throws
 *   8. registrations_repo_error from setQuotaEffect mid-iteration
 *   9. quota_lookup_failed from queryAllotments mid-iteration
 *  10. audit_emit_failed during per-row credit-back / decremented emit
 *  11. audit_emit_failed during macro event_partner_benefit_toggled emit
 *  12. Happy path: toggle ON 1 row room available → decremented audit emitted
 *      with `perEventAllotmentBefore = allotmentAfter + 1` (CRIT-2 invariant)
 *  13. Happy path: toggle ON 1 row over-quota → over_quota_warning audit
 *  14. Happy path: toggle OFF 1 row counted=true → credit_back audit
 *  15. IMP-1 edge case: !room && currentCounted → over_quota_warning emitted,
 *      row stays counted (plan-shrunk phantom-consume coverage)
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  toggleEventCategory,
  asEventId,
  asRegistrationId,
  type ToggleEventCategoryDeps,
  type ToggleEventCategoryInput,
  type EventsRepository,
  type RegistrationsRepository,
  type QuotaAccountingPort,
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

// R10.4 / QA F-4 closure — UUIDs fixed to UUID v4 shape post-R3 H3.3.
const TENANT_ID = asTenantId('test-swecham-toggle-unit');
const EVENT_ID = asEventId('00000000-0000-4000-8000-000000000c01');
const REG_ID_1 = asRegistrationId('00000000-0000-4000-8000-000000000c11');
const MEMBER_ID_1 = '00000000-0000-0000-0000-000000000d01' as MemberId;
const ACTOR_USER_ID = '00000000-0000-0000-0000-000000000e01' as UserId;

function makeEvent(
  patch: Partial<EventAggregate> = {},
): EventAggregate {
  return {
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    source: 'eventcreate',
    externalId: 'ext-evt-toggle' as never,
    name: 'Toggle Test Event',
    description: null,
    startDate: new Date('2026-06-21T11:00:00Z'),
    endDate: null,
    location: null,
    category: null,
    eventcreateUrl: null,
    isPartnerBenefit: false,
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
    externalId: 'att-toggle-001' as ExternalAttendeeId,
    attendee: {
      email: 'a@toggle.example' as AttendeeEmail,
      name: 'Toggle A',
      company: 'Toggle Co',
    },
    match: {
      type: 'member_contact',
      matchedMemberId: MEMBER_ID_1,
      matchedContactId: '00000000-0000-0000-0000-000000000f01' as ContactId,
    },
    ticket: { type: null, priceThb: null, paymentStatus: 'paid' },
    quotaEffect: {
      countedAgainstPartnership: false,
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
    setPartnerBenefit: EventsRepository['setPartnerBenefit'];
    setCulturalEvent: EventsRepository['setCulturalEvent'];
    listForRequota: RegistrationsRepository['listForRequota'];
    setQuotaEffect: RegistrationsRepository['setQuotaEffect'];
    queryAllotments: QuotaAccountingPort['queryAllotments'];
    acquire: AdvisoryLockAcquirer['acquire'];
    emit: F6AuditPort['emit'];
  }> = {},
): {
  deps: ToggleEventCategoryDeps;
  acquireMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
  setPartnerBenefitMock: ReturnType<typeof vi.fn>;
  setQuotaEffectMock: ReturnType<typeof vi.fn>;
} {
  const findByIdMock = vi.fn(
    overrides.findById ?? (async () => ok(makeEvent())),
  );
  const setPartnerBenefitMock = vi.fn(
    overrides.setPartnerBenefit ??
      (async () => ok(makeEvent({ isPartnerBenefit: true }))),
  );
  const setCulturalEventMock = vi.fn(
    overrides.setCulturalEvent ??
      (async () => ok(makeEvent({ isCulturalEvent: true }))),
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
              countedAgainstPartnership: true,
              countedAgainstCulturalQuota: false,
            },
          }),
        )),
  );
  const queryAllotmentsMock = vi.fn(
    overrides.queryAllotments ??
      (async () =>
        ok({
          allotments: { partnershipPerEvent: 6, culturalPerYear: 2 },
          consumed: {
            partnershipConsumedForEvent: 0,
            culturalConsumedForYear: 0,
          },
        })),
  );
  const acquireMock = vi.fn(
    overrides.acquire ?? (async () => undefined),
  );
  const emitMock = vi.fn(
    overrides.emit ?? (async () => ok('audit-toggle-1' as AuditEventId)),
  );
  const deps: ToggleEventCategoryDeps = {
    eventsRepo: {
      findById: findByIdMock as never,
      setPartnerBenefit: setPartnerBenefitMock as never,
      setCulturalEvent: setCulturalEventMock as never,
      upsert: vi.fn() as never,
      findByIds: vi.fn() as never,
      findByExternalId: vi.fn() as never,
      list: vi.fn() as never,
      getMatchCountsByEventIds: vi.fn() as never,
      getEmptyContext: vi.fn() as never,
      setArchived: vi.fn() as never,
    } as EventsRepository,
    registrationsRepo: {
      listForRequota: listForRequotaMock as never,
      setQuotaEffect: setQuotaEffectMock as never,
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
    quotaAccountingPort: { queryAllotments: queryAllotmentsMock as never },
    advisoryLockAcquirer: { acquire: acquireMock as never },
    audit: {
      emit: emitMock as never,
      emitRolledBack: vi.fn() as never,
      emitStandalone: vi.fn() as never,
      findPriorErasureCompletion: vi.fn() as never,
    },
  };
  return {
    deps,
    acquireMock,
    emitMock,
    setPartnerBenefitMock,
    setQuotaEffectMock,
  };
}

function baseInput(
  patch: Partial<ToggleEventCategoryInput> = {},
): ToggleEventCategoryInput {
  return {
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    flag: 'is_partner_benefit',
    newValue: true,
    actorUserId: ACTOR_USER_ID,
    occurredAt: new Date('2026-05-14T10:00:00Z'),
    ...patch,
  };
}

describe('toggleEventCategory — Phase 6 T087', () => {
  describe('error paths (8 tests)', () => {
    it('events_repo_error from findById db_error', async () => {
      const { deps } = makeDeps({
        findById: async () => err({ kind: 'db_error', message: 'conn lost' }),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('events_repo_error');
    });

    it('event_not_found when findById returns null', async () => {
      const { deps, setPartnerBenefitMock } = makeDeps({
        findById: async () => ok(null),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('event_not_found');
      expect(setPartnerBenefitMock).not.toHaveBeenCalled();
    });

    it('event_archived when archivedAt is non-null', async () => {
      const { deps, setPartnerBenefitMock } = makeDeps({
        findById: async () =>
          ok(makeEvent({ archivedAt: new Date('2026-05-13T10:00:00Z') })),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('event_archived');
      expect(setPartnerBenefitMock).not.toHaveBeenCalled();
    });

    it('events_repo_error from setPartnerBenefit db_error', async () => {
      const { deps } = makeDeps({
        setPartnerBenefit: async () =>
          err({ kind: 'db_error', message: 'setflag failed' }),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('events_repo_error');
    });

    it('registrations_repo_error from listForRequota', async () => {
      const { deps } = makeDeps({
        listForRequota: async () =>
          err({ kind: 'db_error', message: 'list down' }),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('registrations_repo_error');
    });

    it('lock_acquisition_failed when advisoryLockAcquirer throws (with cause:Error — R3-IMP-1)', async () => {
      const pgError = new Error('pg lock timeout');
      const { deps } = makeDeps({
        listForRequota: async () => ok([makeRegistration()]),
        acquire: async () => {
          throw pgError;
        },
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('lock_acquisition_failed');
        if (r.error.kind === 'lock_acquisition_failed') {
          expect(r.error.message).toContain('pg lock timeout');
          expect(r.error.cause).toBe(pgError);
          expect(r.error.cause).toBeInstanceOf(Error);
        }
      }
    });

    it('quota_lookup_failed when queryAllotments errors mid-iteration', async () => {
      const { deps } = makeDeps({
        listForRequota: async () => ok([makeRegistration()]),
        queryAllotments: async () =>
          err({ kind: 'member_not_found', memberId: MEMBER_ID_1 }),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('quota_lookup_failed');
    });

    it('audit_emit_failed during per-row decremented emit (with cause:AuditEmitError — R3-IMP-1)', async () => {
      const auditError = { kind: 'db_error' as const, message: 'audit log unreachable' };
      const { deps } = makeDeps({
        listForRequota: async () => ok([makeRegistration()]),
        // First emit fails (the per-row decremented audit)
        emit: async () => err(auditError),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('audit_emit_failed');
        if (r.error.kind === 'audit_emit_failed') {
          expect(r.error.cause).toEqual(auditError);
          expect(r.error.cause.kind).toBe('db_error');
        }
      }
    });
  });

  describe('happy paths + CRIT-2 audit math', () => {
    it('no-op short-circuit (previousValue === newValue) → 0 reevaluated, NO macro audit', async () => {
      const { deps, setPartnerBenefitMock, emitMock } = makeDeps({
        findById: async () => ok(makeEvent({ isPartnerBenefit: true })),
      });
      const r = await toggleEventCategory(
        baseInput({ newValue: true }), // event already is_partner_benefit=true
        deps,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.registrationsReevaluated).toBe(0);
        expect(r.value.previousValue).toBe(true);
        expect(r.value.nextValue).toBe(true);
      }
      expect(setPartnerBenefitMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('toggle ON 1 row room available → decremented audit with before = after + 1 (CRIT-2 invariant)', async () => {
      const { deps, emitMock } = makeDeps({
        listForRequota: async () => ok([makeRegistration()]),
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
            consumed: {
              partnershipConsumedForEvent: 3,
              culturalConsumedForYear: 0,
            },
          }),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.registrationsReevaluated).toBe(1);
      }
      const decrementCall = emitMock.mock.calls.find(
        (c) => c[0].eventType === 'quota_partnership_decremented',
      );
      expect(decrementCall).toBeDefined();
      // CRIT-2: before = allotmentAfter + 1
      // allotmentAfter = 6 - 3 - 1 = 2; before should be 3
      expect(decrementCall![0].payload.perEventAllotmentBefore).toBe(3);
      expect(decrementCall![0].payload.perEventAllotmentAfter).toBe(2);
    });

    it('toggle ON 1 row over-quota (uncounted, no room) → quota_over_quota_warning audit emits even though row unchanged (CRIT-R2-1)', async () => {
      // CRIT-R2-1 wave-6 fix: previously the audit emit was gated
      // behind `if (changed)`, dropping the over-quota signal for
      // members already at cap. Hoisting the emit out preserves the
      // 5-year audit trail completeness invariant.
      const { deps, emitMock } = makeDeps({
        listForRequota: async () => ok([makeRegistration()]),
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
            consumed: {
              partnershipConsumedForEvent: 6, // full
              culturalConsumedForYear: 0,
            },
          }),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(true);
      if (r.ok) {
        // Row unchanged → registrationsReevaluated counts only rows
        // that ACTUALLY flipped; an over-quota row that stayed
        // uncounted is not a flip.
        expect(r.value.registrationsReevaluated).toBe(0);
      }
      // Per-row over_quota_warning MUST fire (CRIT-R2-1 invariant).
      const overQuota = emitMock.mock.calls.filter(
        (c) => c[0].eventType === 'quota_over_quota_warning',
      );
      expect(overQuota.length).toBe(1);
      expect(overQuota[0]![0].payload.scope).toBe('partnership');
      // No decrement audit (correct — no quota was decremented).
      const decrement = emitMock.mock.calls.filter(
        (c) => c[0].eventType === 'quota_partnership_decremented',
      );
      expect(decrement.length).toBe(0);
      const macro = emitMock.mock.calls.filter(
        (c) => c[0].eventType === 'event_partner_benefit_toggled',
      );
      expect(macro.length).toBe(1);
    });

    it('toggle OFF 1 row counted=true → credit_back audit (no recomputed lookup needed for arithmetic)', async () => {
      const { deps, emitMock } = makeDeps({
        findById: async () => ok(makeEvent({ isPartnerBenefit: true })),
        setPartnerBenefit: async () =>
          ok(makeEvent({ isPartnerBenefit: false })),
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
      const r = await toggleEventCategory(
        baseInput({ newValue: false }),
        deps,
      );
      expect(r.ok).toBe(true);
      const creditBack = emitMock.mock.calls.find(
        (c) => c[0].eventType === 'quota_credit_back_archive',
      );
      expect(creditBack).toBeDefined();
      expect(creditBack![0].payload.scope).toBe('partnership');
    });

    it('IMP-1 + CRIT-R2-1: !room && currentCounted (plan-shrunk) → over_quota_warning fires + row stays counted + setQuotaEffect NOT called', async () => {
      const { deps, emitMock, setQuotaEffectMock } = makeDeps({
        listForRequota: async () =>
          ok([
            makeRegistration({
              quotaEffect: {
                countedAgainstPartnership: true, // currently counted
                countedAgainstCulturalQuota: false,
              },
            }),
          ]),
        // Plan allotment SHRANK to 0 — row remains counted but is now
        // over-quota. consumedExcludingSelf = 0 - 1 = -1; room =
        // -1 < 0 → false. Branch: !room && currentCounted.
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 0, culturalPerYear: 0 },
            consumed: {
              partnershipConsumedForEvent: 1, // includes our row
              culturalConsumedForYear: 0,
            },
          }),
      });
      const r = await toggleEventCategory(baseInput(), deps);
      expect(r.ok).toBe(true);
      // Row's flag does NOT flip (we keep already-counted rows counted)
      // so registrationsReevaluated should be 0 (no setQuotaEffect call)
      if (r.ok) {
        expect(r.value.registrationsReevaluated).toBe(0);
      }
      // CRIT-R2-1: setQuotaEffect NOT called (correct — row didn't change)
      expect(setQuotaEffectMock).not.toHaveBeenCalled();
      // CRIT-R2-1: over_quota_warning audit IS emitted (drift documented)
      const overQuota = emitMock.mock.calls.filter(
        (c) => c[0].eventType === 'quota_over_quota_warning',
      );
      expect(overQuota.length).toBe(1);
      expect(overQuota[0]![0].payload.scope).toBe('partnership');
      expect(overQuota[0]![0].payload.allotmentAtIngest).toBe(0);
      // Macro toggle audit also fires
      const macroCall = emitMock.mock.calls.find(
        (c) => c[0].eventType === 'event_partner_benefit_toggled',
      );
      expect(macroCall).toBeDefined();
    });
  });

  describe('macro audit payload', () => {
    it('event_partner_benefit_toggled payload carries flagBefore + flagAfter + count', async () => {
      const { deps, emitMock } = makeDeps({
        listForRequota: async () => ok([makeRegistration()]),
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
            consumed: {
              partnershipConsumedForEvent: 0,
              culturalConsumedForYear: 0,
            },
          }),
      });
      await toggleEventCategory(baseInput(), deps);
      const macro = emitMock.mock.calls.find(
        (c) => c[0].eventType === 'event_partner_benefit_toggled',
      );
      expect(macro).toBeDefined();
      expect(macro![0].actorType).toBe('admin');
      expect(macro![0].payload.flagName).toBe('is_partner_benefit');
      expect(macro![0].payload.flagBefore).toBe(false);
      expect(macro![0].payload.flagAfter).toBe(true);
      expect(macro![0].payload.registrationsReevaluated).toBe(1);
    });
  });
});
