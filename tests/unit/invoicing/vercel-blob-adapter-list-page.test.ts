/**
 * #729 — `listPage` is the orphan PDF sweeper's view of the Blob store: one
 * page under a prefix, with the cursor, and each blob's `uploadedAt` (the
 * age rule) and `etag` (the conditional delete). The plain `list` drops all
 * three, so the sweeper cannot use it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();
vi.mock('@vercel/blob', async () => {
  const actual = await vi.importActual<typeof import('@vercel/blob')>('@vercel/blob');
  return { ...actual, list: (...args: unknown[]) => listMock(...args) };
});
vi.mock('@/lib/env', () => ({ env: { blob: { readWriteToken: 'test-token' } } }));

beforeEach(() => listMock.mockReset());

describe('vercelBlobAdapter.listPage (#729)', () => {
  it('passes prefix, cursor, limit and the token, and maps key, uploadedAt, etag and the cursor', async () => {
    const uploadedAt = new Date('2026-11-03T00:00:00.000Z');
    listMock.mockResolvedValueOnce({
      blobs: [{ pathname: 'invoicing/t/2026/a_v13.pdf', uploadedAt, etag: '"e1"', url: 'u', downloadUrl: 'd', size: 1 }],
      cursor: 'next-1',
      hasMore: true,
    });
    const { vercelBlobAdapter } = await import('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter');
    const signal = new AbortController().signal;
    const page = await vercelBlobAdapter.listPage('invoicing/t/', 'c0', 500, { signal });
    expect(listMock).toHaveBeenCalledWith({
      prefix: 'invoicing/t/',
      cursor: 'c0',
      limit: 500,
      token: 'test-token',
      abortSignal: signal,
    });
    expect(page).toEqual({
      items: [{ key: 'invoicing/t/2026/a_v13.pdf', uploadedAt, etag: '"e1"' }],
      cursor: 'next-1',
      hasMore: true,
    });
  });

  it('omits the cursor on the first page and reports the last page', async () => {
    listMock.mockResolvedValueOnce({ blobs: [], hasMore: false });
    const { vercelBlobAdapter } = await import('@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter');
    const page = await vercelBlobAdapter.listPage('invoicing/t/', undefined, 1000);
    // Without a caller signal the adapter still bounds the call: the SDK
    // retries a 5xx for minutes (reliability H2).
    expect(listMock).toHaveBeenCalledWith({
      prefix: 'invoicing/t/',
      limit: 1000,
      token: 'test-token',
      abortSignal: expect.any(AbortSignal),
    });
    expect(page).toEqual({ items: [], cursor: undefined, hasMore: false });
  });
});
