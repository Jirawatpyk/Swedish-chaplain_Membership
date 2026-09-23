/**
 * F119 F7-2 — the Vercel Blob adapter's `put` must classify a storage OUTAGE
 * by the INSTALLED SDK's own error classes and hand the use case the PORT
 * error, never leave the use case to read `e.message`.
 *
 * The use case used to test `e.message` against the SDK CLASS names
 * (`/BlobAccessError|BlobStoreSuspendedError|…/`). The real
 * `@vercel/blob@2.3.3` errors carry no class name in their message
 * ("Vercel Blob: This store has been suspended."), so every real outage fell
 * through to a 500 instead of the `storage_unavailable` 503 — and the contract
 * test that pinned it hand-wrote the class name into the message, so it could
 * never fail.
 *
 * The SDK's real error classes are used here on purpose ("gate must read
 * source not data"), as in `vercel-blob-image-storage-probe.test.ts`: the mock
 * keeps `@vercel/blob`'s actual exports and replaces only `head` / `put` /
 * `del`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlobAccessError,
  BlobClientTokenExpiredError,
  BlobError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobStoreSuspendedError,
} from '@vercel/blob';
import { ImageStorageUnavailableError } from '@/modules/broadcasts/application/ports/image-storage-port';
import { vercelBlobImageStorage } from '@/modules/broadcasts/infrastructure/vercel-blob-image-storage';

const putMock = vi.fn();

vi.mock('@vercel/blob', async () => {
  const actual = await vi.importActual<typeof import('@vercel/blob')>('@vercel/blob');
  return {
    ...actual,
    head: vi.fn(),
    put: (...args: unknown[]) => putMock(...args),
    del: vi.fn(),
  };
});
vi.mock('@/lib/env', () => ({
  env: { blob: { readWriteToken: 'test-token' } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const INPUT = {
  tenantId: 'test-tenant' as never,
  bytes: new Uint8Array([1, 2, 3]),
  contentHash: 'a'.repeat(64),
  mimeType: 'image/png' as const,
  sanitisedFilename: 'x.png',
};

afterEach(() => putMock.mockReset());

describe('vercelBlobImageStorage.put — outage classification vs the installed SDK', () => {
  it.each([
    ['BlobAccessError', () => new BlobAccessError()],
    ['BlobStoreSuspendedError', () => new BlobStoreSuspendedError()],
    ['BlobClientTokenExpiredError', () => new BlobClientTokenExpiredError()],
    ['BlobServiceRateLimited', () => new BlobServiceRateLimited()],
    ['BlobServiceNotAvailable', () => new BlobServiceNotAvailable()],
  ])('%s → ImageStorageUnavailableError carrying the SDK error as cause', async (_name, make) => {
    const sdkError = make();
    putMock.mockRejectedValueOnce(sdkError);
    const rejection = await vercelBlobImageStorage.put(INPUT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(rejection).toBeInstanceOf(ImageStorageUnavailableError);
    expect((rejection as Error).message).toBe(sdkError.message);
    expect((rejection as Error).cause).toBe(sdkError);
  });

  it('the already-exists refusal (a plain BlobError) passes through UNCHANGED — isBlobAlreadyExists reads it', async () => {
    // Verbatim from the live dev store, measured 2026-09-22 (@vercel/blob
    // 2.3.3 has no already-exists subclass). All five outage classes ALSO
    // extend BlobError, which is why the adapter must never test the base.
    const alreadyExists = new BlobError(
      'This blob already exists, use `allowOverwrite: true` if you want to overwrite it. ' +
        'Or `addRandomSuffix: true` to generate a unique filename. ' +
        'Read more about this error in our documentation: https://vercel.link/blob-allow-overwrite',
    );
    putMock.mockRejectedValueOnce(alreadyExists);
    await expect(vercelBlobImageStorage.put(INPUT)).rejects.toBe(alreadyExists);
  });

  it('a generic Error passes through UNCHANGED (a 500, never masked as an outage)', async () => {
    const generic = new Error('socket hang up');
    putMock.mockRejectedValueOnce(generic);
    await expect(vercelBlobImageStorage.put(INPUT)).rejects.toBe(generic);
  });
});
