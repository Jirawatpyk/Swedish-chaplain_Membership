/**
 * 108 PR-C T089 (US5 / FR-040, FR-040b; contract § 5) — `useRecipientCount`:
 * the compose page's live count. Pinned:
 *   - the fetch is debounced 400 ms and coalesced: a segment change inside the
 *     window issues ONE request, for the LATEST segment;
 *   - member mode calls `/api/broadcasts/recipient-count`, admin mode calls
 *     `/api/admin/broadcasts/recipient-count?member_id=…`; both with
 *     `credentials: 'same-origin'`;
 *   - `custom` (counted client-side), a `tier` with no codes, and admin mode
 *     without a member are `idle` — no request;
 *   - 200 → `ready` with the numbers; any non-200 or a network error →
 *     `unavailable` (never a stale number, FR-040b);
 *   - a response that arrives AFTER a newer request was issued is ignored.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRecipientCount } from '@/components/broadcast/recipient-count';

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const READY = { count: 1234, ceiling: 5000, exceeds: false, orphans: 0, droppedByPreference: 2 };

describe('useRecipientCount (108 PR-C T089)', () => {
  let fetchMock: FetchMock;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => jsonResponse(200, READY));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('debounces 400 ms: loading at once, no request before the window, one request after', async () => {
    const { result } = renderHook(() =>
      useRecipientCount({ mode: 'member', segment: { kind: 'all_members', tierCodes: [] } }),
    );
    expect(result.current.status).toBe('loading');
    await act(async () => {
      vi.advanceTimersByTime(399);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/broadcasts/recipient-count?segment=all_members');
    expect(init.credentials).toBe('same-origin');
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual({ status: 'ready', ...READY });
  });

  it('coalesces a segment change inside the window into ONE request for the latest segment', async () => {
    const { rerender } = renderHook(
      (props: { tierCodes: string[] }) =>
        useRecipientCount({ mode: 'member', segment: { kind: 'tier', tierCodes: props.tierCodes } }),
      { initialProps: { tierCodes: ['corporate'] } },
    );
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    rerender({ tierCodes: ['corporate', 'partnership'] });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      '/api/broadcasts/recipient-count?segment=tier&tier=corporate%2Cpartnership',
    );
  });

  it.each([
    ['custom list', { mode: 'member' as const, segment: { kind: 'custom' as const, tierCodes: [] } }],
    ['tier without codes', { mode: 'member' as const, segment: { kind: 'tier' as const, tierCodes: [] } }],
    ['admin without a member', { mode: 'admin' as const, memberId: null, segment: { kind: 'all_members' as const, tierCodes: [] } }],
  ])('%s → idle, no request', async (_label, props) => {
    const { result } = renderHook(() => useRecipientCount(props));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.status).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admin mode counts for the proxied member through the admin endpoint', async () => {
    renderHook(() =>
      useRecipientCount({
        mode: 'admin',
        memberId: '11111111-1111-4111-8111-111111111111',
        segment: { kind: 'all_members', tierCodes: [] },
      }),
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      '/api/admin/broadcasts/recipient-count?member_id=11111111-1111-4111-8111-111111111111&segment=all_members',
    );
  });

  it.each([[503], [429], [500]])('a %s answer → unavailable (never a stale number)', async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, { error: { code: 'x' } }));
    const { result } = renderHook(() =>
      useRecipientCount({ mode: 'member', segment: { kind: 'all_members', tierCodes: [] } }),
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('unavailable');
  });

  it('a network failure → unavailable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() =>
      useRecipientCount({ mode: 'member', segment: { kind: 'all_members', tierCodes: [] } }),
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('unavailable');
  });

  it('a late response for an older request is ignored; the newer request wins', async () => {
    let resolveFirst: (r: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => jsonResponse(200, { ...READY, count: 2 }));
    const { result, rerender } = renderHook(
      (props: { kind: 'all_members' | 'event_attendees_last_90d' }) =>
        useRecipientCount({ mode: 'member', segment: { kind: props.kind, tierCodes: [] } }),
      { initialProps: { kind: 'all_members' } },
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender({ kind: 'event_attendees_last_90d' });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: 'ready', count: 2 });
    await act(async () => {
      resolveFirst(jsonResponse(200, { ...READY, count: 999 }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current).toMatchObject({ status: 'ready', count: 2 });
  });
});
