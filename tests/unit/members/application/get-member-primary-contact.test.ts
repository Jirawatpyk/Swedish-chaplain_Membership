/**
 * Unit tests for `getMemberPrimaryContact` use case (T029, F7 Batch C).
 *
 * Wraps `runInTenant(...)` + `memberRepo.findPrimaryContactEmailInTx`.
 * Tests verify happy path + repo errors + thrown exceptions are caught.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  // 2026-05-17 polish — stub `db` to fix "No 'db' export defined on
  // mock" collection error from F3 infra adapter import chain.
  db: {},
  runInTenant: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({}),
  ),
}));

import { asTenantContext } from '@/modules/tenants';
import { getMemberPrimaryContact } from '@/modules/members/application/use-cases/get-member-primary-contact';
import { asMemberId } from '@/modules/members';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');

describe('getMemberPrimaryContact', () => {
  it('returns the primary contact email when present', async () => {
    const memberRepo = {
      findPrimaryContactEmailInTx: vi.fn().mockResolvedValue(ok('a@example.com')),
    } as unknown as Parameters<typeof getMemberPrimaryContact>[0]['memberRepo'];

    const result = await getMemberPrimaryContact(
      { tenant, memberRepo },
      memberId,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('a@example.com');
  });

  it('returns null when member has no primary contact', async () => {
    const memberRepo = {
      findPrimaryContactEmailInTx: vi.fn().mockResolvedValue(ok(null)),
    } as unknown as Parameters<typeof getMemberPrimaryContact>[0]['memberRepo'];

    const result = await getMemberPrimaryContact(
      { tenant, memberRepo },
      memberId,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('propagates repo error', async () => {
    const memberRepo = {
      findPrimaryContactEmailInTx: vi
        .fn()
        .mockResolvedValue(err({ code: 'repo.unexpected', cause: 'boom' })),
    } as unknown as Parameters<typeof getMemberPrimaryContact>[0]['memberRepo'];

    const result = await getMemberPrimaryContact(
      { tenant, memberRepo },
      memberId,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('repo.unexpected');
  });

  it('catches thrown exception from runInTenant', async () => {
    const { runInTenant } = (await import('@/lib/db')) as unknown as {
      runInTenant: ReturnType<typeof vi.fn>;
    };
    runInTenant.mockRejectedValueOnce(new Error('connection lost'));

    const memberRepo = {
      findPrimaryContactEmailInTx: vi.fn(),
    } as unknown as Parameters<typeof getMemberPrimaryContact>[0]['memberRepo'];

    const result = await getMemberPrimaryContact(
      { tenant, memberRepo },
      memberId,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('repo.unexpected');
  });
});
