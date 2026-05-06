/**
 * T162 — POST /api/webhooks/resend contract test.
 *
 * Cases (contracts/auth-api.md § 12):
 *   - 200 on valid Svix signature + known event type
 *   - 401 on missing / malformed / wrong signature
 *   - 400 on invalid JSON body
 *   - 200 + no insert on unknown event type (forward-compat)
 *   - 200 on duplicate svix-id (DB-level ON CONFLICT DO NOTHING)
 *
 * Builds real Svix signatures using the same HMAC-SHA256 algorithm
 * as the route handler so the positive path actually exercises the
 * verification logic instead of mocking it away.
 *
 * The DB insert is mocked to avoid touching Postgres — this file is
 * a CONTRACT test (wire format only). Actual write verification is
 * the job of a future integration test (post-F1 follow-up).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

// vi.hoisted so the value is available inside the hoisted vi.mock factory
const { TEST_SECRET_RAW } = vi.hoisted(() => ({
  TEST_SECRET_RAW: Buffer.from('deterministic-webhook-secret-12345').toString(
    'base64',
  ),
}));

// Mock the env module so we get a deterministic signing secret
vi.mock('@/lib/env', () => ({
  env: {
    nodeEnv: 'test',
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    database: { url: 'postgres://stub', unpooledUrl: 'postgres://stub' },
    upstash: { url: 'https://stub', token: 'stub' },
    resend: {
      apiKey: 're_stub',
      webhookSigningSecret: `whsec_${TEST_SECRET_RAW}`,
    },
    auth: { cookieSigningSecret: 'a'.repeat(48) },
    app: { baseUrl: 'http://localhost:3100', allowedOrigins: ['http://localhost:3100'] },
    flags: { readOnlyMode: false },
    bootstrap: { adminEmail: undefined },
    log: { level: 'silent' },
    // J5-H4 — toggled per-test via direct mutation to exercise the
    // F8 bounce-hook path. Defaults to false so existing tests don't
    // accidentally enter the F8 callback.
    features: { f8Renewals: false },
  },
}));

// J5-H4: mock the F8 surface so we can pin the silent-failure
// contract — F8 throws MUST NOT propagate to the webhook response
// (otherwise Resend retry-storms with 24h exponential backoff).
//
// The lookup mock's TS inference would otherwise narrow to
// `Promise<null>` and reject `mockResolvedValueOnce({...})` overrides
// at compile time — the explicit return-type widens it to
// `Promise<MemberLookupResult | null>` to match the production import.
type MemberLookupResultStub = {
  tenantId: string;
  memberId: string;
  contactId: string;
  isPrimary: boolean;
};
const lookupMemberByEmailMock = vi.hoisted(() =>
  vi.fn<(email: string) => Promise<MemberLookupResultStub | null>>(
    async () => null,
  ),
);
const detectBounceThresholdMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, value: { kind: 'no_threshold_crossed' as const, counts: { hardBounces: 0, softBouncesInCycle: 0, softBouncesIn30Days: 0 } } })),
);
vi.mock('@/modules/renewals', () => ({
  lookupMemberByEmail: lookupMemberByEmailMock,
  detectBounceThreshold: detectBounceThresholdMock,
  makeRenewalsDeps: vi.fn(() => ({ tenant: { slug: 'test-tenant' } })),
}));

// Import the route AFTER vi.mock is set up (vitest hoists mocks so this
// is actually safe as a regular import, but keeping it below the mock
// block documents intent).
import { POST } from '@/app/api/webhooks/resend/route';

// Mock the DB insert — we're testing the handler, not Drizzle
const insertValuesMock = vi.fn().mockReturnValue({
  onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
});
vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: (...args: unknown[]) => insertValuesMock(...args),
    })),
  },
}));

function sign(svixId: string, svixTimestamp: string, body: string): string {
  const signedPayload = `${svixId}.${svixTimestamp}.${body}`;
  const hmac = createHmac(
    'sha256',
    Buffer.from(TEST_SECRET_RAW, 'base64'),
  )
    .update(signedPayload, 'utf8')
    .digest('base64');
  return `v1,${hmac}`;
}

function makeRequest(
  body: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/resend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body,
  });
}

describe('POST /api/webhooks/resend', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 on valid signature + known event type (delivered)', async () => {
    const body = JSON.stringify({
      type: 'email.delivered',
      data: {
        email_id: 're_msg_01934f123',
        to: ['jane@example.com'],
        subject: 'Reset your SweCham password',
      },
    });
    const svixId = 'msg_test_123';
    const svixTimestamp = '1712664195';
    const response = await POST(
      makeRequest(body, {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': sign(svixId, svixTimestamp, body),
      }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(insertValuesMock).toHaveBeenCalledOnce();
  });

  it('200 on bounced + insert still fires (operational warning path)', async () => {
    const body = JSON.stringify({
      type: 'email.bounced',
      data: {
        email_id: 're_msg_bounce_1',
        to: ['broken@nowhere.example'],
      },
    });
    const svixId = 'msg_bounce';
    const svixTimestamp = '1712664196';
    const response = await POST(
      makeRequest(body, {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': sign(svixId, svixTimestamp, body),
      }),
    );
    expect(response.status).toBe(200);
    expect(insertValuesMock).toHaveBeenCalledOnce();
  });

  it('401 when svix-signature header is missing', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: {} });
    const response = await POST(
      makeRequest(body, {
        'svix-id': 'msg_x',
        'svix-timestamp': '1712664196',
      }),
    );
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe('invalid-webhook-signature');
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('401 on wrong signature', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: {} });
    const response = await POST(
      makeRequest(body, {
        'svix-id': 'msg_x',
        'svix-timestamp': '1712664196',
        'svix-signature': 'v1,' + Buffer.from('wrong').toString('base64'),
      }),
    );
    expect(response.status).toBe(401);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('401 when svix-id / svix-timestamp are missing (not signable)', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: {} });
    // Timestamp missing → verify function bails with false
    const svixId = 'msg_x';
    const response = await POST(
      makeRequest(body, {
        'svix-id': svixId,
        'svix-signature': sign(svixId, '0', body),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('400 on malformed JSON body (signature still checked first)', async () => {
    const body = 'not json at all';
    const svixId = 'msg_bad';
    const svixTimestamp = '1712664197';
    const response = await POST(
      makeRequest(body, {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': sign(svixId, svixTimestamp, body),
      }),
    );
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe('invalid-input');
  });

  it('200 on unknown event type (forward-compat no-op)', async () => {
    const body = JSON.stringify({
      type: 'email.brand_new_event_2099',
      data: { email_id: 'x', to: ['a@b.c'] },
    });
    const svixId = 'msg_fwd';
    const svixTimestamp = '1712664198';
    const response = await POST(
      makeRequest(body, {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': sign(svixId, svixTimestamp, body),
      }),
    );
    expect(response.status).toBe(200);
    // No insert for unknown event types
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('J5-H11: 200 on schema-rejected body (Resend payload field renamed) — does NOT 400-storm Resend retries', async () => {
    // Valid JSON but missing the required `type` field → zod schema
    // rejection. Previously this would 400 → Resend retries with 24h
    // exponential backoff. Now: 200 + `schema_drift: true` flag +
    // logger.error + metric so the alert pipeline triggers without
    // breaking delivery.
    const body = JSON.stringify({
      no_type_field: 'present',
      data: { email_id: 're_x', to: ['a@b.c'] },
    });
    const svixId = 'msg_schema_drift';
    const svixTimestamp = '1712664299';
    const response = await POST(
      makeRequest(body, {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': sign(svixId, svixTimestamp, body),
      }),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.schema_drift).toBe(true);
    // No DB insert — schema rejection skips the persist path entirely.
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('J5-H4: 200 even when F8 detectBounceThreshold throws (no Resend retry storm on F8 internal error)', async () => {
    // Toggle the F8 feature flag ON for this test only, then mock
    // the F8 surface to simulate a downstream throw.
    const env = (await import('@/lib/env')).env as {
      features: { f8Renewals: boolean };
    };
    env.features.f8Renewals = true;
    lookupMemberByEmailMock.mockResolvedValueOnce({
      tenantId: 'test-tenant',
      memberId: '00000000-0000-0000-0000-000000000aaa',
      contactId: 'c1',
      isPrimary: true,
    });
    detectBounceThresholdMock.mockRejectedValueOnce(
      new Error('F8 use-case panic: cyclesRepo connection lost'),
    );
    try {
      const body = JSON.stringify({
        type: 'email.bounced',
        data: {
          email_id: 're_bounce_h4',
          to: ['member@example.com'],
          bounce: { type: 'permanent' },
        },
      });
      const svixId = 'msg_h4';
      const svixTimestamp = '1712664399';
      const response = await POST(
        makeRequest(body, {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': sign(svixId, svixTimestamp, body),
        }),
      );
      // Critical invariant: 200 even though F8 hook threw —
      // returning 5xx would cause Resend to retry with 24h
      // exponential backoff (silent-failure-hunter F8 finding #5).
      expect(response.status).toBe(200);
      // F8 hook was attempted (lookup + detect both invoked).
      expect(lookupMemberByEmailMock).toHaveBeenCalledTimes(1);
      expect(detectBounceThresholdMock).toHaveBeenCalledTimes(1);
      // F1 webhook still wrote the email_delivery_events row.
      expect(insertValuesMock).toHaveBeenCalledOnce();
    } finally {
      env.features.f8Renewals = false;
    }
  });
});
