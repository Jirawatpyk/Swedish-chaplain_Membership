/**
 * F9 (T069) — download-token helper unit tests (security-critical).
 *
 * Pins: mint is unguessable/unique, hash is deterministic + job-bound, verify is
 * true only for the exact (jobId, token) pair, and a wrong job / tampered hash /
 * wrong token is rejected. The HMAC secret is injected via a minimal env mock
 * (the helper reads only `env.insights.exportDownloadTokenSecret`).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: { insights: { exportDownloadTokenSecret: 'a'.repeat(48) } },
}));

const {
  mintDownloadToken,
  hashDownloadToken,
  verifyDownloadToken,
} = await import('@/lib/export-download-token');

describe('download-token helper', () => {
  const jobId = '11111111-1111-1111-1111-111111111111';

  it('mints distinct, non-trivial tokens', () => {
    const a = mintDownloadToken();
    const b = mintDownloadToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });

  it('hash is deterministic for the same (jobId, token)', () => {
    const token = mintDownloadToken();
    expect(hashDownloadToken(jobId, token)).toBe(hashDownloadToken(jobId, token));
  });

  it('hash is job-bound (same token, different job → different hash)', () => {
    const token = mintDownloadToken();
    expect(hashDownloadToken(jobId, token)).not.toBe(
      hashDownloadToken('22222222-2222-2222-2222-222222222222', token),
    );
  });

  it('verify accepts the exact pair and rejects mismatches', () => {
    const token = mintDownloadToken();
    const stored = hashDownloadToken(jobId, token);
    expect(verifyDownloadToken(jobId, token, stored)).toBe(true);
    // wrong token
    expect(verifyDownloadToken(jobId, mintDownloadToken(), stored)).toBe(false);
    // wrong job (token replay across jobs)
    expect(verifyDownloadToken('33333333-3333-3333-3333-333333333333', token, stored)).toBe(false);
    // tampered/empty stored hash. Flip the last hex char to a guaranteed-different
    // value (a fixed '0' would be a no-op ~1/16 of runs when the hash already ends
    // in '0', making the assertion flaky).
    expect(verifyDownloadToken(jobId, token, '')).toBe(false);
    const tampered = stored.slice(0, -1) + (stored.endsWith('0') ? '1' : '0');
    expect(verifyDownloadToken(jobId, token, tampered)).toBe(false);
  });
});
