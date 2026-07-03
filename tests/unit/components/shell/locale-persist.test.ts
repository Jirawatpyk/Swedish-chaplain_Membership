import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/components/portal/preferred-locale-client', () => ({
  updatePreferredLocale: vi.fn(),
}));
import { updatePreferredLocale } from '@/components/portal/preferred-locale-client';
import {
  runPreferredLocalePersist,
  runAbortablePersist,
  type PersistOutcome,
} from '@/components/shell/locale-persist';
import type { Locale } from '@/i18n/config';

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

  it('stops with aborted (no retry) when superseded (default abort reason)', async () => {
    const ac = new AbortController();
    updateMock.mockImplementation(() => {
      ac.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    expect(await runPreferredLocalePersist('th', ac.signal)).toBe('aborted');
    expect(updateMock).toHaveBeenCalledTimes(1); // did NOT retry after abort
  });

  it('returns failed (not aborted) when the abort carries a TimeoutError reason', async () => {
    const ac = new AbortController();
    updateMock.mockImplementation(() => {
      ac.abort(new DOMException('timed out', 'TimeoutError'));
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    // A timeout is a genuine sync failure — the caller must warn on it.
    expect(await runPreferredLocalePersist('th', ac.signal)).toBe('failed');
    expect(updateMock).toHaveBeenCalledTimes(1); // aborted → no retry
  });
});

describe('runAbortablePersist', () => {
  afterEach(() => vi.useRealTimers());

  const pending = (): (() => Promise<PersistOutcome>) => () => new Promise<PersistOutcome>(() => {});

  it('bounds the sync with a TimeoutError abort after timeoutMs', () => {
    vi.useFakeTimers();
    const ref: { current: AbortController | null } = { current: null };
    let signal: AbortSignal | undefined;
    const run = vi.fn((_l: Locale, s: AbortSignal): Promise<PersistOutcome> => {
      signal = s;
      return pending()();
    });
    runAbortablePersist(ref, 'th', 8000, () => {}, run);
    expect(signal?.aborted).toBe(false);
    vi.advanceTimersByTime(8000);
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as DOMException).name).toBe('TimeoutError');
  });

  it('aborts a previous in-flight sync when called again (abort-previous)', () => {
    vi.useFakeTimers();
    const ref: { current: AbortController | null } = { current: null };
    const signals: AbortSignal[] = [];
    const run = vi.fn((_l: Locale, s: AbortSignal): Promise<PersistOutcome> => {
      signals.push(s);
      return pending()();
    });
    runAbortablePersist(ref, 'th', 8000, () => {}, run);
    runAbortablePersist(ref, 'sv', 8000, () => {}, run);
    expect(signals[0]?.aborted).toBe(true); // superseded
    expect(signals[1]?.aborted).toBe(false); // still live
  });

  it('clears the timeout on completion — no late abort fires', async () => {
    vi.useFakeTimers();
    const ref: { current: AbortController | null } = { current: null };
    let signal: AbortSignal | undefined;
    const run = vi.fn((_l: Locale, s: AbortSignal): Promise<PersistOutcome> => {
      signal = s;
      return Promise.resolve('ok');
    });
    runAbortablePersist(ref, 'th', 8000, () => {}, run);
    await vi.runAllTimersAsync(); // flush the .then/.finally (timer cleared)
    vi.advanceTimersByTime(8000);
    expect(signal?.aborted).toBe(false);
  });

  it('calls onFailed only on a failed outcome', async () => {
    vi.useFakeTimers();
    const ref: { current: AbortController | null } = { current: null };
    const onFailed = vi.fn();
    runAbortablePersist(ref, 'th', 8000, onFailed, () => Promise.resolve('failed'));
    await vi.runAllTimersAsync();
    expect(onFailed).toHaveBeenCalledTimes(1);
  });

  it('does not call onFailed on a non-failed outcome', async () => {
    vi.useFakeTimers();
    const ref: { current: AbortController | null } = { current: null };
    const onFailed = vi.fn();
    runAbortablePersist(ref, 'th', 8000, onFailed, () => Promise.resolve('aborted'));
    await vi.runAllTimersAsync();
    expect(onFailed).not.toHaveBeenCalled();
  });
});
