import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/components/portal/preferred-locale-client', () => ({
  updatePreferredLocale: vi.fn(),
}));
import { updatePreferredLocale } from '@/components/portal/preferred-locale-client';
import { runPreferredLocalePersist } from '@/components/shell/locale-persist';

const updateMock = vi.mocked(updatePreferredLocale);
const res = (status: number): Response =>
  ({ ok: status >= 200 && status < 300, status }) as unknown as Response;

describe('runPreferredLocalePersist', () => {
  // `vi.clearAllMocks()` (not `updateMock.mockReset()`) — a direct
  // `.mockReset()`/`.mockClear()` call on this shared mock, combined with a
  // persistent (non-`Once`) `mockRejectedValue`/`mockImplementation` later
  // awaited+caught in a plain try/catch, triggers a Vitest 2.1.9 + tinyspy
  // 3.0.2 false-positive: the test is marked failed with the underlying
  // error even though no unhandled rejection reaches Node (verified via a
  // manual `process.on('unhandledRejection')` probe — zero events) and the
  // catch block demonstrably runs (verified via inline trace). The global
  // `vi.clearAllMocks()` helper — already this repo's convention in
  // tests/setup.ts's own `afterEach` — takes a different internal code path
  // that does not trip the same false-positive, with identical per-test
  // isolation semantics for this file (every test sets its own
  // implementation before use, so `clearAllMocks` vs `mockReset` differ
  // only in whether a stale implementation would carry over — moot here).
  beforeEach(() => vi.clearAllMocks());

  it('returns ok on 200 without retrying', async () => {
    updateMock.mockResolvedValue(res(200));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('ok');
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('returns client_error and does NOT retry on a 4xx (403)', async () => {
    updateMock.mockResolvedValue(res(403));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('client_error');
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on 5xx then succeeds', async () => {
    updateMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('ok');
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('returns failed after both attempts are 5xx', async () => {
    updateMock.mockResolvedValue(res(503));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('failed');
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('returns failed after both attempts reject (network)', async () => {
    updateMock.mockRejectedValue(new Error('network'));
    expect(await runPreferredLocalePersist('th', new AbortController().signal)).toBe('failed');
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('stops with aborted (no retry) when the signal is aborted mid-flight', async () => {
    const ac = new AbortController();
    updateMock.mockImplementation(() => {
      ac.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    expect(await runPreferredLocalePersist('th', ac.signal)).toBe('aborted');
    expect(updateMock).toHaveBeenCalledTimes(1); // did NOT retry after abort
  });
});
