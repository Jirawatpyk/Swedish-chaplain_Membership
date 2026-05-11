/**
 * F8 Phase 4 Wave I6+I7 / T107 spec — admin send-reminder-now route.
 *
 * Test scope:
 *   - Kill-switch (503), no-session (401), manager 403, rate-limit 429
 *   - Happy paths: sent, skipped(non-already_sent), task_created,
 *     failed_transient, failed_permanent
 *   - Edge cases: idempotency 409, cycle_not_found 404, server_error 500
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const TENANT_SLUG = 'tenanta';
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000a01';

vi.mock('@/lib/env', () => ({
  env: {
    features: { f8Renewals: true },
    tenant: { slug: 'tenanta' },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: vi.fn(() => ({ slug: TENANT_SLUG })),
}));

const requireAdminMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/renewals-route-helpers', async () => {
  // Use the real `errorResponse` / `successResponse` envelope so we can
  // assert HTTP status + body shape end-to-end. `requireRenewalAdminContext`
  // is overridden so we can script auth outcomes without booting the
  // session/RBAC stack.
  const { NextResponse } = await import('next/server');
  return {
    requireRenewalAdminContext: requireAdminMock,
    errorResponse: ({
      status,
      code,
      correlationId,
      details,
      headers,
    }: {
      status: number;
      code: string;
      correlationId: string;
      details?: Record<string, unknown>;
      headers?: Record<string, string>;
    }) =>
      NextResponse.json(
        { error: { code, ...(details ?? {}) }, correlationId },
        {
          status,
          headers: {
            'X-Correlation-Id': correlationId,
            'Cache-Control': 'no-store, private',
            ...(headers ?? {}),
          },
        },
      ),
    successResponse: <T>(body: T, correlationId: string, status = 200) =>
      NextResponse.json(body, {
        status,
        headers: {
          'X-Correlation-Id': correlationId,
          'Cache-Control': 'no-store, private',
        },
      }),
  };
});

const rateLimiterCheckMock = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, reset: 0 })),
);
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: rateLimiterCheckMock },
}));

vi.mock('@/lib/rate-limit-helpers', () => ({
  retryAfterSecondsFromRl: vi.fn(() => 42),
}));

const sendReminderNowMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/renewals', () => ({
  sendReminderNow: sendReminderNowMock,
  makeRenewalsDeps: vi.fn(() => ({ tenant: { slug: TENANT_SLUG } })),
}));

import { POST } from '@/app/api/admin/renewals/[cycleId]/send-reminder-now/route';

function makeRequest(): NextRequest {
  return {
    headers: { get: () => null },
    url: 'http://localhost:3100/api/admin/renewals/cycle-1/send-reminder-now',
  } as unknown as NextRequest;
}

const validParams = { params: Promise.resolve({ cycleId: 'cycle-1' }) };

function adminCtx() {
  return {
    current: { user: { id: ADMIN_USER_ID, role: 'admin' as const } },
    sourceIp: '127.0.0.1',
    requestId: 'req-1',
    correlationId: 'corr-1',
  };
}

describe('admin send-reminder-now route (T107)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockResolvedValue(adminCtx());
    rateLimiterCheckMock.mockResolvedValue({ success: true, reset: 0 });
  });

  it('503 feature_disabled when kill-switch off', async () => {
    const env = (await import('@/lib/env')).env as {
      features: { f8Renewals: boolean };
    };
    env.features.f8Renewals = false;
    try {
      const res = await POST(makeRequest(), validParams);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe('feature_disabled');
      expect(requireAdminMock).not.toHaveBeenCalled();
    } finally {
      env.features.f8Renewals = true;
    }
  });

  it('401 forwards rejection from requireRenewalAdminContext (no session)', async () => {
    const { errorResponse } = await import('@/lib/renewals-route-helpers');
    requireAdminMock.mockResolvedValueOnce({
      response: errorResponse({
        status: 401,
        code: 'no_session',
        correlationId: 'corr-x',
      }),
    });
    const res = await POST(makeRequest(), validParams);
    expect(res.status).toBe(401);
    expect(sendReminderNowMock).not.toHaveBeenCalled();
  });

  it('403 forwards rejection from requireRenewalAdminContext (manager)', async () => {
    const { errorResponse } = await import('@/lib/renewals-route-helpers');
    requireAdminMock.mockResolvedValueOnce({
      response: errorResponse({
        status: 403,
        code: 'forbidden',
        correlationId: 'corr-x',
      }),
    });
    const res = await POST(makeRequest(), validParams);
    expect(res.status).toBe(403);
    expect(sendReminderNowMock).not.toHaveBeenCalled();
  });

  it('429 rate_limited with Retry-After header when limiter exhausted', async () => {
    rateLimiterCheckMock.mockResolvedValueOnce({ success: false, reset: 999 });
    const res = await POST(makeRequest(), validParams);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
    expect(sendReminderNowMock).not.toHaveBeenCalled();
  });

  it('keys the rate-limit by tenant + admin user id', async () => {
    await POST(makeRequest(), validParams);
    expect(rateLimiterCheckMock).toHaveBeenCalledWith(
      `f8:send-reminder-now:${TENANT_SLUG}:${ADMIN_USER_ID}`,
      30,
      300,
    );
  });

  it('200 happy path returns outcome on sent', async () => {
    sendReminderNowMock.mockResolvedValueOnce(
      ok({
        kind: 'sent',
        reminderEventId: 'rev-1',
        deliveryId: 'del-1',
        dispatchedAt: '2026-05-04T08:00:00.000Z',
      }),
    );
    const res = await POST(makeRequest(), validParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome.kind).toBe('sent');
    expect(body.outcome.deliveryId).toBe('del-1');
  });

  it('200 forwards skipped(member_archived) outcome verbatim', async () => {
    sendReminderNowMock.mockResolvedValueOnce(
      ok({ kind: 'skipped', reason: 'member_archived' }),
    );
    const res = await POST(makeRequest(), validParams);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome.kind).toBe('skipped');
    expect(body.outcome.reason).toBe('member_archived');
  });

  it('409 already_sent forwards existing_* metadata as error.details', async () => {
    sendReminderNowMock.mockResolvedValueOnce(
      ok({
        kind: 'skipped',
        reason: 'already_sent',
        metadata: {
          existing_reminder_event_id: 'rev-prior',
          existing_dispatched_at: '2026-05-04T07:55:00.000Z',
        },
      }),
    );
    const res = await POST(makeRequest(), validParams);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('already_sent');
    expect(body.error.existing_reminder_event_id).toBe('rev-prior');
    expect(body.error.existing_dispatched_at).toBe('2026-05-04T07:55:00.000Z');
  });

  it('200 forwards failed_transient + failed_permanent outcomes', async () => {
    sendReminderNowMock.mockResolvedValueOnce(
      ok({
        kind: 'failed_transient',
        reminderEventId: 'rev-1',
        reason: 'rate_limit',
      }),
    );
    const res1 = await POST(makeRequest(), validParams);
    expect(res1.status).toBe(200);
    expect((await res1.json()).outcome.kind).toBe('failed_transient');

    sendReminderNowMock.mockResolvedValueOnce(
      ok({
        kind: 'failed_permanent',
        reminderEventId: 'rev-2',
        reason: 'invalid_recipient',
      }),
    );
    const res2 = await POST(makeRequest(), validParams);
    expect(res2.status).toBe(200);
    expect((await res2.json()).outcome.kind).toBe('failed_permanent');
  });

  it('404 cycle_not_found', async () => {
    sendReminderNowMock.mockResolvedValueOnce(err({ kind: 'cycle_not_found' }));
    const res = await POST(makeRequest(), validParams);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('cycle_not_found');
  });

  it('400 invalid_input', async () => {
    sendReminderNowMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', message: 'invalid cycle id' }),
    );
    const res = await POST(makeRequest(), validParams);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toBe('invalid cycle id');
  });

  it('500 server_error on unexpected throw', async () => {
    sendReminderNowMock.mockRejectedValueOnce(new Error('db: connection lost'));
    const res = await POST(makeRequest(), validParams);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });
});
