/**
 * Spec 131 (#658 reliability NEW-1) — the sweep's blob delete is bounded.
 * `statement_timeout` bounds the row's SQL, not this HTTP call, and a hung
 * Vercel Blob `del` held the row's transaction and its content-hash lock
 * until the cron's `maxDuration`, past the Block 2 deadline, so Block 3 never
 * ran. The delete now carries an abort signal; when it fires, the call throws
 * and the sweep counts the row as failed and retries it on the next tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const delMock = vi.fn();

vi.mock('@vercel/blob', async () => {
  const actual = await vi.importActual<typeof import('@vercel/blob')>('@vercel/blob');
  return { ...actual, head: vi.fn(), put: vi.fn(), del: (...args: unknown[]) => delMock(...args) };
});
vi.mock('@/lib/env', () => ({ env: { blob: { readWriteToken: 'test-token' } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  delMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('vercelBlobImageStorage.delete — bounded', () => {
  it('passes an abort signal with the token', async () => {
    delMock.mockResolvedValueOnce(undefined);
    const { vercelBlobImageStorage } = await import('@/modules/broadcasts/infrastructure/vercel-blob-image-storage');
    await vercelBlobImageStorage.delete('broadcasts/images/t/a.png');
    const [key, opts] = delMock.mock.calls[0]! as [string, { token: string; abortSignal?: AbortSignal }];
    expect(key).toBe('broadcasts/images/t/a.png');
    expect(opts.token).toBe('test-token');
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('a delete that hangs is aborted after its bound and throws (the row is retried next tick)', async () => {
    vi.useFakeTimers();
    delMock.mockImplementationOnce(
      (_key: string, opts: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.abortSignal.addEventListener('abort', () => reject(opts.abortSignal.reason));
        }),
    );
    const { vercelBlobImageStorage, IMAGE_BLOB_DELETE_TIMEOUT_MS } = await import(
      '@/modules/broadcasts/infrastructure/vercel-blob-image-storage'
    );
    const pending = vercelBlobImageStorage.delete('broadcasts/images/t/a.png');
    const settled = expect(pending).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(IMAGE_BLOB_DELETE_TIMEOUT_MS + 1);
    await settled;
    expect(IMAGE_BLOB_DELETE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
