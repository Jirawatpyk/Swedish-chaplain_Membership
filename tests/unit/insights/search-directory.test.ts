/**
 * F9 US5 (T078) — `searchDirectory` unit tests.
 *
 * `searchDirectory` does not open a `runInTenant` tx itself (the repo
 * self-scopes), so the whole use-case is unit-testable with a mocked
 * `DirectoryRepo`: RBAC (staff-only), pagination clamping → offset/limit, filter
 * construction (empty values dropped), and row→item mapping (FR-024).
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import {
  searchDirectory,
  type SearchDirectoryMeta,
} from '@/modules/insights/application/use-cases/search-directory';
import type {
  DirectoryRepo,
  DirectorySearchRow,
} from '@/modules/insights/application/ports/directory-repo';

const ctx = asTenantContext('test-tenant');

const adminMeta: SearchDirectoryMeta = {
  actorUserId: 'u-1',
  actorRole: 'admin',
  requestId: 'req-1',
};

function stubRepo(
  result: { rows: readonly DirectorySearchRow[]; total: number } = {
    rows: [],
    total: 0,
  },
): DirectoryRepo {
  return {
    findByMemberIdInTx: vi.fn(),
    findByMemberId: vi.fn(),
    upsertInTx: vi.fn(),
    setLogoInTx: vi.fn(),
    search: vi.fn().mockResolvedValue(result),
    listPublishedInTx: vi.fn(),
  };
}

describe('searchDirectory — RBAC', () => {
  it('forbids a member (the internal directory is staff-only, FR-024)', async () => {
    const repo = stubRepo();
    const result = await searchDirectory(
      {},
      { ...adminMeta, actorRole: 'member' },
      ctx,
      { directoryRepo: repo },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
    expect(repo.search).not.toHaveBeenCalled();
  });

  it.each(['admin', 'manager'] as const)('allows %s to browse', async (role) => {
    const repo = stubRepo();
    const result = await searchDirectory({}, { ...adminMeta, actorRole: role }, ctx, {
      directoryRepo: repo,
    });
    expect(result.ok).toBe(true);
    expect(repo.search).toHaveBeenCalledOnce();
  });
});

describe('searchDirectory — pagination + filters', () => {
  it('translates page/pageSize to offset/limit (page 3, size 20 → offset 40)', async () => {
    const repo = stubRepo();
    await searchDirectory({ page: 3, pageSize: 20 }, adminMeta, ctx, {
      directoryRepo: repo,
    });
    expect(repo.search).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ limit: 20, offset: 40 }),
    );
  });

  it('clamps pageSize to [1,100] and page to ≥1', async () => {
    const repo = stubRepo();
    await searchDirectory({ page: 0, pageSize: 500 }, adminMeta, ctx, {
      directoryRepo: repo,
    });
    expect(repo.search).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ limit: 100, offset: 0 }),
    );
  });

  it('drops empty/whitespace filter values', async () => {
    const repo = stubRepo();
    await searchDirectory(
      { q: '  ', tier: '', city: '   ', country: '', listedOnly: false },
      adminMeta,
      ctx,
      { directoryRepo: repo },
    );
    const filter = (repo.search as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(filter).not.toHaveProperty('q');
    expect(filter).not.toHaveProperty('tier');
    expect(filter).not.toHaveProperty('city');
    expect(filter).not.toHaveProperty('country');
    expect(filter).not.toHaveProperty('listedOnly');
  });

  it('forwards trimmed non-empty filters + listedOnly', async () => {
    const repo = stubRepo();
    await searchDirectory(
      { q: ' acme ', tier: 'corporate', city: ' Bangkok ', country: 'TH', listedOnly: true },
      adminMeta,
      ctx,
      { directoryRepo: repo },
    );
    expect(repo.search).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        q: 'acme',
        tier: 'corporate',
        city: 'Bangkok',
        country: 'TH',
        listedOnly: true,
      }),
    );
  });
});

describe('searchDirectory — row mapping', () => {
  const baseRow: DirectorySearchRow = {
    memberId: 'm-1',
    companyName: 'Acme',
    status: 'active',
    tier: 'Corporate Gold',
    contactName: 'Somchai',
    contactEmail: 'somchai@acme.example',
    listing: {
      memberId: 'm-1',
      listed: true,
      fieldVisibility: { name: true },
      industry: 'Manufacturing',
      description: null,
      website: null,
      logoUrl: 'tenants/x/logo.png',
      locationCity: 'Bangkok',
      locationCountry: 'TH',
    },
  };

  it('maps a listed member with a logo', async () => {
    const repo = stubRepo({ rows: [baseRow], total: 1 });
    const result = await searchDirectory({}, adminMeta, ctx, {
      directoryRepo: repo,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    expect(result.value.items[0]).toEqual({
      memberId: 'm-1',
      companyName: 'Acme',
      status: 'active',
      tier: 'Corporate Gold',
      listed: true,
      fieldVisibility: { name: true },
      industry: 'Manufacturing',
      locationCity: 'Bangkok',
      locationCountry: 'TH',
      hasLogo: true,
      contactName: 'Somchai',
    });
  });

  it('maps a member with no listing row → not listed, empty visibility, no logo', async () => {
    const repo = stubRepo({
      rows: [{ ...baseRow, listing: null }],
      total: 1,
    });
    const result = await searchDirectory({}, adminMeta, ctx, {
      directoryRepo: repo,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.value.items[0]!;
    expect(item.listed).toBe(false);
    expect(item.fieldVisibility).toEqual({});
    expect(item.hasLogo).toBe(false);
    expect(item.industry).toBeNull();
  });
});
