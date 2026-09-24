/**
 * `isReadOnlyResponse` — the READ_ONLY_MODE refusal read off a live
 * `Response`, for the member forms that decide on the status before (or
 * without) parsing the body themselves.
 *
 * It reads a CLONE: several callers go on to read the body for their own
 * codes (`readErrorCode`, the resend button's 409), and a consumed body there
 * would turn every refusal into "unknown".
 */
import { describe, expect, it } from 'vitest';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('isReadOnlyResponse', () => {
  it("is true for the proxy's flat 503", async () => {
    expect(await isReadOnlyResponse(json(503, { error: 'read-only-mode' }))).toBe(true);
  });

  it("is true for a route guard's nested 503", async () => {
    expect(
      await isReadOnlyResponse(json(503, { error: { code: 'read_only_mode' } })),
    ).toBe(true);
  });

  it('is false for any other 503, and for the code on another status', async () => {
    expect(
      await isReadOnlyResponse(json(503, { error: { code: 'suppression_unavailable' } })),
    ).toBe(false);
    expect(await isReadOnlyResponse(json(500, { error: 'read-only-mode' }))).toBe(false);
    expect(await isReadOnlyResponse(new Response('<html>', { status: 503 }))).toBe(false);
  });

  it("leaves the caller's body unread", async () => {
    const res = json(503, { error: 'read-only-mode' });
    await isReadOnlyResponse(res);
    expect(res.bodyUsed).toBe(false);
    await expect(res.json()).resolves.toEqual({ error: 'read-only-mode' });
  });

  it('never reads the body of a non-503', async () => {
    const res = json(409, { error: { code: 'no_recipient' } });
    await isReadOnlyResponse(res);
    await expect(res.json()).resolves.toEqual({ error: { code: 'no_recipient' } });
  });
});
