/**
 * F8 Phase 5 Wave A · T124 (part 2) spec — `optInRenewalReminders`.
 */
import { describe, expect, it, vi } from 'vitest';
import { optInRenewalReminders } from '@/modules/renewals/application/use-cases/opt-in-renewal-reminders';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a002';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function fakeDeps(repoResult: { previousValue: boolean; affectedRows: number }) {
  const clearMock = vi.fn(async () => repoResult);
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    memberRenewalFlagsRepo: {
      clearRenewalRemindersOptedOut: clearMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, clearMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  memberId: MEMBER_UUID,
  actorUserId: 'user-1',
  actorRole: 'member' as const,
  correlationId: 'corr-1',
};

describe('optInRenewalReminders (T124)', () => {
  it('happy path — clears flag + returns wasOptedOut=true', async () => {
    const { deps } = fakeDeps({ previousValue: true, affectedRows: 1 });
    const r = await optInRenewalReminders(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.wasOptedOut).toBe(true);
  });

  it('idempotent — already opted in returns wasOptedOut=false', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 1 });
    const r = await optInRenewalReminders(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.wasOptedOut).toBe(false);
  });

  it('member_not_found when affectedRows=0', async () => {
    const { deps } = fakeDeps({ previousValue: false, affectedRows: 0 });
    const r = await optInRenewalReminders(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('member_not_found');
  });
});
