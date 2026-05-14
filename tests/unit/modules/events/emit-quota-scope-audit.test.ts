/**
 * Phase 6 wave-6 — `emitQuotaScopeAudit` helper unit tests.
 *
 * Closes the TEST-GAP-3 cross-check finding: wave-5 batch-3 (REFACTOR
 * H3) extracted the 6 (scope × action) audit-emit branches into a
 * unified helper. The integration suites exercise the helper
 * transitively via toggle-event-category happy paths, but the cultural
 * scope decremented / over_quota / credit_back paths + audit-emit
 * error paths had no direct unit-level assertion. This file covers
 * every (scope, action) cell + the audit-emit failure paths.
 *
 * Constitution Principle II — 100% branch coverage target on
 * security/correctness-critical Application code.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  emitQuotaScopeAudit,
  type EmitQuotaScopeAuditParams,
  type BaseAuditEnvelope,
} from '@/modules/events/application/use-cases/_helpers/emit-quota-scope-audit';
import {
  asEventId,
  asRegistrationId,
  type F6AuditPort,
} from '@/modules/events';
import { asTenantId, type MemberId } from '@/modules/members';
import type { AuditEventId, UserId } from '@/modules/auth';

const TENANT_ID = asTenantId('test-emit-helper');
const EVENT_ID = asEventId('00000000-0000-0000-0000-000000000aaa');
const REG_ID = asRegistrationId('00000000-0000-0000-0000-000000000bbb');
const MEMBER_ID = '00000000-0000-0000-0000-000000000ccc' as MemberId;
const ACTOR_ID = '00000000-0000-0000-0000-000000000ddd' as UserId;

const baseAudit: BaseAuditEnvelope = {
  tenantId: TENANT_ID,
  actorType: 'admin',
  actorUserId: ACTOR_ID,
  occurredAt: new Date('2026-05-14T10:00:00Z'),
};

function makeAuditPort(
  emitOverride?: F6AuditPort['emit'],
): { audit: F6AuditPort; emitMock: ReturnType<typeof vi.fn> } {
  const emitMock = vi.fn(
    emitOverride ?? (async () => ok('audit-1' as AuditEventId)),
  );
  return {
    audit: {
      emit: emitMock as never,
      emitRolledBack: vi.fn() as never,
      emitStandalone: vi.fn() as never,
    },
    emitMock,
  };
}

function partnershipDecrementedParams(
  patch: Partial<EmitQuotaScopeAuditParams> = {},
): EmitQuotaScopeAuditParams {
  return {
    scope: 'partnership',
    action: 'decremented',
    registrationId: REG_ID,
    memberId: MEMBER_ID,
    eventId: EVENT_ID,
    allotmentAfter: 2, // → before = 3
    fiscalYear: 2026,
    ...patch,
  };
}

describe('emitQuotaScopeAudit — Phase 6 wave-6 (TEST-GAP-3)', () => {
  describe('partnership × {decremented, over_quota, credit_back}', () => {
    it('partnership × decremented → quota_partnership_decremented with before=after+1', async () => {
      const { audit, emitMock } = makeAuditPort();
      const r = await emitQuotaScopeAudit(audit, baseAudit, partnershipDecrementedParams());
      expect(r.ok).toBe(true);
      expect(emitMock).toHaveBeenCalledTimes(1);
      const call = emitMock.mock.calls[0]![0];
      expect(call.eventType).toBe('quota_partnership_decremented');
      expect(call.payload.perEventAllotmentBefore).toBe(3);
      expect(call.payload.perEventAllotmentAfter).toBe(2);
    });

    it('partnership × over_quota → quota_over_quota_warning with scope=partnership + allotmentAtIngest=0', async () => {
      const { audit, emitMock } = makeAuditPort();
      const r = await emitQuotaScopeAudit(audit, baseAudit, {
        ...partnershipDecrementedParams(),
        action: 'over_quota',
      });
      expect(r.ok).toBe(true);
      const call = emitMock.mock.calls[0]![0];
      expect(call.eventType).toBe('quota_over_quota_warning');
      expect(call.payload.scope).toBe('partnership');
      expect(call.payload.allotmentAtIngest).toBe(0);
    });

    it('partnership × credit_back → quota_credit_back_archive with scope=partnership + allotmentAfter', async () => {
      const { audit, emitMock } = makeAuditPort();
      const r = await emitQuotaScopeAudit(audit, baseAudit, {
        ...partnershipDecrementedParams(),
        action: 'credit_back',
        allotmentAfter: 5,
      });
      expect(r.ok).toBe(true);
      const call = emitMock.mock.calls[0]![0];
      expect(call.eventType).toBe('quota_credit_back_archive');
      expect(call.payload.scope).toBe('partnership');
      expect(call.payload.allotmentAfter).toBe(5);
    });
  });

  describe('cultural × {decremented, over_quota, credit_back}', () => {
    it('cultural × decremented → quota_cultural_decremented with annualAllotmentBefore=after+1 + fiscalYear', async () => {
      const { audit, emitMock } = makeAuditPort();
      const r = await emitQuotaScopeAudit(audit, baseAudit, {
        ...partnershipDecrementedParams(),
        scope: 'cultural',
        allotmentAfter: 1, // → before = 2
        fiscalYear: 2027,
      });
      expect(r.ok).toBe(true);
      const call = emitMock.mock.calls[0]![0];
      expect(call.eventType).toBe('quota_cultural_decremented');
      expect(call.payload.fiscalYear).toBe(2027);
      expect(call.payload.annualAllotmentBefore).toBe(2);
      expect(call.payload.annualAllotmentAfter).toBe(1);
    });

    it('cultural × over_quota → quota_over_quota_warning with scope=cultural', async () => {
      const { audit, emitMock } = makeAuditPort();
      const r = await emitQuotaScopeAudit(audit, baseAudit, {
        ...partnershipDecrementedParams(),
        scope: 'cultural',
        action: 'over_quota',
      });
      expect(r.ok).toBe(true);
      const call = emitMock.mock.calls[0]![0];
      expect(call.eventType).toBe('quota_over_quota_warning');
      expect(call.payload.scope).toBe('cultural');
    });

    it('cultural × credit_back → quota_credit_back_archive with scope=cultural', async () => {
      const { audit, emitMock } = makeAuditPort();
      const r = await emitQuotaScopeAudit(audit, baseAudit, {
        ...partnershipDecrementedParams(),
        scope: 'cultural',
        action: 'credit_back',
        allotmentAfter: 1,
      });
      expect(r.ok).toBe(true);
      const call = emitMock.mock.calls[0]![0];
      expect(call.eventType).toBe('quota_credit_back_archive');
      expect(call.payload.scope).toBe('cultural');
      expect(call.payload.allotmentAfter).toBe(1);
    });
  });

  describe('audit-emit error → audit_emit_failed', () => {
    it('wraps db_error with the db error message', async () => {
      const { audit } = makeAuditPort(async () =>
        err({ kind: 'db_error', message: 'audit log unreachable' }),
      );
      const r = await emitQuotaScopeAudit(audit, baseAudit, partnershipDecrementedParams());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('audit_emit_failed');
        expect(r.error.message).toBe('audit log unreachable');
      }
    });

    it('wraps enum_value_unknown with a descriptive message', async () => {
      const { audit } = makeAuditPort(async () =>
        err({ kind: 'enum_value_unknown', eventType: 'unknown_event_xyz' }),
      );
      const r = await emitQuotaScopeAudit(audit, baseAudit, partnershipDecrementedParams());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('audit_emit_failed');
        expect(r.error.message).toContain('audit enum unknown');
        expect(r.error.message).toContain('unknown_event_xyz');
      }
    });
  });
});
