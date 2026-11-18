/**
 * #710 — `eraseMemberInsightsFootprint` stops before the caller's deadline
 * rather than start a Blob delete it cannot finish. The throw becomes the
 * adapter's `outcome: 'failed'`, so `member_erased` is withheld and the
 * reconciler finishes the rest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
const deleteLogo = vi.hoisted(() => vi.fn(async () => undefined));
const deletePrivate = vi.hoisted(() => vi.fn(async () => undefined));
const listing = vi.hoisted(() => ({ value: { logoUrl: 'https://blob/logo.png' } as { logoUrl: string } | null }));
vi.mock('@/modules/insights/infrastructure/logo/public-logo-blob-adapter', () => ({
  publicLogoBlobAdapter: { deleteLogo },
}));
vi.mock('@/modules/insights/infrastructure/blob/private-blob-adapter', () => ({
  privateBlobAdapter: { delete: deletePrivate },
}));
vi.mock('@/modules/insights/infrastructure/repos/drizzle-directory-repo', () => ({
  makeDrizzleDirectoryRepo: () => ({
    findByMemberId: async () => listing.value,
    deleteForMemberInTx: async () => undefined,
  }),
}));
vi.mock('@/modules/insights/infrastructure/repos/drizzle-export-job-repo', () => ({
  makeDrizzleExportJobRepo: () => ({
    listRecentForSubject: async () => [
      { id: 'j-1', blobKey: 'k-1' },
      { id: 'j-2', blobKey: 'k-2' },
    ],
    markExpiredInTx: async () => undefined,
  }),
}));

const { eraseMemberInsightsFootprint } = await import(
  '@/modules/insights/infrastructure/directory-erasure'
);
const CTX = { slug: 't-1' } as never;

beforeEach(() => {
  deleteLogo.mockClear();
  deletePrivate.mockClear();
  listing.value = { logoUrl: 'https://blob/logo.png' };
});

describe('#710 eraseMemberInsightsFootprint — deadline', () => {
  it('with no deadline, deletes the logo and every archive', async () => {
    await eraseMemberInsightsFootprint(CTX, 'm-1');
    expect(deleteLogo).toHaveBeenCalledTimes(1);
    expect(deletePrivate).toHaveBeenCalledTimes(2);
  });

  it('a deadline already past throws before any Blob delete', async () => {
    await expect(
      eraseMemberInsightsFootprint(CTX, 'm-1', { deadlineAt: new Date(Date.now() - 1) }),
    ).rejects.toThrow();
    expect(deleteLogo).not.toHaveBeenCalled();
    expect(deletePrivate).not.toHaveBeenCalled();
  });

  it('a deadline closer than one Blob timeout throws before the delete', async () => {
    await expect(
      eraseMemberInsightsFootprint(CTX, 'm-1', { deadlineAt: new Date(Date.now() + 5_000) }),
    ).rejects.toThrow();
    expect(deleteLogo).not.toHaveBeenCalled();
  });

  it('a deadline with room runs every step', async () => {
    await eraseMemberInsightsFootprint(CTX, 'm-1', { deadlineAt: new Date(Date.now() + 120_000) });
    expect(deleteLogo).toHaveBeenCalledTimes(1);
    expect(deletePrivate).toHaveBeenCalledTimes(2);
  });
});
