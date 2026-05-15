/**
 * Unit tests for `loadTenantLogo` helper.
 *
 * Behaviour matrix:
 *   1. null / undefined key  → null (no fetch attempted)
 *   2. *.png key             → format 'png' + bytes from blob
 *   3. *.jpg / *.jpeg key    → format 'jpg' + bytes from blob
 *   4. blob fetch throws     → null (logged) — never propagates so the
 *                              tax-document render survives a Blob outage
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadTenantLogo,
  _resetLogoCacheForTesting,
} from '@/modules/invoicing/application/lib/load-tenant-logo';
import type { BlobStoragePort } from '@/modules/invoicing/application/ports/blob-storage-port';

beforeEach(() => {
  // Clear the in-process logo cache between tests so each case starts
  // from a known empty-cache state. Cache hits would otherwise mask
  // changes in blob.downloadBytes call counts.
  _resetLogoCacheForTesting();
});

function makeBlobStub(
  overrides: Partial<BlobStoragePort> = {},
): BlobStoragePort {
  return {
    uploadPdf: vi.fn(),
    uploadLogo: vi.fn(),
    signDownloadUrl: vi.fn(),
    downloadBytes: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    ...overrides,
  } as BlobStoragePort;
}

describe('loadTenantLogo', () => {
  it('returns null when logoBlobKey is null', async () => {
    const blob = makeBlobStub();
    const result = await loadTenantLogo(blob, null);
    expect(result).toBeNull();
    expect(blob.downloadBytes).not.toHaveBeenCalled();
  });

  it('returns null when logoBlobKey is undefined', async () => {
    const blob = makeBlobStub();
    const result = await loadTenantLogo(blob, undefined);
    expect(result).toBeNull();
    expect(blob.downloadBytes).not.toHaveBeenCalled();
  });

  it('returns null when logoBlobKey is empty string', async () => {
    const blob = makeBlobStub();
    const result = await loadTenantLogo(blob, '');
    expect(result).toBeNull();
    expect(blob.downloadBytes).not.toHaveBeenCalled();
  });

  it('returns bytes + png format for *.png key', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const blob = makeBlobStub({
      downloadBytes: vi.fn().mockResolvedValue(bytes),
    });
    const key = 'invoicing/test-tenant/logos/abc-uuid.png';

    const result = await loadTenantLogo(blob, key);

    expect(result).toEqual({ bytes, format: 'png' });
    expect(blob.downloadBytes).toHaveBeenCalledWith(key);
  });

  it('returns bytes + jpg format for *.jpg key', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const blob = makeBlobStub({
      downloadBytes: vi.fn().mockResolvedValue(bytes),
    });
    const key = 'invoicing/test-tenant/logos/photo.jpg';

    const result = await loadTenantLogo(blob, key);

    expect(result).toEqual({ bytes, format: 'jpg' });
  });

  it('detects format case-insensitively (.PNG → png)', async () => {
    const bytes = new Uint8Array([0x89]);
    const blob = makeBlobStub({
      downloadBytes: vi.fn().mockResolvedValue(bytes),
    });
    const result = await loadTenantLogo(
      blob,
      'invoicing/test-tenant/logos/abc.PNG',
    );

    expect(result?.format).toBe('png');
  });

  it('returns null on blob fetch failure (does not throw)', async () => {
    const blob = makeBlobStub({
      downloadBytes: vi
        .fn()
        .mockRejectedValue(new Error('vercel-blob: HTTP 404')),
    });
    const result = await loadTenantLogo(
      blob,
      'invoicing/test-tenant/logos/gone.png',
    );

    expect(result).toBeNull();
  });

  it('caches successful loads — second call for same key does not re-fetch', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const downloadBytes = vi.fn().mockResolvedValue(bytes);
    const blob = makeBlobStub({ downloadBytes });
    const key = 'invoicing/test-tenant/logos/cached.png';

    const first = await loadTenantLogo(blob, key);
    const second = await loadTenantLogo(blob, key);

    expect(first).toEqual({ bytes, format: 'png' });
    expect(second).toEqual({ bytes, format: 'png' });
    // Cache hit on second call — blob.downloadBytes only invoked once.
    expect(downloadBytes).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache failures — retries on the next call', async () => {
    const downloadBytes = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(new Uint8Array([9]));
    const blob = makeBlobStub({ downloadBytes });
    const key = 'invoicing/test-tenant/logos/transient.png';

    const first = await loadTenantLogo(blob, key);
    const second = await loadTenantLogo(blob, key);

    expect(first).toBeNull();
    expect(second).toEqual({ bytes: new Uint8Array([9]), format: 'png' });
    expect(downloadBytes).toHaveBeenCalledTimes(2);
  });
});
