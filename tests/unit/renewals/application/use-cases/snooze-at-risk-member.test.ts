/**
 * F8 Phase 6 Wave B · T155 spec — `snoozeAtRiskMember` use-case.
 *
 * Verifies admin-snooze flag mutation + audit emit-in-tx invariant
 * (Constitution Principle VIII). Includes:
 *   - happy path for 7 / 30 / 90 day durations (FR-032 enum)
 *   - member_not_found when affected_rows=0 (RLS-hidden / cross-tenant)
 *   - reverse-direction tx atomicity (audit failure rolls back)
 *   - manager-role rejected at the use-case zod gate (defence-in-depth)
 *   - invalid duration rejected
 */
import { describe, expect, it, vi } from 'vitest';
import { snoozeAtRiskMember } from '@/modules/renewals/application/use-cases/snooze-at-risk-member';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a155';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function fakeDeps(
  repoResult: { previousValue: boolean; affectedRows: number },
  emitImpl?: () => Promise<void>,
): {
  deps: RenewalsDeps;
  setMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const setMock = vi.fn(async () => repoResult);
  const emitInTxMock = vi.fn(emitImpl ?? (async () => {}));
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    memberRenewalFlagsRepo: {
      setRiskSnoozedUntil: setMock,
    },
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, setMock, emitInTxMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  memberId: MEMBER_UUID,
  durationDays: 30 as const,
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('snoozeAtRiskMember (T155)', () => {
  it('happy path — 30d snooze sets flag + emits audit in tx', async () => {
    const { deps, setMock, emitInTxMock } = fakeDeps({
      previousValue: false,
      affectedRows: 1,
    });
    const beforeMs = Date.now();
    const r = await snoozeAtRiskMember(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const snoozedAtMs = new Date(r.value.snoozedUntil).getTime();
      const expectedMs = beforeMs + 30 * 24 * 60 * 60 * 1000;
      // Snooze timestamp is `now() + duration` — allow a few ms tolerance
      // for clock drift between input parse + repo call.
      expect(snoozedAtMs).toBeGreaterThanOrEqual(expectedMs - 1000);
      expect(snoozedAtMs).toBeLessThanOrEqual(expectedMs + 1000);
    }
    expect(setMock).toHaveBeenCalledOnce();
    expect(emitInTxMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'at_risk_snoozed',
      payload: {
        member_id: MEMBER_UUID,
        snooze_duration_days: 30,
      },
    });
  });

  it('happy path — 7d snooze', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 1 });
    const r = await snoozeAtRiskMember(deps, {
      ...baseInput,
      durationDays: 7,
    });
    expect(r.ok).toBe(true);
  });

  it('happy path — 90d snooze', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      previousValue: false,
      affectedRows: 1,
    });
    const r = await snoozeAtRiskMember(deps, {
      ...baseInput,
      durationDays: 90,
    });
    expect(r.ok).toBe(true);
    expect(emitInTxMock.mock.calls[0]?.[1]?.payload?.snooze_duration_days).toBe(
      90,
    );
  });

  it('member_not_found when affectedRows=0 (RLS-hidden / cross-tenant)', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      previousValue: false,
      affectedRows: 0,
    });
    const r = await snoozeAtRiskMember(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('member_not_found');
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('audit emit failure inside tx — propagates so outer runInTenant rolls back', async () => {
    const auditError = new Error('audit_log: insert failed');
    const { deps } = fakeDeps(
      { previousValue: false, affectedRows: 1 },
      async () => {
        throw auditError;
      },
    );
    await expect(snoozeAtRiskMember(deps, baseInput)).rejects.toThrow(
      auditError,
    );
  });

  it('rejects manager role (defence-in-depth)', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 1 });
    const r = await snoozeAtRiskMember(deps, {
      ...baseInput,
      actorRole: 'manager' as unknown as 'admin',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects invalid duration (5 not in 7|30|90)', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 1 });
    const r = await snoozeAtRiskMember(deps, {
      ...baseInput,
      durationDays: 5 as unknown as 7,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('rejects malformed memberId (not UUID)', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 1 });
    const r = await snoozeAtRiskMember(deps, {
      ...baseInput,
      memberId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
