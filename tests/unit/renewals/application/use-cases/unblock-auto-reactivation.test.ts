/**
 * F8 Phase 5 Wave A · T135 (part 2) spec — `unblockAutoReactivation`.
 */
import { describe, expect, it, vi } from 'vitest';
import { unblockAutoReactivation } from '@/modules/renewals/application/use-cases/unblock-auto-reactivation';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a004';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function fakeDeps(
  repoResult: { previousValue: boolean; affectedRows: number },
  emitImpl?: () => Promise<void>,
): {
  deps: RenewalsDeps;
  clearMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const clearMock = vi.fn(async () => repoResult);
  const emitInTxMock = vi.fn(emitImpl ?? (async () => {}));
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    memberRenewalFlagsRepo: {
      clearBlockedFromAutoReactivation: clearMock,
    },
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, clearMock, emitInTxMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  memberId: MEMBER_UUID,
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('unblockAutoReactivation (T135)', () => {
  it('happy path — clears flag + emits audit', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      previousValue: true,
      affectedRows: 1,
    });
    const r = await unblockAutoReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.wasBlocked).toBe(true);
    expect(emitInTxMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'member_auto_reactivation_unblocked',
    });
  });

  it('idempotent — already-unblocked emits no audit', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      previousValue: false,
      affectedRows: 1,
    });
    const r = await unblockAutoReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.wasBlocked).toBe(false);
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('member_not_found when affectedRows=0', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 0 });
    const r = await unblockAutoReactivation(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('member_not_found');
  });

  it('Principle VIII reverse-direction — audit failure throws', async () => {
    const { deps } = fakeDeps(
      { previousValue: true, affectedRows: 1 },
      async () => {
        throw new Error('audit_log: insert failed');
      },
    );
    await expect(unblockAutoReactivation(deps, baseInput)).rejects.toThrow(
      /audit_log: insert failed/,
    );
  });
});
