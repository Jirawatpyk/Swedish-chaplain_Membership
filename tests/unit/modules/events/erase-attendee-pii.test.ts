/**
 * #16 unit tests for `eraseAttendeePii` (F6 Phase 10).
 *
 * Bug: the credit-back path read `wasPartnership/wasCultural/memberId`
 * from the PRE-LOCK snapshot (step 1 `findById`). A concurrent
 * toggle/refund could flip those flags between the snapshot and the lock
 * acquisition → a stale credit-back audit / `quotaReversals` count
 * (audit-fidelity only; the row is still hard-deleted and live consumed
 * self-heals on read).
 *
 * Fix:
 *   (a) widen the lock gate to `memberId !== null` (acquire whenever a
 *       member is matched, so the re-read is serialised even if the stale
 *       snapshot said not-counted);
 *   (b) after acquire, re-fetch the registration UNDER the lock and
 *       recompute `wasPartnership/wasCultural/memberId` from the FRESH row;
 *   (c) emit credit-back + count `quotaReversals` from the FRESH flags;
 *       a null re-read (concurrent hard-delete) is treated as
 *       already-handled — no credit-back, early-return ok(alreadyErased).
 *
 * Pure-Application coverage (vi.fn ports). The live-Neon path is covered
 * by tests/integration/events/pii-erasure.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok } from '@/lib/result';
import {
  eraseAttendeePii,
  type EraseAttendeePiiDeps,
  type EraseAttendeePiiInput,
  type EventsRepository,
  type RegistrationsRepository,
  type F6AuditPort,
  type AdvisoryLockAcquirer,
  type EventAggregate,
  type EventRegistrationAggregate,
  type AttendeeEmail,
  type ExternalAttendeeId,
} from '@/modules/events';
import type { ContactId } from '@/modules/members';
import type { AuditEventId } from '@/modules/auth';
import {
  mkEventId,
  mkRegistrationId,
  mkMemberId,
  mkUserId,
} from '../../../helpers/brand-fixtures';
import { asTenantId } from '@/modules/members';

const TENANT_ID = asTenantId('test-swecham-erase');
const EVENT_ID = mkEventId('11111111-1111-4111-8111-111111111111');
const REG_ID = mkRegistrationId('22222222-2222-4222-8222-222222222222');
const MEMBER = mkMemberId('33333333-3333-4333-8333-333333333333');
const CONTACT = '66666666-6666-4666-8666-666666666666' as ContactId;
const ACTOR = mkUserId('55555555-5555-4555-8555-555555555555');

function makeEvent(patch: Partial<EventAggregate> = {}): EventAggregate {
  return {
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    source: 'eventcreate',
    externalId: 'ext-evt-erase' as never,
    name: 'Erase Test Event',
    description: null,
    // Asia/Bangkok calendar year 2026 → lock-key year segment `2026`.
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
    externalId: 'att-erase' as ExternalAttendeeId,
    attendee: {
      email: 'attendee@example.com' as AttendeeEmail,
      name: 'Erase Me',
      company: 'Co E',
    },
    match: {
      type: 'member_contact',
      matchedMemberId: MEMBER,
      matchedContactId: CONTACT,
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

interface MockOverrides {
  findRegistrationById?: RegistrationsRepository['findById'];
  findEventById?: EventsRepository['findById'];
  hardDelete?: RegistrationsRepository['hardDelete'];
  acquire?: AdvisoryLockAcquirer['acquire'];
  emit?: F6AuditPort['emit'];
  findPriorErasureCompletion?: F6AuditPort['findPriorErasureCompletion'];
}

function makeDeps(o: MockOverrides = {}): {
  deps: EraseAttendeePiiDeps;
  findRegistrationByIdMock: ReturnType<typeof vi.fn>;
  findEventByIdMock: ReturnType<typeof vi.fn>;
  hardDeleteMock: ReturnType<typeof vi.fn>;
  acquireMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
  findPriorErasureCompletionMock: ReturnType<typeof vi.fn>;
} {
  const findRegistrationByIdMock = vi.fn(
    o.findRegistrationById ?? (async () => ok(makeRegistration())),
  );
  const findEventByIdMock = vi.fn(
    o.findEventById ?? (async () => ok(makeEvent())),
  );
  const hardDeleteMock = vi.fn(
    o.hardDelete ?? (async () => ok(makeRegistration())),
  );
  const acquireMock = vi.fn(o.acquire ?? (async () => undefined));
  const emitMock = vi.fn(o.emit ?? (async () => ok('audit-1' as AuditEventId)));
  const findPriorErasureCompletionMock = vi.fn(
    o.findPriorErasureCompletion ?? (async () => ok(false)),
  );

  const deps: EraseAttendeePiiDeps = {
    eventsRepo: {
      findById: findEventByIdMock as never,
      findByIds: vi.fn() as never,
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
      hardDelete: hardDeleteMock as never,
      listMemberRegistrationsInTx: vi.fn() as never,
      updateMatchAndQuota: vi.fn() as never,
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
    } as unknown as RegistrationsRepository,
    advisoryLockAcquirer: { acquire: acquireMock as never },
    audit: {
      emit: emitMock as never,
      emitRolledBack: vi.fn() as never,
      emitStandalone: vi.fn() as never,
      findPriorErasureCompletion: findPriorErasureCompletionMock as never,
    },
  };
  return {
    deps,
    findRegistrationByIdMock,
    findEventByIdMock,
    hardDeleteMock,
    acquireMock,
    emitMock,
    findPriorErasureCompletionMock,
  };
}

function baseInput(
  patch: Partial<EraseAttendeePiiInput> = {},
): EraseAttendeePiiInput {
  return {
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    registrationId: REG_ID,
    actorUserId: ACTOR,
    reasonText: 'DPO request 2026-07',
    occurredAt: new Date('2026-07-07T10:00:00Z'),
    ...patch,
  };
}

function emittedTypes(emitMock: ReturnType<typeof vi.fn>): string[] {
  return emitMock.mock.calls.map(
    (call) => (call[0] as { eventType: string }).eventType,
  );
}

describe('eraseAttendeePii — #16 re-read quota flags under the lock', () => {
  it('stale-flip (snapshot counted=true, under-lock re-read counted=false) → zero reversals, NO credit-back audit', async () => {
    const { deps, findRegistrationByIdMock, emitMock } = makeDeps();
    // Snapshot: partnership counted. Under-lock re-read: a concurrent
    // refund un-counted the row.
    findRegistrationByIdMock
      .mockResolvedValueOnce(
        ok(
          makeRegistration({
            quotaEffect: {
              countedAgainstPartnership: true,
              countedAgainstCulturalQuota: false,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        ok(
          makeRegistration({
            quotaEffect: {
              countedAgainstPartnership: false,
              countedAgainstCulturalQuota: false,
            },
          }),
        ),
      );
    const r = await eraseAttendeePii(baseInput(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.quotaReversals).toEqual({ partnership: 0, cultural: 0 });
    expect(emittedTypes(emitMock)).not.toContain('quota_credit_back_archive');
    // Completed audit still emitted (the erasure itself succeeded).
    expect(emittedTypes(emitMock)).toContain('pii_erasure_completed');
  });

  it('inverse (snapshot counted=false, under-lock re-read counted=true) → credit-back fires with fresh reversal counts', async () => {
    const { deps, findRegistrationByIdMock, emitMock, acquireMock } = makeDeps();
    // Snapshot: NOT counted (widened gate must still acquire the lock on
    // memberId !== null). Under-lock re-read: a concurrent toggle made the
    // row counted on BOTH scopes.
    findRegistrationByIdMock
      .mockResolvedValueOnce(
        ok(
          makeRegistration({
            quotaEffect: {
              countedAgainstPartnership: false,
              countedAgainstCulturalQuota: false,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        ok(
          makeRegistration({
            quotaEffect: {
              countedAgainstPartnership: true,
              countedAgainstCulturalQuota: true,
            },
          }),
        ),
      );
    const r = await eraseAttendeePii(baseInput(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Lock acquired even though the snapshot said not-counted.
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(r.value.quotaReversals).toEqual({ partnership: 1, cultural: 1 });
    const types = emittedTypes(emitMock);
    expect(types.filter((t) => t === 'quota_credit_back_archive')).toHaveLength(
      2,
    );
    expect(types).toContain('pii_erasure_completed');
  });

  it('null re-read (concurrent hard-delete) → graceful completion, zero reversals, no credit-back, no throw', async () => {
    const { deps, findRegistrationByIdMock, emitMock, hardDeleteMock } =
      makeDeps();
    findRegistrationByIdMock
      .mockResolvedValueOnce(
        ok(
          makeRegistration({
            quotaEffect: {
              countedAgainstPartnership: true,
              countedAgainstCulturalQuota: false,
            },
          }),
        ),
      )
      // Row vanished under the lock (concurrent hard-delete).
      .mockResolvedValueOnce(ok(null));
    const r = await eraseAttendeePii(baseInput(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.alreadyErased).toBe(true);
    expect(r.value.quotaReversals).toEqual({ partnership: 0, cultural: 0 });
    expect(emittedTypes(emitMock)).not.toContain('quota_credit_back_archive');
    // Early-return BEFORE hardDelete (which would 'invariant_violation' on
    // a vanished row).
    expect(hardDeleteMock).not.toHaveBeenCalled();
  });

  it('the advisory lock is acquired BEFORE the under-lock re-read', async () => {
    const { deps, findRegistrationByIdMock, acquireMock } = makeDeps();
    findRegistrationByIdMock
      .mockResolvedValueOnce(
        ok(
          makeRegistration({
            quotaEffect: {
              countedAgainstPartnership: true,
              countedAgainstCulturalQuota: false,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        ok(
          makeRegistration({
            quotaEffect: {
              countedAgainstPartnership: true,
              countedAgainstCulturalQuota: false,
            },
          }),
        ),
      );
    const r = await eraseAttendeePii(baseInput(), deps);
    expect(r.ok).toBe(true);
    expect(acquireMock).toHaveBeenCalledTimes(1);
    expect(findRegistrationByIdMock).toHaveBeenCalledTimes(2);
    const firstFindOrder =
      findRegistrationByIdMock.mock.invocationCallOrder[0]!;
    const reReadOrder = findRegistrationByIdMock.mock.invocationCallOrder[1]!;
    const acquireOrder = acquireMock.mock.invocationCallOrder[0]!;
    // step-1 load < acquire < under-lock re-read.
    expect(firstFindOrder).toBeLessThan(acquireOrder);
    expect(acquireOrder).toBeLessThan(reReadOrder);
  });

  it('registration_not_found idempotency preserved: initial load null + no prior completion → registration_not_found', async () => {
    const { deps, acquireMock } = makeDeps({
      findRegistrationById: async () => ok(null),
      findPriorErasureCompletion: async () => ok(false),
    });
    const r = await eraseAttendeePii(baseInput(), deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('registration_not_found');
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it('idempotent retry: initial load null + prior completion → ok(alreadyErased)', async () => {
    const { deps } = makeDeps({
      findRegistrationById: async () => ok(null),
      findPriorErasureCompletion: async () => ok(true),
    });
    const r = await eraseAttendeePii(baseInput(), deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.alreadyErased).toBe(true);
      expect(r.value.quotaReversals).toEqual({ partnership: 0, cultural: 0 });
    }
  });

  it('event_path_mismatch guard fires BEFORE any lock / re-read', async () => {
    const otherEvent = mkEventId('99999999-9999-4999-8999-999999999999');
    const { deps, acquireMock, findRegistrationByIdMock } = makeDeps({
      findRegistrationById: async () =>
        ok(makeRegistration({ eventId: otherEvent })),
    });
    const r = await eraseAttendeePii(baseInput(), deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('event_path_mismatch');
    // Only the step-1 load ran; no lock, no re-read.
    expect(acquireMock).not.toHaveBeenCalled();
    expect(findRegistrationByIdMock).toHaveBeenCalledTimes(1);
  });
});
