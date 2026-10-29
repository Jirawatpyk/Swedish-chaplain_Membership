// @vitest-environment node
/**
 * Spec 139 P1 — `deleteBroadcastOnce`, the DELETE the erasure cascade makes
 * while it holds the broadcast row's lock.
 *
 * `deleteBroadcast` goes through `withRetry` (1 + 2 + 4 + 8 + 16 s of backoff,
 * so up to 31 s) and the Resend SDK has no timeout at all, so a slow DELETE
 * would hold the row lock — and block every dispatch tick that reaches the row
 * — for as long as Resend takes. This method makes ONE attempt over a raw
 * `fetch` with a 10 s `AbortSignal.timeout`, and answers a typed outcome
 * instead of `void`, because the cascade acts differently on each:
 *
 *   - 200 → `deleted`; 404 / 410 → `absent` (both let the cascade cancel);
 *   - 403 → `forbidden` (MEASURED 2026-10-29: Resend's answer for a `queued` or
 *     `sent` broadcast — and also for a restricted key, so the caller probes);
 *   - 5xx / 429 / a transport failure / the timeout → `retryable`;
 *   - any other status → `other`.
 *
 * A retryable answer is NOT retried here: the cascade counts it unexpected and
 * the `reconcile-erasures` cron drives it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

const BROADCAST_ID = 'bc_11111111-2222-4333-8444-555555555555';

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly hasSignal: boolean;
}

const captured: Captured[] = [];

function stubFetch(respond: () => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers ?? {}).get('authorization'),
        hasSignal: init?.signal instanceof AbortSignal,
      });
      return respond();
    }),
  );
}

/**
 * Through `?.`, so that before the method exists every case fails on its own
 * assertion rather than on a TypeError.
 */
const deleteOnce = (id: string) => resendBroadcastsGateway.deleteBroadcastOnce?.(id);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  // `tests/setup.ts` installs fake timers globally; this method must not wait
  // on any of them, and a case that did would hang rather than fail.
  vi.useRealTimers();
  captured.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resendBroadcastsGateway.deleteBroadcastOnce (spec 139 P1)', () => {
  it('exists on the gateway', () => {
    expect(resendBroadcastsGateway.deleteBroadcastOnce).toBeTypeOf('function');
  });

  it('200 → deleted: one DELETE /broadcasts/{id}, authorised, carrying an abort signal', async () => {
    stubFetch(() => json(200, { object: 'broadcast', id: BROADCAST_ID, deleted: true }));
    expect(await deleteOnce(BROADCAST_ID)).toEqual({ kind: 'deleted' });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      url: `https://api.resend.com/broadcasts/${encodeURIComponent(BROADCAST_ID)}`,
      method: 'DELETE',
      hasSignal: true,
    });
    expect(captured[0]!.authorization).toMatch(/^Bearer /);
  });

  it.each([404, 410])('%i → absent (already gone is the goal)', async (status) => {
    stubFetch(() => json(status, { statusCode: status, name: 'not_found', message: 'Broadcast not found' }));
    expect(await deleteOnce(BROADCAST_ID)).toEqual({ kind: 'absent' });
  });

  it('403 → forbidden (queued / sent, MEASURED — or a restricted key: the caller probes)', async () => {
    stubFetch(() =>
      json(403, { statusCode: 403, name: 'validation_error', message: 'Only draft or scheduled broadcasts can be deleted' }),
    );
    expect(await deleteOnce(BROADCAST_ID)).toEqual({ kind: 'forbidden' });
  });

  it.each([500, 502, 503, 429])('%i → retryable, after exactly ONE call (no withRetry backoff under the row lock)', async (status) => {
    stubFetch(() => json(status, { statusCode: status, name: 'internal_server_error', message: 'boom' }));
    expect(await deleteOnce(BROADCAST_ID)).toEqual({ kind: 'retryable' });
    expect(captured).toHaveLength(1);
  });

  it.each([
    ['the 10 s timeout fired', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['the request was aborted', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
    ['a network failure', new TypeError('fetch failed')],
  ])('%s → retryable (ambiguous: the row stays as it is), one call', async (_why, thrown) => {
    stubFetch(() => Promise.reject(thrown));
    expect(await deleteOnce(BROADCAST_ID)).toEqual({ kind: 'retryable' });
    expect(captured).toHaveLength(1);
  });

  it.each([400, 401, 422])('%i → other', async (status) => {
    stubFetch(() => json(status, { statusCode: status, name: 'validation_error', message: 'nope' }));
    expect(await deleteOnce(BROADCAST_ID)).toEqual({ kind: 'other' });
    expect(captured).toHaveLength(1);
  });
});
