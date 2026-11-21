// @vitest-environment node
/**
 * #739 PR 2 — a Resend error leaves the gateway as a closed code, never as
 * Resend's own text.
 *
 * `classifyResendError` used to put Resend's `message` into the thrown
 * `reason`, and `super(reason)` made it the error's `.message`. That text is
 * the provider's free prose: it can quote the address or the id the request
 * named. Today it reaches no log line, but any `e.message` read downstream
 * would carry it, and one caller (`reclaim-orphaned-audiences`) already
 * branched on it. So:
 *
 *   - `reason` (and `.message`) is Resend's error `name` when it is one this
 *     build knows, else `http_<status>`, else `network` for a transport fault;
 *   - the "cannot delete the last audience/segment" refusal is recognised here,
 *     inside the adapter, and leaves as `code: 'last_audience'`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GatewayThrowable,
  resendBroadcastsGateway,
} from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { stubResendFetch } from '../../../support/resend/wire-guard';

const BROADCAST_ID = 'bc_11111111-2222-4333-8444-555555555555';
const SEGMENT_ID = '11111111-2222-4333-8444-555555555555';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function thrownBy(call: () => Promise<unknown>): Promise<GatewayThrowable> {
  try {
    await call();
  } catch (e) {
    if (e instanceof GatewayThrowable) return e;
    throw e;
  }
  throw new Error('expected the call to throw');
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyResendError — the reason is a closed code (#739 PR 2)', () => {
  it("a known Resend name becomes the reason and the message; Resend's text never leaves", async () => {
    stubResendFetch(async () =>
      json(422, { statusCode: 422, name: 'validation_error', message: 'The `to` field a@b.example is invalid.' }),
    );
    const e = await thrownBy(() => resendBroadcastsGateway.retrieveBroadcast(BROADCAST_ID));
    expect(e.kind).toBe('permanent');
    expect(e.reason).toBe('validation_error');
    expect(e.message).toBe('validation_error');
    expect(JSON.stringify({ ...e, message: e.message })).not.toContain('@');
  });

  it('a name this build does not know reads as http_<status>', async () => {
    stubResendFetch(async () => json(400, { statusCode: 400, name: 'some_future_name', message: 'free text a@b.example' }));
    const e = await thrownBy(() => resendBroadcastsGateway.retrieveBroadcast(BROADCAST_ID));
    expect(e.reason).toBe('http_400');
    expect(e.message).toBe('http_400');
  });

  it.each([
    'Cannot delete last audience.',
    'You cannot delete your last segment',
    'The last segment cannot be deleted',
    'Cannot remove the last segment',
  ])("deleteAudience's last-audience refusal leaves as code last_audience: %s", async (message) => {
    stubResendFetch(async (_input, init) =>
      (init?.method ?? 'GET') === 'DELETE'
        ? json(403, { statusCode: 403, name: 'validation_error', message })
        : json(200, { object: 'segment', id: SEGMENT_ID, name: 'General' }),
    );
    const e = await thrownBy(() => resendBroadcastsGateway.deleteAudience(SEGMENT_ID));
    expect(e.kind).toBe('permanent');
    expect(e.code).toBe('last_audience');
    expect(e.message).toBe('validation_error');
  });

  it('a refusal that mentions a last segment but does not refuse a delete keeps its own code', async () => {
    stubResendFetch(async (_input, init) =>
      (init?.method ?? 'GET') === 'DELETE'
        ? json(403, { statusCode: 403, name: 'restricted_api_key', message: 'Key cannot read the last segment page' })
        : json(200, { object: 'segment', id: SEGMENT_ID, name: 'General' }),
    );
    const e = await thrownBy(() => resendBroadcastsGateway.deleteAudience(SEGMENT_ID));
    expect(e.code).toBe('restricted_api_key');
  });

  it('review round 1 — a name outside the set never becomes the code either', async () => {
    stubResendFetch(async () => json(400, { statusCode: 400, name: 'some_future_name', message: 'x' }));
    const e = await thrownBy(() => resendBroadcastsGateway.retrieveBroadcast(BROADCAST_ID));
    expect(e.code).toBe('http_400');
  });

  it('review round 1 — the contact-cap answer keeps the plain closed name (its wording is not measured)', async () => {
    stubResendFetch(async () =>
      json(422, { statusCode: 422, name: 'validation_error', message: 'You have reached your contact limit' }),
    );
    const e = await thrownBy(() => resendBroadcastsGateway.createContactImport(SEGMENT_ID, ['a@example.com']));
    expect(e.kind).toBe('permanent');
    expect(e.code).toBe('validation_error');
    expect(e.reason).toBe('validation_error');
  });

  it('review round 1 — a transport failure on the import leg keeps its class: network:<Class>', async () => {
    stubResendFetch(async () => {
      throw new TypeError('fetch failed for a@b.example');
    });
    const e = await thrownBy(() => resendBroadcastsGateway.createContactImport(SEGMENT_ID, ['a@example.com']));
    expect(e.kind).toBe('retryable');
    expect(e.reason).toBe('network:TypeError');
    expect(e.message).not.toContain('@');
  });

  it('review round 1 — an HTML 4xx page on the import leg keeps none of its text', async () => {
    stubResendFetch(async () => new Response('<html>Forbidden for a@b.example</html>', { status: 403 }));
    const e = await thrownBy(() => resendBroadcastsGateway.createContactImport(SEGMENT_ID, ['a@example.com']));
    expect(e.reason).toBe('http_403');
    expect(e.message).toBe('http_403');
  });
});
