/**
 * F4 Vercel Blob adapter — NOT-FOUND classification against the INSTALLED SDK.
 *
 * `@vercel/blob@2.3.3` throws `BlobNotFoundError` from `head()` with the
 * message "Vercel Blob: The requested blob does not exist". The four PDF /
 * cert download use cases used to regex that message for `not found|404`,
 * which never matched, so a missing tax-document blob answered 500
 * `internal_error` instead of 502 `blob_missing`. The adapter now classifies
 * the SDK's own CLASS and throws the port's `BlobKeyNotFoundError`; every
 * other failure passes through unchanged.
 *
 * The SDK's real error classes are used on purpose (mirrors
 * `tests/unit/broadcasts/infrastructure/vercel-blob-image-storage-probe.test.ts`):
 * the mock keeps `@vercel/blob`'s actual exports and replaces only the calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const headMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('@vercel/blob', async () => {
  const actual = await vi.importActual<typeof import('@vercel/blob')>('@vercel/blob');
  return {
    ...actual,
    head: (...args: unknown[]) => headMock(...args),
    put: vi.fn(),
    del: vi.fn(),
    list: vi.fn(),
  };
});
vi.mock('@/lib/env', () => ({
  env: { blob: { readWriteToken: 'test-token' } },
}));

const KEY = 'invoicing/tenant-a/invoices/inv-1/abc.pdf';

async function loadAdapter() {
  const { vercelBlobAdapter } = await import(
    '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter'
  );
  const { BlobKeyNotFoundError } = await import(
    '@/modules/invoicing/application/ports/blob-storage-port'
  );
  return { vercelBlobAdapter, BlobKeyNotFoundError };
}

beforeEach(() => {
  vi.resetModules();
  headMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('vercelBlobAdapter — NOT-FOUND is the port class, everything else passes through', () => {
  for (const method of ['signDownloadUrl', 'downloadBytes'] as const) {
    it(`${method}: the SDK's own BlobNotFoundError → BlobKeyNotFoundError, cause preserved, key not in the message`, async () => {
      const { BlobNotFoundError } = await import('@vercel/blob');
      const sdkErr = new BlobNotFoundError();
      headMock.mockRejectedValueOnce(sdkErr);
      const { vercelBlobAdapter, BlobKeyNotFoundError } = await loadAdapter();

      const thrown = await vercelBlobAdapter[method](KEY).then(
        () => {
          throw new Error('expected a rejection');
        },
        (e: unknown) => e,
      );

      expect(thrown).toBeInstanceOf(BlobKeyNotFoundError);
      expect((thrown as Error).cause).toBe(sdkErr);
      expect((thrown as Error).message).not.toContain(KEY);
      expect((thrown as Error).message).not.toContain('tenant-a');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`${method}: a rate limit / access / unknown / plain Error rethrows the SAME object`, async () => {
      const { BlobServiceRateLimited, BlobAccessError, BlobUnknownError } = await import(
        '@vercel/blob'
      );
      const { vercelBlobAdapter, BlobKeyNotFoundError } = await loadAdapter();
      for (const e of [
        new BlobServiceRateLimited(),
        new BlobAccessError(),
        new BlobUnknownError(),
        new Error('socket hang up'),
      ]) {
        headMock.mockRejectedValueOnce(e);
        const thrown = await vercelBlobAdapter[method](KEY).then(
          () => {
            throw new Error('expected a rejection');
          },
          (x: unknown) => x,
        );
        expect(thrown).toBe(e);
        expect(thrown).not.toBeInstanceOf(BlobKeyNotFoundError);
      }
    });
  }

  it('signDownloadUrl: a hit returns the SDK url', async () => {
    headMock.mockResolvedValueOnce({ url: 'https://blob.example/abc.pdf' });
    const { vercelBlobAdapter } = await loadAdapter();
    await expect(vercelBlobAdapter.signDownloadUrl(KEY)).resolves.toBe(
      'https://blob.example/abc.pdf',
    );
  });

  it('downloadBytes: a hit fetches the bytes with no-store', async () => {
    headMock.mockResolvedValueOnce({ url: 'https://blob.example/abc.pdf' });
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46])));
    const { vercelBlobAdapter } = await loadAdapter();
    const bytes = await vercelBlobAdapter.downloadBytes(KEY);
    expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(fetchMock).toHaveBeenCalledWith('https://blob.example/abc.pdf', { cache: 'no-store' });
  });

  // head() can succeed and the byte fetch still 404 (object deleted between
  // the two calls, or a CDN miss on a removed object). That is the same
  // missing object, so it is the same port class — not a plain Error.
  it('downloadBytes: head hit but the byte fetch answers 404 → BlobKeyNotFoundError, key not in the message', async () => {
    headMock.mockResolvedValueOnce({ url: 'https://blob.example/abc.pdf' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const { vercelBlobAdapter, BlobKeyNotFoundError } = await loadAdapter();

    const thrown = await vercelBlobAdapter.downloadBytes(KEY).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(BlobKeyNotFoundError);
    expect((thrown as Error).message).not.toContain(KEY);
    expect((thrown as Error).message).not.toContain('tenant-a');
  });

  it('downloadBytes: any other non-OK fetch status stays a plain Error (not a miss), key not in the message', async () => {
    headMock.mockResolvedValueOnce({ url: 'https://blob.example/abc.pdf' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const { vercelBlobAdapter, BlobKeyNotFoundError } = await loadAdapter();

    const thrown = await vercelBlobAdapter.downloadBytes(KEY).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(BlobKeyNotFoundError);
    expect((thrown as Error).message).toContain('HTTP 503');
    expect((thrown as Error).message).not.toContain(KEY);
  });
});
