/**
 * R3-T6 (2026-05-18 /speckit-review Round 3 Final) — unit tests for
 * `emitCreditBackViaStateChange` helper.
 *
 * Locks the public audit contract that downstream consumers rely on:
 *   - Canonical `eventType: 'quota_credit_back_refund'` literal (NOT a
 *     scope-specific variant — semantically identical to FR-018 refund
 *     credit-back, disambiguated via `summary`).
 *   - Summary contains the `"via state_change"` substring + scope
 *     prefix ("partnership credit-back via state_change" /
 *     "cultural credit-back via state_change") so audit consumers can
 *     split refund vs state-change causes downstream.
 *   - Payload shape: severity / registrationId / memberId / scope /
 *     allotmentAfter.
 *   - R3-C1 contract: on `audit.emit` rejection (Result.err OR raw
 *     throw), the helper throws `TxStageError('audit_emit', ...)`.
 *
 * Pure Application — no DB, no framework.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { emitCreditBackViaStateChange } from '@/modules/events/application/use-cases/_helpers/emit-credit-back-pair';
import {
  TxStageError,
} from '@/modules/events/application/use-cases/_helpers/process-attendee-in-tx';
import type { F6AuditPort } from '@/modules/events/application/ports/audit-port';
import { asTenantId } from '@/modules/members';
import { asUserId, type AuditEventId } from '@/modules/auth';
import {
  asRegistrationId,
} from '@/modules/events/domain/branded-types';
import { asMemberId } from '@/modules/members';

const TENANT_ID = asTenantId('test-tenant-r3-t6');
const ACTOR_ID = asUserId('00000000-0000-0000-0000-000000000999');
const REG_ID = asRegistrationId('11111111-1111-4111-8111-111111111111');
const MEMBER_ID = asMemberId('22222222-2222-4222-8222-222222222222');

function makeAuditPortMock(
  emitImpl: F6AuditPort['emit'],
): F6AuditPort {
  return {
    emit: emitImpl,
    emitRolledBack: vi.fn(),
    emitStandalone: vi.fn(),
    findPriorErasureCompletion: vi.fn(),
  };
}

describe('emitCreditBackViaStateChange (R3-T6)', () => {
  describe('happy path — partnership scope', () => {
    it('emits eventType=quota_credit_back_refund with the canonical literal', async () => {
      const emit = vi.fn(async () =>
        ok('a1b2c3d4-e5f6-4789-8abc-def012345678' as AuditEventId),
      );
      await emitCreditBackViaStateChange(makeAuditPortMock(emit), {
        tenantId: TENANT_ID,
        actorUserId: ACTOR_ID,
        rowNumber: 7,
        registrationId: REG_ID,
        memberId: MEMBER_ID,
        previousPaymentStatus: 'paid',
        newPaymentStatus: 'pending',
        scope: 'partnership',
        allotmentAfter: 5,
      });
      expect(emit).toHaveBeenCalledTimes(1);
      const entry = (emit.mock.calls as unknown as Array<[{ readonly eventType: string; readonly summary: string; readonly payload: Record<string, unknown> }]>)[0]?.[0];
      expect(entry?.eventType).toBe('quota_credit_back_refund');
    });

    it('summary contains "partnership credit-back via state_change" prefix', async () => {
      const emit = vi.fn(async () =>
        ok('a1b2c3d4-e5f6-4789-8abc-def012345678' as AuditEventId),
      );
      await emitCreditBackViaStateChange(makeAuditPortMock(emit), {
        tenantId: TENANT_ID,
        actorUserId: ACTOR_ID,
        rowNumber: 12,
        registrationId: REG_ID,
        memberId: MEMBER_ID,
        previousPaymentStatus: 'paid',
        newPaymentStatus: 'pending',
        scope: 'partnership',
        allotmentAfter: 5,
      });
      const entry = (emit.mock.calls as unknown as Array<[{ readonly eventType: string; readonly summary: string; readonly payload: Record<string, unknown> }]>)[0]?.[0];
      expect(entry?.summary).toContain('partnership credit-back via state_change');
      expect(entry?.summary).toContain('row 12');
      expect(entry?.summary).toContain('paid→pending');
    });

    it('payload shape includes severity/registrationId/memberId/scope/allotmentAfter', async () => {
      const emit = vi.fn(async () =>
        ok('a1b2c3d4-e5f6-4789-8abc-def012345678' as AuditEventId),
      );
      await emitCreditBackViaStateChange(makeAuditPortMock(emit), {
        tenantId: TENANT_ID,
        actorUserId: ACTOR_ID,
        rowNumber: 1,
        registrationId: REG_ID,
        memberId: MEMBER_ID,
        previousPaymentStatus: 'paid',
        newPaymentStatus: 'pending',
        scope: 'partnership',
        allotmentAfter: 5,
      });
      const entry = (emit.mock.calls as unknown as Array<[{ readonly eventType: string; readonly summary: string; readonly payload: Record<string, unknown> }]>)[0]?.[0];
      expect(entry?.payload).toMatchObject({
        severity: 'info',
        registrationId: REG_ID,
        memberId: MEMBER_ID,
        scope: 'partnership',
        allotmentAfter: 5,
      });
    });
  });

  describe('happy path — cultural scope', () => {
    it('summary contains "cultural credit-back via state_change" prefix', async () => {
      const emit = vi.fn(async () =>
        ok('a1b2c3d4-e5f6-4789-8abc-def012345678' as AuditEventId),
      );
      await emitCreditBackViaStateChange(makeAuditPortMock(emit), {
        tenantId: TENANT_ID,
        actorUserId: ACTOR_ID,
        rowNumber: 3,
        registrationId: REG_ID,
        memberId: MEMBER_ID,
        previousPaymentStatus: 'paid',
        newPaymentStatus: 'no_show',
        scope: 'cultural',
        allotmentAfter: 4,
      });
      const entry = (emit.mock.calls as unknown as Array<[{ readonly eventType: string; readonly summary: string; readonly payload: Record<string, unknown> }]>)[0]?.[0];
      expect(entry?.summary).toContain('cultural credit-back via state_change');
      expect(entry?.summary).toContain('paid→no_show');
    });

    it('payload scope is cultural (not partnership)', async () => {
      const emit = vi.fn(async () =>
        ok('a1b2c3d4-e5f6-4789-8abc-def012345678' as AuditEventId),
      );
      await emitCreditBackViaStateChange(makeAuditPortMock(emit), {
        tenantId: TENANT_ID,
        actorUserId: ACTOR_ID,
        rowNumber: 1,
        registrationId: REG_ID,
        memberId: MEMBER_ID,
        previousPaymentStatus: 'paid',
        newPaymentStatus: 'no_show',
        scope: 'cultural',
        allotmentAfter: 4,
      });
      const entry = (emit.mock.calls as unknown as Array<[{ readonly eventType: string; readonly summary: string; readonly payload: Record<string, unknown> }]>)[0]?.[0];
      const payload = entry?.payload as { scope?: string };
      expect(payload?.scope).toBe('cultural');
    });
  });

  describe('R3-C1 contract — audit emit failure converts to TxStageError', () => {
    it('throws TxStageError(audit_emit) when audit.emit returns Result.err', async () => {
      const emit = vi.fn(async () =>
        err({ kind: 'db_error' as const, message: 'simulated DB blip' }),
      );
      await expect(
        emitCreditBackViaStateChange(makeAuditPortMock(emit), {
          tenantId: TENANT_ID,
          actorUserId: ACTOR_ID,
          rowNumber: 1,
          registrationId: REG_ID,
          memberId: MEMBER_ID,
          previousPaymentStatus: 'paid',
          newPaymentStatus: 'pending',
          scope: 'partnership',
          allotmentAfter: 5,
        }),
      ).rejects.toBeInstanceOf(TxStageError);
    });

    it('throws TxStageError(audit_emit) when audit.emit raw-throws (R3-C1 vector)', async () => {
      const emit = vi.fn(async () => {
        throw new Error('synthetic pool exhaust');
      });
      const promise = emitCreditBackViaStateChange(
        makeAuditPortMock(emit as unknown as F6AuditPort['emit']),
        {
          tenantId: TENANT_ID,
          actorUserId: ACTOR_ID,
          rowNumber: 1,
          registrationId: REG_ID,
          memberId: MEMBER_ID,
          previousPaymentStatus: 'paid',
          newPaymentStatus: 'pending',
          scope: 'partnership',
          allotmentAfter: 5,
        },
      );
      await expect(promise).rejects.toBeInstanceOf(TxStageError);
      await expect(promise).rejects.toMatchObject({ stage: 'audit_emit' });
    });
  });
});
