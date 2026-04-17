/**
 * Unit tests for `directorySearch` use case (cursor-based pagination).
 * The offset variant is covered by directory-search-with-count.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { directorySearch } from '@/modules/members';
import type { MemberRepo } from '@/modules/members/application/ports/member-repo';
import { asTenantContext } from '@/modules/tenants';

const tenant = asTenantContext('test-swecham');

function makeRepo(): MemberRepo & { searchDirectory: ReturnType<typeof vi.fn> } {
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
  } as unknown as MemberRepo & { searchDirectory: ReturnType<typeof vi.fn> };
}

describe('directorySearch use case (cursor pagination)', () => {
  it('defaults limit=50 when not specified', async () => {
    const repo = makeRepo();
    repo.searchDirectory.mockResolvedValueOnce(ok({ items: [], nextCursor: null }));

    const result = await directorySearch({ tenant, memberRepo: repo }, {});

    expect(result.ok).toBe(true);
    expect(repo.searchDirectory).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({ limit: 50 }),
    );
  });

  it('clamps limit to max 100', async () => {
    const repo = makeRepo();
    repo.searchDirectory.mockResolvedValueOnce(ok({ items: [], nextCursor: null }));

    await directorySearch({ tenant, memberRepo: repo }, { limit: 999 });

    expect(repo.searchDirectory).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('clamps limit to min 1', async () => {
    const repo = makeRepo();
    repo.searchDirectory.mockResolvedValueOnce(ok({ items: [], nextCursor: null }));

    await directorySearch({ tenant, memberRepo: repo }, { limit: 0 });

    expect(repo.searchDirectory).toHaveBeenCalledWith(
      tenant,
      expect.objectContaining({ limit: 1 }),
    );
  });

  it('returns server_error when repo returns err', async () => {
    const repo = makeRepo();
    repo.searchDirectory.mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));

    const result = await directorySearch({ tenant, memberRepo: repo }, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toContain('directory');
      }
    }
  });

  it('forwards items and nextCursor on success', async () => {
    const repo = makeRepo();
    const items = [{ memberId: 'm-001' }];
    repo.searchDirectory.mockResolvedValueOnce(ok({ items, nextCursor: 'cursor-abc' }));

    const result = await directorySearch({ tenant, memberRepo: repo }, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toBe(items);
      expect(result.value.nextCursor).toBe('cursor-abc');
    }
  });
});
