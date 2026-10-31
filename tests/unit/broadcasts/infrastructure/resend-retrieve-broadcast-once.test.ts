// @vitest-environment node
/**
 * Spec 139 review round 1 — `retrieveBroadcastOnce`, the probe the erasure
 * cascade makes UNDER the broadcast row's lock after a DELETE 404 or 403.
 *
 * `retrieveBroadcast` goes through `withRetry` (up to 31 s) over the Resend
 * SDK, which has no timeout, so it may not run under the lock. This method
 * makes ONE attempt over a raw `fetch` with a 10 s `AbortSignal.timeout` and
 * answers a typed outcome; it never throws:
 *
 *   - 200 → `present` with `normaliseStatus`'s reading of `status`;
 *   - 404 / 410 → `not_found`;
 *   - 5xx / 429 / a transport failure / the timeout → `retryable`;
 *   - any other status, or a 200 without a status string → `other`.
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

const retrieveOnce = (id: string) => resendBroadcastsGateway.retrieveBroadcastOnce(id);

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

describe('resendBroadcastsGateway.retrieveBroadcastOnce (spec 139 review round 1)', () => {
  it.each([
    ['draft', 'draft'],
    ['queued', 'queued'],
    ['sending', 'sending'],
    ['sent', 'sent'],
    ['cancelled', 'cancelled'],
    // MEASURED 2026-10-30 (live account, sink only, 2 runs): a queued broadcast
    // cancelled through POST /broadcasts/{id}/cancel answers `canceled` — ONE L,
    // as Resend's docs spell it. It is the same state as ours.
    ['canceled', 'cancelled'],
    // Spec 140 s1 — MEASURED 2026-10-29: deleting the audience of a queued
    // broadcast turns it `failed`, no mail. This reader (and only this one —
    // `retrieveBroadcast` still reads it `unknown`) names it, so the erasure
    // cascade can record such a copy as retained at Resend.
    ['failed', 'failed'],
    ['scheduled', 'unknown'],
  ] as const)('200 with status %s → present %s: one GET /broadcasts/{id}, authorised, carrying an abort signal', async (raw, status) => {
    stubFetch(() => json(200, { object: 'broadcast', id: BROADCAST_ID, status: raw }));
    expect(await retrieveOnce(BROADCAST_ID)).toEqual({ kind: 'present', status });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      url: `https://api.resend.com/broadcasts/${encodeURIComponent(BROADCAST_ID)}`,
      method: 'GET',
      hasSignal: true,
    });
    expect(captured[0]!.authorization).toMatch(/^Bearer /);
  });

  it.each([404, 410])('%i → not_found', async (status) => {
    stubFetch(() => json(status, { statusCode: status, name: 'not_found', message: 'Broadcast not found' }));
    expect(await retrieveOnce(BROADCAST_ID)).toEqual({ kind: 'not_found' });
  });

  it.each([500, 502, 503, 429])('%i → retryable, after exactly ONE call (no withRetry backoff under the row lock)', async (status) => {
    stubFetch(() => json(status, { statusCode: status, name: 'internal_server_error', message: 'boom' }));
    expect(await retrieveOnce(BROADCAST_ID)).toEqual({ kind: 'retryable' });
    expect(captured).toHaveLength(1);
  });

  it.each([
    ['the 10 s timeout fired', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['a network failure', new TypeError('fetch failed')],
  ])('%s → retryable, one call, never a throw', async (_why, thrown) => {
    stubFetch(() => Promise.reject(thrown));
    expect(await retrieveOnce(BROADCAST_ID)).toEqual({ kind: 'retryable' });
    expect(captured).toHaveLength(1);
  });

  it.each([
    ['a 403 (a restricted key)', () => json(403, { statusCode: 403, name: 'restricted_api_key', message: 'nope' })],
    ['a 422', () => json(422, { statusCode: 422, name: 'validation_error', message: 'nope' })],
    ['a 200 without a status', () => json(200, { object: 'broadcast', id: BROADCAST_ID })],
    ['a 200 whose body is not JSON', () => new Response('<html>', { status: 200 })],
  ])('%s → other', async (_why, respond) => {
    stubFetch(respond);
    expect(await retrieveOnce(BROADCAST_ID)).toEqual({ kind: 'other' });
    expect(captured).toHaveLength(1);
  });
});

// Spec 139 (senior-tester) — D-040's lock-hold bound rests on this number:
// each call is ONE bounded fetch of 10 s, never the SDK's untimed request.
it('bounds the GET with AbortSignal.timeout(10_000)', async () => {
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
  stubFetch(() => json(200, { object: 'broadcast', id: BROADCAST_ID, status: 'draft' }));
  await retrieveOnce(BROADCAST_ID);
  expect(timeoutSpy).toHaveBeenCalledTimes(1);
  expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  timeoutSpy.mockRestore();
});
