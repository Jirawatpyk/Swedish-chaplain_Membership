/**
 * F8 Phase 5 Wave A · T135 (part 1) spec — `blockAutoReactivation`.
 *
 * Verifies admin-block flag mutation + audit emit-in-tx invariant
 * (Constitution Principle VIII). Idempotent re-block does NOT emit a
 * duplicate audit row.
 */
import { describe, expect, it, vi } from 'vitest';
import { blockAutoReactivation } from '@/modules/renewals/application/use-cases/block-auto-reactivation';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a003';

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
      setBlockedFromAutoReactivation: setMock,
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
  reason: 'fraud-flag-pending-investigation',
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('blockAutoReactivation (T135)', () => {
  it('happy path — sets flag + emits audit in tx', async () => {
    const { deps, setMock, emitInTxMock } = fakeDeps({
      previousValue: false,
      affectedRows: 1,
    });
    const r = await blockAutoReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.alreadyBlocked).toBe(false);
    expect(setMock).toHaveBeenCalledOnce();
    expect(emitInTxMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'member_auto_reactivation_blocked',
      payload: {
        member_id: MEMBER_UUID,
        actor_user_id: 'admin-1',
        reason: 'fraud-flag-pending-investigation',
      },
    });
  });

  it('idempotent re-block — no audit emitted', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      previousValue: true,
      affectedRows: 1,
    });
    const r = await blockAutoReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.alreadyBlocked).toBe(true);
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('member_not_found when affectedRows=0', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 0 });
    const r = await blockAutoReactivation(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('member_not_found');
  });

  it('Principle VIII reverse-direction — audit failure throws to roll back', async () => {
    const { deps } = fakeDeps(
      { previousValue: false, affectedRows: 1 },
      async () => {
        throw new Error('audit_log: insert failed');
      },
    );
    await expect(blockAutoReactivation(deps, baseInput)).rejects.toThrow(
      /audit_log: insert failed/,
    );
  });

  it('reason is optional — emits audit with reason=null', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      previousValue: false,
      affectedRows: 1,
    });
    const inputWithoutReason: typeof baseInput = { ...baseInput };
    delete (inputWithoutReason as Partial<typeof baseInput>).reason;
    const r = await blockAutoReactivation(deps, inputWithoutReason);
    expect(r.ok).toBe(true);
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      payload: { reason: null },
    });
  });
});
