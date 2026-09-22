/**
 * F119 round-3 (reliability re-check, 2026-09-22) — the Vercel Blob adapter's
 * NOT-FOUND classification must match the INSTALLED client, not a hand-written
 * string. `@vercel/blob@2.3.3` throws `BlobNotFoundError` whose message is
 * "Vercel Blob: The requested blob does not exist" — a regex on
 * `not found|404` never matched it, so `existsByContentHash` answered
 * `unknown` for every genuine miss and the `absent` arm (the re-PUT under the
 * content-hash lock, round-2 R-H2) was dead code in production.
 *
 * The SDK's real error classes are used here on purpose ("gate must read
 * source not data"): the mock keeps `@vercel/blob`'s actual exports and
 * replaces only `head` / `put` / `del`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const headMock = vi.fn();

vi.mock('@vercel/blob', async () => {
  const actual = await vi.importActual<typeof import('@vercel/blob')>('@vercel/blob');
  return {
    ...actual,
    head: (...args: unknown[]) => headMock(...args),
    put: vi.fn(),
    del: vi.fn(),
  };
});
vi.mock('@/lib/env', () => ({
  env: { blob: { readWriteToken: 'test-token' } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TENANT = 'test-tenant' as never;
const HASH = 'a'.repeat(64);

beforeEach(() => {
  vi.resetModules();
  headMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('vercelBlobImageStorage.existsByContentHash — tri-state probe vs the installed SDK', () => {
  it('a genuine miss (the SDK\'s own BlobNotFoundError) → absent', async () => {
    const { BlobNotFoundError } = await import('@vercel/blob');
    headMock.mockRejectedValueOnce(new BlobNotFoundError());
    const { vercelBlobImageStorage } = await import(
      '@/modules/broadcasts/infrastructure/vercel-blob-image-storage'
    );
    const probe = await vercelBlobImageStorage.existsByContentHash(TENANT, HASH, 'image/png');
    expect(probe).toEqual({ status: 'absent' });
  });

  it('any other failure (rate limit, access, unknown) → unknown, never absent', async () => {
    const { BlobServiceRateLimited, BlobAccessError, BlobUnknownError } = await import('@vercel/blob');
    const { vercelBlobImageStorage } = await import(
      '@/modules/broadcasts/infrastructure/vercel-blob-image-storage'
    );
    for (const e of [new BlobServiceRateLimited(), new BlobAccessError(), new BlobUnknownError(), new Error('socket hang up')]) {
      headMock.mockRejectedValueOnce(e);
      const probe = await vercelBlobImageStorage.existsByContentHash(TENANT, HASH, 'image/png');
      expect(probe.status).toBe('unknown');
    }
  });

  it('a hit → present with the SDK\'s url and the content-addressed key', async () => {
    headMock.mockResolvedValueOnce({ url: 'https://blob.example/x.png' });
    const { vercelBlobImageStorage } = await import(
      '@/modules/broadcasts/infrastructure/vercel-blob-image-storage'
    );
    const probe = await vercelBlobImageStorage.existsByContentHash(TENANT, HASH, 'image/png');
    expect(probe).toMatchObject({ status: 'present', blobUrl: 'https://blob.example/x.png' });
    expect((probe as { blobKey: string }).blobKey).toContain(HASH);
  });
});
