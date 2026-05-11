/**
 * F8 Phase 5 Wave A · T124 (part 1) spec — `optOutRenewalReminders`.
 */
import { describe, expect, it, vi } from 'vitest';
import { optOutRenewalReminders } from '@/modules/renewals/application/use-cases/opt-out-renewal-reminders';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a001';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function fakeDeps(repoResult: { previousValue: boolean; affectedRows: number }) {
  const setMock = vi.fn(async () => repoResult);
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    memberRenewalFlagsRepo: {
      setRenewalRemindersOptedOut: setMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, setMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  memberId: MEMBER_UUID,
  actorUserId: 'user-1',
  actorRole: 'member' as const,
  correlationId: 'corr-1',
};

describe('optOutRenewalReminders (T124)', () => {
  it('happy path — sets flag + returns alreadyOptedOut=false', async () => {
    const { deps, setMock } = fakeDeps({ previousValue: false, affectedRows: 1 });
    const r = await optOutRenewalReminders(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.alreadyOptedOut).toBe(false);
    expect(setMock).toHaveBeenCalledOnce();
  });

  it('idempotent — already opted out returns alreadyOptedOut=true', async () => {
    const { deps } = fakeDeps({ previousValue: true, affectedRows: 1 });
    const r = await optOutRenewalReminders(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.alreadyOptedOut).toBe(true);
  });

  it('member_not_found when affectedRows=0 (RLS-hidden / non-existent)', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 0 });
    const r = await optOutRenewalReminders(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('member_not_found');
  });

  it('invalid_input on malformed memberId', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 1 });
    const r = await optOutRenewalReminders(deps, {
      ...baseInput,
      memberId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
