/**
 * T085 unit tests for `applyQuotaEffect` (F6 Phase 6).
 *
 * Pure-Application coverage — substitutes ports with vi.fn() mocks to
 * exercise every branch of the decision matrix without touching Postgres.
 * Integration tests in `tests/integration/events/quota-accounting.test.ts`
 * (T084) cover the live-DB happy paths + property-based concurrency.
 *
 * Branches asserted (Constitution Principle II — 100% branch coverage
 * target for security/correctness-critical Application code):
 *
 *   1. Short-circuit: refunded payment status → neutral, NO lock, NO audit
 *   2. Short-circuit: both event flags false → neutral, NO lock, NO audit
 *   3. Lock acquisition failure → Result.err{lock_acquisition_failed}
 *   4. queryAllotments failure → Result.err{quota_lookup_failed,cause}
 *   5. Partnership decrement (room available) → emit decremented audit + flag=true
 *   6. Partnership over-quota → emit over_quota_warning audit + flag=false
 *   7. Cultural decrement (room available) → emit decremented audit + flag=true
 *   8. Cultural over-quota → emit over_quota_warning audit + flag=false
 *   9. Both flags set (partner-benefit AND cultural) → two audits emitted
 *  10. Audit emit failure → Result.err{audit_emit_failed} (FR-037 strict-tx)
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  applyQuotaEffect,
  buildQuotaLockKey,
  NEUTRAL_QUOTA_EFFECT,
  InvalidLockKeyError,
  type ApplyQuotaEffectDeps,
  type ApplyQuotaEffectInput,
  type QuotaAccountingPort,
  type AdvisoryLockAcquirer,
  type F6AuditPort,
  asEventId,
  asRegistrationId,
} from '@/modules/events';
import { asTenantId, type MemberId } from '@/modules/members';
import type { AuditEventId } from '@/modules/auth';

const TENANT_ID = asTenantId('test-swecham-quota');
const MEMBER_ID = '00000000-0000-0000-0000-000000000001' as MemberId;
const EVENT_ID = asEventId('00000000-0000-0000-0000-000000000010');
const REG_ID = asRegistrationId('00000000-0000-0000-0000-000000000020');
const FY = 2026;

function makeDeps(
  overrides: Partial<{
    queryAllotments: QuotaAccountingPort['queryAllotments'];
    acquire: AdvisoryLockAcquirer['acquire'];
    emit: F6AuditPort['emit'];
  }> = {},
): {
  deps: ApplyQuotaEffectDeps;
  acquireMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
  queryAllotmentsMock: ReturnType<typeof vi.fn>;
} {
  const acquireMock = vi.fn(
    overrides.acquire ?? (async () => undefined),
  );
  const emitMock = vi.fn(
    overrides.emit ??
      (async () => ok('audit-event-id-1' as AuditEventId)),
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
  const deps: ApplyQuotaEffectDeps = {
    quotaAccountingPort: { queryAllotments: queryAllotmentsMock as never },
    advisoryLockAcquirer: { acquire: acquireMock as never },
    audit: {
      emit: emitMock as never,
      emitRolledBack: vi.fn() as never,
      emitStandalone: vi.fn() as never,
      findPriorErasureCompletion: vi.fn() as never,
    },
  };
  return { deps, acquireMock, emitMock, queryAllotmentsMock };
}

function baseInput(
  patch: Partial<ApplyQuotaEffectInput> = {},
): ApplyQuotaEffectInput {
  return {
    tenantId: TENANT_ID,
    matchedMemberId: MEMBER_ID,
    eventId: EVENT_ID,
    registrationId: REG_ID,
    eventFlags: { isPartnerBenefit: true, isCulturalEvent: false },
    fiscalYear: FY,
    paymentStatus: 'paid',
    actorType: 'zapier_webhook',
    actorUserId: null,
    occurredAt: new Date('2026-05-14T10:00:00Z'),
    ...patch,
  };
}

describe('applyQuotaEffect — Phase 6 T085', () => {
  describe('short-circuit paths (no lock, no audit, no plan lookup)', () => {
    it('refunded payment status → neutral effect, lock NOT acquired', async () => {
      const { deps, acquireMock, emitMock, queryAllotmentsMock } = makeDeps();
      const result = await applyQuotaEffect(
        baseInput({ paymentStatus: 'refunded' }),
        deps,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quotaEffect).toEqual(NEUTRAL_QUOTA_EFFECT);
        expect(result.value.emittedAuditEventTypes).toEqual([]);
      }
      expect(acquireMock).not.toHaveBeenCalled();
      expect(queryAllotmentsMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    it('both event flags false → neutral effect, lock NOT acquired', async () => {
      const { deps, acquireMock, emitMock, queryAllotmentsMock } = makeDeps();
      const result = await applyQuotaEffect(
        baseInput({
          eventFlags: { isPartnerBenefit: false, isCulturalEvent: false },
        }),
        deps,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quotaEffect).toEqual(NEUTRAL_QUOTA_EFFECT);
        expect(result.value.emittedAuditEventTypes).toEqual([]);
      }
      expect(acquireMock).not.toHaveBeenCalled();
      expect(queryAllotmentsMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });
  });

  describe('error paths (lock, lookup, audit)', () => {
    it('advisory lock acquisition throws → lock_acquisition_failed (with cause:Error — R3-IMP-1)', async () => {
      const pgError = new Error('pg session lost');
      const { deps } = makeDeps({
        acquire: async () => {
          throw pgError;
        },
      });
      const result = await applyQuotaEffect(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('lock_acquisition_failed');
        if (result.error.kind === 'lock_acquisition_failed') {
          expect(result.error.message).toContain('pg session lost');
          // R3-IMP-1: assert cause carries original Error so future
          // refactor that drops `cause: e` from wrapLockFailure fails here.
          expect(result.error.cause).toBe(pgError);
          expect(result.error.cause).toBeInstanceOf(Error);
        }
      }
    });

    it('advisory lock catch normalises non-Error throw → synthetic Error preserved on cause (R3-CRIT-3)', async () => {
      const { deps } = makeDeps({
        acquire: async () => {
          // simulate a non-Error throw (string) — pre-R3 would log `cause: {}`
          throw 'lock-string-throw';
        },
      });
      const result = await applyQuotaEffect(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === 'lock_acquisition_failed') {
        expect(result.error.cause).toBeInstanceOf(Error);
        expect(result.error.cause.message).toContain('non-error throw');
        expect(result.error.cause.message).toContain('lock-string-throw');
      }
    });

    it('InvalidLockKeyError from acquire → lock_key_invariant_violation (NOT generic lock_acquisition_failed) — R3-CRIT-2', async () => {
      // Simulate a programmer-error path: the lock-key validator throws.
      // Pre-R3 this would bucket as `lock_acquisition_failed` (retry-eligible)
      // and SRE retry runbook would loop the bug. R3-CRIT-2 routes it to
      // `lock_key_invariant_violation` (page on-call, DO NOT retry).
      const lockKeyError = new InvalidLockKeyError('eventcreate_quota:bad-underscore');
      const { deps } = makeDeps({
        acquire: async () => {
          throw lockKeyError;
        },
      });
      const result = await applyQuotaEffect(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('lock_key_invariant_violation');
        if (result.error.kind === 'lock_key_invariant_violation') {
          expect(result.error.cause).toBe(lockKeyError);
          expect(result.error.cause).toBeInstanceOf(InvalidLockKeyError);
        }
      }
    });

    it('queryAllotments returns err → quota_lookup_failed with cause', async () => {
      const { deps } = makeDeps({
        queryAllotments: async () =>
          err({ kind: 'member_not_found', memberId: MEMBER_ID }),
      });
      const result = await applyQuotaEffect(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('quota_lookup_failed');
        if (result.error.kind === 'quota_lookup_failed') {
          expect(result.error.cause.kind).toBe('member_not_found');
        }
      }
    });

    it('audit emit returns err → audit_emit_failed with cause:AuditEmitError (FR-037 strict-tx + R3-IMP-1)', async () => {
      const auditError = { kind: 'db_error' as const, message: 'audit log unavailable' };
      const { deps } = makeDeps({
        emit: async () => err(auditError),
      });
      const result = await applyQuotaEffect(baseInput(), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('audit_emit_failed');
        if (result.error.kind === 'audit_emit_failed') {
          expect(result.error.message).toContain('audit log unavailable');
          // R3-IMP-1: cause preserves the inner AuditEmitError
          // discriminator so SRE can pattern-match on db_error vs
          // enum_value_unknown without re-parsing the message.
          expect(result.error.cause).toEqual(auditError);
          expect(result.error.cause.kind).toBe('db_error');
        }
      }
    });
  });

  describe('partnership-benefit branch (US4 AS1 + AS2)', () => {
    it('room available (consumed < allotment) → quota_partnership_decremented + flag true', async () => {
      const { deps, emitMock } = makeDeps({
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
            consumed: {
              partnershipConsumedForEvent: 3, // 3 of 6 used → room
              culturalConsumedForYear: 0,
            },
          }),
      });
      const result = await applyQuotaEffect(baseInput(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quotaEffect).toEqual({
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: false,
        });
        expect(result.value.emittedAuditEventTypes).toEqual([
          'quota_partnership_decremented',
        ]);
      }
      expect(emitMock).toHaveBeenCalledTimes(1);
      const emitArg = emitMock.mock.calls[0]![0];
      expect(emitArg.eventType).toBe('quota_partnership_decremented');
      expect(emitArg.payload.perEventAllotmentBefore).toBe(3); // 6 - 3 consumed
      expect(emitArg.payload.perEventAllotmentAfter).toBe(2);
    });

    it('AS2: full allotment consumed (7th ticket on Diamond-6) → quota_over_quota_warning + flag false', async () => {
      const { deps, emitMock } = makeDeps({
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
            consumed: {
              partnershipConsumedForEvent: 6, // all used
              culturalConsumedForYear: 0,
            },
          }),
      });
      const result = await applyQuotaEffect(baseInput(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quotaEffect).toEqual({
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: false,
        });
        expect(result.value.emittedAuditEventTypes).toEqual([
          'quota_over_quota_warning',
        ]);
      }
      const emitArg = emitMock.mock.calls[0]![0];
      expect(emitArg.eventType).toBe('quota_over_quota_warning');
      expect(emitArg.payload.scope).toBe('partnership');
      expect(emitArg.payload.allotmentAtIngest).toBe(0);
    });

    it('zero-allotment plan (Standard tier, partnership=null) → over_quota_warning', async () => {
      const { deps, emitMock } = makeDeps({
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 0, culturalPerYear: 0 },
            consumed: {
              partnershipConsumedForEvent: 0,
              culturalConsumedForYear: 0,
            },
          }),
      });
      const result = await applyQuotaEffect(baseInput(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quotaEffect.countedAgainstPartnership).toBe(false);
        expect(result.value.emittedAuditEventTypes).toEqual([
          'quota_over_quota_warning',
        ]);
      }
      expect(emitMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('cultural-event branch (US4 AS3)', () => {
    it('AS3: room available → quota_cultural_decremented + flag true', async () => {
      const { deps, emitMock } = makeDeps({
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 0, culturalPerYear: 2 },
            consumed: {
              partnershipConsumedForEvent: 0,
              culturalConsumedForYear: 0, // Premium-2 fresh year
            },
          }),
      });
      const result = await applyQuotaEffect(
        baseInput({
          eventFlags: { isPartnerBenefit: false, isCulturalEvent: true },
        }),
        deps,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quotaEffect).toEqual({
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: true,
        });
        expect(result.value.emittedAuditEventTypes).toEqual([
          'quota_cultural_decremented',
        ]);
      }
      const emitArg = emitMock.mock.calls[0]![0];
      expect(emitArg.eventType).toBe('quota_cultural_decremented');
      expect(emitArg.payload.fiscalYear).toBe(FY);
      expect(emitArg.payload.annualAllotmentBefore).toBe(2);
      expect(emitArg.payload.annualAllotmentAfter).toBe(1);
    });

    it('cultural over-quota (all 2 used) → over_quota_warning scope=cultural', async () => {
      const { deps, emitMock } = makeDeps({
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 0, culturalPerYear: 2 },
            consumed: {
              partnershipConsumedForEvent: 0,
              culturalConsumedForYear: 2,
            },
          }),
      });
      const result = await applyQuotaEffect(
        baseInput({
          eventFlags: { isPartnerBenefit: false, isCulturalEvent: true },
        }),
        deps,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quotaEffect.countedAgainstCulturalQuota).toBe(false);
        expect(result.value.emittedAuditEventTypes).toEqual([
          'quota_over_quota_warning',
        ]);
      }
      expect(emitMock.mock.calls[0]![0].payload.scope).toBe('cultural');
    });
  });

  describe('dual-flag event (partner-benefit AND cultural)', () => {
    it('both flags set + both have room → emits TWO audits', async () => {
      const { deps, emitMock } = makeDeps({
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 4, culturalPerYear: 2 },
            consumed: {
              partnershipConsumedForEvent: 1,
              culturalConsumedForYear: 0,
            },
          }),
      });
      const result = await applyQuotaEffect(
        baseInput({
          eventFlags: { isPartnerBenefit: true, isCulturalEvent: true },
        }),
        deps,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quotaEffect).toEqual({
          countedAgainstPartnership: true,
          countedAgainstCulturalQuota: true,
        });
        expect(result.value.emittedAuditEventTypes).toEqual([
          'quota_partnership_decremented',
          'quota_cultural_decremented',
        ]);
      }
      expect(emitMock).toHaveBeenCalledTimes(2);
    });

    it('partnership full + cultural room → over_quota + decremented', async () => {
      const { deps, emitMock } = makeDeps({
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 2, culturalPerYear: 2 },
            consumed: {
              partnershipConsumedForEvent: 2, // full
              culturalConsumedForYear: 1, // room
            },
          }),
      });
      const result = await applyQuotaEffect(
        baseInput({
          eventFlags: { isPartnerBenefit: true, isCulturalEvent: true },
        }),
        deps,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quotaEffect).toEqual({
          countedAgainstPartnership: false,
          countedAgainstCulturalQuota: true,
        });
        expect(result.value.emittedAuditEventTypes).toEqual([
          'quota_over_quota_warning',
          'quota_cultural_decremented',
        ]);
      }
      expect(emitMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('lock key derivation', () => {
    it('buildQuotaLockKey uses the research.md R5 canonical namespace prefix', () => {
      const key = buildQuotaLockKey(TENANT_ID, MEMBER_ID, EVENT_ID);
      expect(key).toBe(
        `eventcreate-quota:${TENANT_ID}:${MEMBER_ID}:${EVENT_ID}`,
      );
      expect(key.startsWith('eventcreate-quota:')).toBe(true);
    });

    it('lock key fed into AdvisoryLockAcquirer.acquire matches buildQuotaLockKey', async () => {
      const { deps, acquireMock } = makeDeps({
        queryAllotments: async () =>
          ok({
            allotments: { partnershipPerEvent: 6, culturalPerYear: 0 },
            consumed: {
              partnershipConsumedForEvent: 0,
              culturalConsumedForYear: 0,
            },
          }),
      });
      await applyQuotaEffect(baseInput(), deps);
      expect(acquireMock).toHaveBeenCalledTimes(1);
      expect(acquireMock).toHaveBeenCalledWith(
        buildQuotaLockKey(TENANT_ID, MEMBER_ID, EVENT_ID),
      );
    });
  });
});
