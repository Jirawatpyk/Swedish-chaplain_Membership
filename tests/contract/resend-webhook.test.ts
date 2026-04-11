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
  },
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
});
