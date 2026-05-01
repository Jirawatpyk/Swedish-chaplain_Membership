/**
 * T149 — Contract test: POST /api/webhooks/resend-broadcasts.
 *
 * One test per handled Resend event type:
 *   - email.sent
 *   - email.delivered
 *   - email.bounced
 *   - email.complained
 *
 * Plus the wire-contract surfaces:
 *   - missing svix-* headers → 401 `missing_header`
 *   - invalid signature → 401 `bad_signature` + audit
 *   - kill-switch off → 503 `feature_disabled`
 *   - body too large (Content-Length pre-guard) → 401
 *   - unknown resend_broadcast_id → 200 OK (no retry storm)
 *
 * Asserts the route → use-case wiring contract (input shape + result
 * → HTTP code map). Branching behaviour per event type lives at the
 * use-case unit-test level (process-webhook-event.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const processWebhookEventMock = vi.fn();
const resolveTenantByResendBroadcastIdMock = vi.fn();
const constructEventMock = vi.fn();
const dbExecuteMock = vi.fn();

const envMock = {
  features: { f7Broadcasts: true },
  broadcasts: { webhookSecret: 'whsec_dGVzdHNlY3JldA==' },
};

vi.mock('@/lib/env', () => ({
  env: envMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: { execute: (...a: unknown[]) => dbExecuteMock(...a) },
}));
// Lightweight stub of the module barrel — we only mock the 5 symbols
// the route handler actually imports. Avoids `importActual` which
// triggers the upstash-rate-limiter module load (env-dependent).
class WebhookSignatureErrorStub extends Error {
  public readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
    this.kind = kind;
  }
}
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  processWebhookEvent: (...args: unknown[]) =>
    processWebhookEventMock(...args),
  makeProcessWebhookEventDeps: () => ({}),
  resolveTenantByResendBroadcastId: (...args: unknown[]) =>
    resolveTenantByResendBroadcastIdMock(...args),
  resendBroadcastsWebhookVerifier: {
    constructEvent: (...args: unknown[]) => constructEventMock(...args),
  },
  WebhookSignatureError: WebhookSignatureErrorStub,
}));

const VALID_BROADCAST_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RESEND_BROADCAST_ID = 'rsb-test-1';

function makeRequest(opts: {
  body: string;
  withSig?: boolean;
  contentLength?: string;
}): NextRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opts.withSig !== false) {
    headers['svix-id'] = 'msg_test';
    headers['svix-timestamp'] = '1700000000';
    headers['svix-signature'] = 'v1,c2lnbmF0dXJl';
  }
  if (opts.contentLength !== undefined) {
    headers['content-length'] = opts.contentLength;
  }
  return new NextRequest('http://localhost/api/webhooks/resend-broadcasts', {
    method: 'POST',
    headers,
    body: opts.body,
  });
}

function buildVerifiedEvent(
  status: 'sent' | 'delivered' | 'bounced' | 'soft_bounced' | 'complained',
  bounceType?: 'hard' | 'soft',
) {
  return {
    id: `evt_${status}_${Math.random().toString(36).slice(2, 7)}`,
    type: `email.${status === 'soft_bounced' ? 'delivery_delayed' : status}`,
    createdAtUnixSeconds: 1700000000,
    data: {
      broadcastId: RESEND_BROADCAST_ID,
      recipientEmail: 'alice@example.com',
      resendMessageId: 'mid-1',
      status,
      ...(bounceType !== undefined && { bounceType }),
    },
  };
}

async function importRoute() {
  return import('@/app/api/webhooks/resend-broadcasts/route');
}

beforeEach(() => {
  envMock.features.f7Broadcasts = true;
  processWebhookEventMock.mockReset();
  resolveTenantByResendBroadcastIdMock.mockReset();
  constructEventMock.mockReset();
  dbExecuteMock.mockReset();
  dbExecuteMock.mockResolvedValue([]);
  resolveTenantByResendBroadcastIdMock.mockResolvedValue({
    tenantId: 'test-tenant',
    broadcastId: VALID_BROADCAST_ID,
  });
  processWebhookEventMock.mockResolvedValue(
    ok({
      kind: 'recorded',
      broadcastId: VALID_BROADCAST_ID,
      transitionedToSent: false,
      suppressionAdded: false,
      memberHalted: false,
    }),
  );
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/webhooks/resend-broadcasts (T149 contract)', () => {
  it.each([
    ['email.sent', 'sent'],
    ['email.delivered', 'delivered'],
    ['email.bounced', 'bounced'],
    ['email.complained', 'complained'],
  ] as const)(
    '%s event: route returns 200 + invokes processWebhookEvent with branded broadcastId',
    async (resendType, domainStatus) => {
      constructEventMock.mockReturnValue(
        buildVerifiedEvent(domainStatus as 'sent' | 'delivered' | 'bounced' | 'complained'),
      );
      const route = await importRoute();
      const res = await route.POST(
        makeRequest({ body: `{"type":"${resendType}"}` }),
      );

      expect(res.status).toBe(200);
      expect(processWebhookEventMock).toHaveBeenCalledTimes(1);
      const call = processWebhookEventMock.mock.calls[0]!;
      expect(call[1].broadcastId).toBe(VALID_BROADCAST_ID);
      expect(call[1].event.data.status).toBe(domainStatus);
      expect((await res.json()).received).toBe(true);
    },
  );

  it('missing svix headers → 401 + audit reject row inserted', async () => {
    const route = await importRoute();
    const res = await route.POST(
      makeRequest({ body: '{}', withSig: false }),
    );

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('missing_header');
    expect(processWebhookEventMock).not.toHaveBeenCalled();
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
  });

  it('invalid signature → 401 bad_signature + audit reject', async () => {
    constructEventMock.mockImplementation(() => {
      throw new WebhookSignatureErrorStub('bad_signature', 'no v1 sig matched');
    });
    const route = await importRoute();
    const res = await route.POST(makeRequest({ body: '{}' }));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('bad_signature');
    expect(processWebhookEventMock).not.toHaveBeenCalled();
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
  });

  it('content-length > 64 KiB → 413 body_too_large (DoS pre-guard, review ERR-C2)', async () => {
    const route = await importRoute();
    const res = await route.POST(
      makeRequest({
        body: '{}',
        contentLength: String(65 * 1024),
      }),
    );

    // Review ERR-C2: distinct response code from bad_signature so ops
    // can distinguish DoS attempts from secret-rotation gaps.
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('body_too_large');
    expect(constructEventMock).not.toHaveBeenCalled();
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  it('kill-switch off → 410 feature_disabled + audit (review ERR-M3)', async () => {
    envMock.features.f7Broadcasts = false;
    const route = await importRoute();
    const res = await route.POST(makeRequest({ body: '{}' }));

    // Review ERR-M3: 410 Gone (NOT 503) so Svix backoff treats the
    // rejection as terminal; audit row makes the kill-switch flip
    // observable to ops.
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe('feature_disabled');
    expect(constructEventMock).not.toHaveBeenCalled();
    expect(processWebhookEventMock).not.toHaveBeenCalled();
    // Audit row written with reason=feature_disabled.
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
  });

  it('unknown resend_broadcast_id → 200 OK + NULL-tenant audit (review ERR-C1)', async () => {
    constructEventMock.mockReturnValue(buildVerifiedEvent('delivered'));
    resolveTenantByResendBroadcastIdMock.mockResolvedValue(null);
    const route = await importRoute();
    const res = await route.POST(makeRequest({ body: '{}' }));

    expect(res.status).toBe(200);
    expect(processWebhookEventMock).not.toHaveBeenCalled();
    // Review ERR-C1: an audit row MUST be emitted so the misrouted /
    // post-archive event is forensically discoverable per FR-024.
    // Tenant is unknown at this stage so the row carries NULL tenant +
    // reason=unknown_resend_broadcast_id.
    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
  });

  it('use-case error → 500 dispatch_failed (Resend retries)', async () => {
    constructEventMock.mockReturnValue(buildVerifiedEvent('delivered'));
    processWebhookEventMock.mockResolvedValue(
      err({ kind: 'process_webhook.server_error', message: 'db down' }),
    );
    const route = await importRoute();
    const res = await route.POST(makeRequest({ body: '{}' }));

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('dispatch_failed');
  });

  it('response carries X-Correlation-Id + Cache-Control: no-store', async () => {
    constructEventMock.mockReturnValue(buildVerifiedEvent('delivered'));
    const route = await importRoute();
    const res = await route.POST(makeRequest({ body: '{}' }));

    expect(res.headers.get('X-Correlation-Id')).toBeTruthy();
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });
});
