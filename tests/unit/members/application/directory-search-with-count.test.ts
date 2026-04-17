/**
 * Unit tests for `directorySearchWithCount` use case (offset pagination).
 *
 * Coverage:
 *   - Passes default limit=50, offset=0 to the repo when not specified
 *   - Clamps limit to 1..100 range (bulk API cap)
 *   - Guards offset >= 0
 *   - Maps repo errors to server_error shape
 *   - Forwards search filter fields unchanged (q, status, planYear, ...)
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { directorySearchWithCount } from '@/modules/members';
import type { MemberRepo } from '@/modules/members/application/ports/member-repo';
import { asTenantContext } from '@/modules/tenants';

function makeRepo(): MemberRepo & {
  searchDirectoryWithCount: ReturnType<typeof vi.fn>;
} {
  return {
    findById: vi.fn(),
    findByIdInTx: vi.fn(),
    findManyByIdsInTx: vi.fn(),
    findSoftDuplicate: vi.fn(),
    findByLinkedUserId: vi.fn(),
    createWithPrimaryContact: vi.fn(),
    updateStatus: vi.fn(),
    updateStatusInTx: vi.fn(),
    updateFields: vi.fn(),
    updateFieldsInTx: vi.fn(),
    searchDirectory: vi.fn(),
    searchDirectoryWithCount: vi.fn(),
  } as unknown as MemberRepo & {
    searchDirectoryWithCount: ReturnType<typeof vi.fn>;
  };
}

const tenant = asTenantContext('test-swecham');

describe('directorySearchWithCount use case', () => {
  it('defaults limit=50, offset=0 when not specified', async () => {
    const repo = makeRepo();
    repo.searchDirectoryWithCount.mockResolvedValueOnce(
      ok({ items: [], total: 0 }),
    );

    const result = await directorySearchWithCount(
      { tenant, memberRepo: repo },
      {},
    );

    expect(result.ok).toBe(true);
    expect(repo.searchDirectoryWithCount).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({ limit: 50, offset: 0 }),
    );
  });

  it('clamps limit to max 100 (bulk API server cap)', async () => {
    const repo = makeRepo();
    repo.searchDirectoryWithCount.mockResolvedValueOnce(
      ok({ items: [], total: 0 }),
    );

    await directorySearchWithCount(
      { tenant, memberRepo: repo },
      { limit: 999 },
    );

    expect(repo.searchDirectoryWithCount).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('clamps limit to min 1', async () => {
    const repo = makeRepo();
    repo.searchDirectoryWithCount.mockResolvedValueOnce(
      ok({ items: [], total: 0 }),
    );

    await directorySearchWithCount(
      { tenant, memberRepo: repo },
      { limit: 0 },
    );

    expect(repo.searchDirectoryWithCount).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({ limit: 1 }),
    );
  });

  it('clamps negative offset to 0', async () => {
    const repo = makeRepo();
    repo.searchDirectoryWithCount.mockResolvedValueOnce(
      ok({ items: [], total: 0 }),
    );

    await directorySearchWithCount(
      { tenant, memberRepo: repo },
      { offset: -10 },
    );

    expect(repo.searchDirectoryWithCount).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({ offset: 0 }),
    );
  });

  it('forwards filter fields (q, status, country, planYear) verbatim', async () => {
    const repo = makeRepo();
    repo.searchDirectoryWithCount.mockResolvedValueOnce(
      ok({ items: [], total: 0 }),
    );

    await directorySearchWithCount(
      { tenant, memberRepo: repo },
      {
        q: 'Fogma',
        status: ['active'],
        country: 'SE',
        planYear: 2026,
        limit: 25,
        offset: 100,
      },
    );

    expect(repo.searchDirectoryWithCount).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({
        q: 'Fogma',
        status: ['active'],
        country: 'SE',
        planYear: 2026,
        limit: 25,
        offset: 100,
      }),
    );
  });

  it('maps repo error to server_error', async () => {
    const repo = makeRepo();
    repo.searchDirectoryWithCount.mockResolvedValueOnce(
      err({ code: 'repo.unexpected', cause: new Error('boom') }),
    );

    const result = await directorySearchWithCount(
      { tenant, memberRepo: repo },
      {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('server_error');
    expect(result.error.message).toContain('repo.unexpected');
  });

  it('returns items + total on success', async () => {
    const repo = makeRepo();
    const fakeItems = [
      {
        member: { memberId: 'mem-1' },
        primaryContact: null,
        planDisplayName: 'Premium',
      },
    ];
    repo.searchDirectoryWithCount.mockResolvedValueOnce(
      ok({ items: fakeItems, total: 42 }),
    );

    const result = await directorySearchWithCount(
      { tenant, memberRepo: repo },
      { limit: 10, offset: 30 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual(fakeItems);
    expect(result.value.total).toBe(42);
  });
});
