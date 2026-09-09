// @vitest-environment node
/**
 * 108 Phase 9 review round 3, finding 3-1 — **the `Idempotency-Key` header was
 * never transmitted on the send.**
 *
 * `sendBroadcast` called `sdk.broadcasts.send(broadcastId, { idempotencyKey })`
 * under a comment reading "Resend SDK accepts idempotencyKey as a request
 * option". In `resend@4.8.0` that helper is
 *
 *     send(id, payload) => this.resend.post(`/broadcasts/${id}/send`,
 *                                           { scheduled_at: payload?.scheduledAt })
 *
 * — TWO arguments (`node_modules/resend/dist/index.js:252`). The header is set
 * only from `post()`'s THIRD `options` argument (`:599`), which the sibling
 * `broadcasts.create` does pass. `SendBroadcastOptions` declares only
 * `scheduledAt`, so the call did not typecheck either — an
 * `as Parameters<typeof sdk.broadcasts.send>[1]` cast silenced that.
 *
 * So there was a comment asserting a guarantee, a cast hiding the compiler's
 * objection, and a green suite. Nothing in `tests/` mentioned `idempotencyKey`
 * or `Idempotency-Key` at all.
 *
 * **This file therefore asserts the HEADER ON THE WIRE, not the call.** A test
 * that spied on `sdk.broadcasts.send` would have passed throughout the bug —
 * that call was always made, with the key in hand, going nowhere.
 *
 * Runs under `node` for the same reason as `resend-contact-import.test.ts`:
 * this is Node-side HTTP code, and the repo's global fake timers must be turned
 * off or `withRetry`'s real `setTimeout` hangs to the 30 s harness timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resendBroadcastsGateway } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

const BROADCAST_ID = 'bc_11111111-2222-4333-8444-555555555555';
const IDEMPOTENCY_KEY = 'broadcast-test-tenant-44444444-4444-4444-8444-444444444444';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly idempotencyKey: string | null;
  readonly body: string;
}

const captured: CapturedRequest[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(respond: (call: number) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      captured.push({
        url: String(input),
        method: init?.method ?? 'GET',
        // Header lookup is case-insensitive through `Headers`, so this does not
        // depend on how the SDK spells it.
        idempotencyKey: headers.get('idempotency-key'),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return respond(captured.length);
    }),
  );
}

beforeEach(() => {
  vi.useRealTimers();
  captured.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendBroadcast — the idempotency contract (round 3 finding 3-1)', () => {
  it('puts the Idempotency-Key ON THE WIRE, at the send path', async () => {
    stubFetch(() => jsonResponse(200, { id: BROADCAST_ID }));

    await resendBroadcastsGateway.sendBroadcast(BROADCAST_ID, IDEMPOTENCY_KEY);

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`https://api.resend.com/broadcasts/${BROADCAST_ID}/send`);
    // The assertion the whole finding is about.
    expect(req.idempotencyKey).toBe(IDEMPOTENCY_KEY);
  });

  /**
   * The body must stay equivalent to what the SDK helper sent
   * (`{scheduled_at: undefined}`, which serialises away), so switching to
   * `post()` changes the HEADER and nothing else. A body carrying an unexpected
   * `scheduled_at: null` would be a different request to Resend.
   */
  it('sends an empty JSON body — switching to post() changed the header, not the request', async () => {
    stubFetch(() => jsonResponse(200, { id: BROADCAST_ID }));

    await resendBroadcastsGateway.sendBroadcast(BROADCAST_ID, IDEMPOTENCY_KEY);

    expect(JSON.parse(captured[0]!.body || '{}')).toEqual({});
  });

  /**
   * The reason the key matters: `withRetry` re-fires this request. Before the
   * fix a 5xx after Resend had already accepted the send re-posted with NO key,
   * which is a second delivery to the whole audience. Now every attempt in a
   * retry sequence carries the SAME key, so Resend can collapse them.
   *
   * Pinning "every attempt", not "the first attempt", is deliberate: a fix that
   * generated the key inside the retry loop would pass a first-attempt-only
   * assertion and still duplicate.
   */
  it('reuses the SAME key across withRetry attempts, so a retried send can be collapsed', async () => {
    stubFetch((call) =>
      call === 1
        ? jsonResponse(500, { message: 'upstream boom' })
        : jsonResponse(200, { id: BROADCAST_ID }),
    );

    await resendBroadcastsGateway.sendBroadcast(BROADCAST_ID, IDEMPOTENCY_KEY);

    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(new Set(captured.map((c) => c.idempotencyKey))).toEqual(
      new Set([IDEMPOTENCY_KEY]),
    );
  });

  /**
   * Positive control. Without it, a `sendBroadcast` that swallowed every
   * response would satisfy the header assertions above while never reporting a
   * real refusal — and a 4xx here is the Free plan's cap, the one failure this
   * account is most likely to meet.
   */
  it('still throws on a 4xx rather than reporting a send that did not happen', async () => {
    // `statusCode` must be in the BODY, not merely the HTTP status:
    // `classifyResendError` reads `err?.statusCode ?? 500`, and the SDK builds
    // its `error` object from the parsed JSON. Resend does send it. An earlier
    // draft of this case omitted it, so a 422 was classified 500, `withRetry`
    // backed off six times and the case hit the 30 s harness timeout — which
    // reads as a hung adapter rather than a wrong fixture.
    stubFetch(() =>
      jsonResponse(422, { statusCode: 422, name: 'validation_error', message: 'not allowed' }),
    );

    await expect(
      resendBroadcastsGateway.sendBroadcast(BROADCAST_ID, IDEMPOTENCY_KEY),
    ).rejects.toThrow();
    // Exactly one attempt: a permanent classification must not be retried, or
    // six identical sends go out while the caller waits.
    expect(captured).toHaveLength(1);
  });
});
