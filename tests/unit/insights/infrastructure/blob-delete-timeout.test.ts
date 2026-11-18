/**
 * #710 — the insights Blob deletes are bounded: a hung Vercel Blob `del` must
 * not run the member-erasure route past its `maxDuration` (it then never
 * answers `cascadesComplete:false`). Same 10 s bound as the invoicing and
 * broadcasts Blob deletes.
 */
import { describe, expect, it, vi } from 'vitest';

const del = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@vercel/blob', () => ({ del, put: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: { blob: { readWriteToken: 'rw', privateReadWriteToken: 'prw' } },
}));

const { publicLogoBlobAdapter } = await import(
  '@/modules/insights/infrastructure/logo/public-logo-blob-adapter'
);
const { privateBlobAdapter } = await import(
  '@/modules/insights/infrastructure/blob/private-blob-adapter'
);

describe('#710 insights Blob deletes carry a timeout', () => {
  it('deleteLogo passes an abort signal', async () => {
    await publicLogoBlobAdapter.deleteLogo('https://blob/logo.png');
    const opts = (del.mock.calls.at(-1) as unknown[] | undefined)?.[1] as { abortSignal?: unknown };
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('private delete passes an abort signal', async () => {
    await privateBlobAdapter.delete('exports/t/job.zip');
    const opts = (del.mock.calls.at(-1) as unknown[] | undefined)?.[1] as { abortSignal?: unknown };
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
