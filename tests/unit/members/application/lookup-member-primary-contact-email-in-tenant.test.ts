/**
 * Unit tests for `lookupMemberPrimaryContactEmailInTenant` use case
 * (T029, F7 Batch C). Wraps `runInTenant` + lowercases/trims input
 * before delegating to `memberRepo.findMemberByPrimaryContactEmailInTx`.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({}),
  ),
}));

import { asTenantContext } from '@/modules/tenants';
import { lookupMemberPrimaryContactEmailInTenant } from '@/modules/members/application/use-cases/lookup-member-primary-contact-email-in-tenant';
import type { F7MemberRecipient } from '@/modules/members/application/ports/member-repo';

const tenant = asTenantContext('test-tenant');

const recipient: F7MemberRecipient = {
  memberId: 'm1' as F7MemberRecipient['memberId'],
  displayName: 'Acme Corp',
  primaryContactEmail: 'alice@example.com',
  tierCode: 'corporate',
  broadcastsHaltedUntilAdminReview: false,
};

describe('lookupMemberPrimaryContactEmailInTenant', () => {
  it('forwards lowercase+trim normalisation to repo', async () => {
    const memberRepo = {
      findMemberByPrimaryContactEmailInTx: vi.fn().mockResolvedValue(ok(recipient)),
    } as unknown as Parameters<
      typeof lookupMemberPrimaryContactEmailInTenant
    >[0]['memberRepo'];

    const result = await lookupMemberPrimaryContactEmailInTenant(
      { tenant, memberRepo },
      '  Alice@Example.COM  ',
    );

    expect(result.ok).toBe(true);
    expect(memberRepo.findMemberByPrimaryContactEmailInTx).toHaveBeenCalledWith(
      {},
      'alice@example.com',
    );
  });

  it('returns null when member not found', async () => {
    const memberRepo = {
      findMemberByPrimaryContactEmailInTx: vi.fn().mockResolvedValue(ok(null)),
    } as unknown as Parameters<
      typeof lookupMemberPrimaryContactEmailInTenant
    >[0]['memberRepo'];

    const result = await lookupMemberPrimaryContactEmailInTenant(
      { tenant, memberRepo },
      'nope@example.com',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('catches thrown exception from runInTenant', async () => {
    const { runInTenant } = (await import('@/lib/db')) as unknown as {
      runInTenant: ReturnType<typeof vi.fn>;
    };
    runInTenant.mockRejectedValueOnce(new Error('boom'));

    const memberRepo = {
      findMemberByPrimaryContactEmailInTx: vi.fn(),
    } as unknown as Parameters<
      typeof lookupMemberPrimaryContactEmailInTenant
    >[0]['memberRepo'];

    const result = await lookupMemberPrimaryContactEmailInTenant(
      { tenant, memberRepo },
      'a@example.com',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('repo.unexpected');
  });
});
