/**
 * Phase 3F.11.5 (Round 2 Finding 8a closure) — Contract test for the
 * POST /api/admin/broadcasts/[id]/retry route handler. Locks the wire
 * contract: auth gating, kill-switch behavior, broadcast id parsing,
 * and error-kind → HTTP-status mapping.
 *
 * Per-broadcast retry behaviour is covered by retry-failed-batches
 * use-case contract test. This file only locks the route shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const retryFailedBatchesMock = vi.fn();
const isF71aUs1EnabledMock = vi.fn();
const f71aUs1DisabledReasonMock = vi.fn();
const parseBroadcastIdMock = vi.fn();

const adminCtx = {
  current: {
    user: { id: 'admin-1' },
  },
  sourceIp: '127.0.0.1',
  requestId: 'req-test-1',
};

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) =>
    requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/broadcasts', () => ({
  retryFailedBatches: (...args: unknown[]) => retryFailedBatchesMock(...args),
  makeRetryFailedBatchesDeps: () => ({}),
  parseBroadcastId: (raw: string) => parseBroadcastIdMock(raw),
  isF71aUs1Enabled: () => isF71aUs1EnabledMock(),
  f71aUs1DisabledReason: () => f71aUs1DisabledReasonMock(),
}));

function makeRequest(): NextRequest {
  return new NextRequest(
    'http://localhost/api/admin/broadcasts/22222222-2222-2222-2222-222222222222/retry',
    { method: 'POST' },
  );
}

function makeContext(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: '22222222-2222-2222-2222-222222222222' }) };
}

beforeEach(() => {
  requireAdminContextMock.mockResolvedValue(adminCtx);
  retryFailedBatchesMock.mockReset();
  isF71aUs1EnabledMock.mockReturnValue(true);
  f71aUs1DisabledReasonMock.mockReturnValue(null);
  parseBroadcastIdMock.mockImplementation((raw: string) =>
    ok(raw as unknown as never),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('admin retry route — wire contract (Phase 3F.11.5 / Finding 8a)', () => {
  it('admin auth rejection → returns the auth rejection response (401/403)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/retry/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(401);
    // Use case not invoked when auth fails
    expect(retryFailedBatchesMock).not.toHaveBeenCalled();
  });

  it('kill-switch off → 503 feature_disabled', async () => {
    isF71aUs1EnabledMock.mockReturnValueOnce(false);
    f71aUs1DisabledReasonMock.mockReturnValueOnce('f71a_us1');
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/retry/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('feature_disabled');
    expect(retryFailedBatchesMock).not.toHaveBeenCalled();
  });

  it('invalid broadcastId in URL → 404 broadcast_not_found (no use case call)', async () => {
    parseBroadcastIdMock.mockImplementationOnce(() =>
      err({ kind: 'invalid_format' as const }),
    );
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/retry/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('broadcast_not_found');
    expect(retryFailedBatchesMock).not.toHaveBeenCalled();
  });

  it('happy path → 200 with retryAttempt + retriedBatchCount in body', async () => {
    retryFailedBatchesMock.mockResolvedValueOnce(
      ok({ retryAttempt: 1, retriedBatchCount: 2 }),
    );
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/retry/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      retryAttempt?: number;
      retriedBatchCount?: number;
    };
    expect(body.retryAttempt).toBe(1);
    expect(body.retriedBatchCount).toBe(2);
  });

  it('error-kind mapping: BROADCAST_NOT_FOUND → 404 broadcast_not_found', async () => {
    retryFailedBatchesMock.mockResolvedValueOnce(
      err({ kind: 'BROADCAST_NOT_FOUND', broadcastId: 'b-1' }),
    );
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/retry/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('broadcast_not_found');
  });

  it('error-kind mapping: MANUAL_RETRY_BUDGET_EXHAUSTED → 409 + budget detail', async () => {
    retryFailedBatchesMock.mockResolvedValueOnce(
      err({ kind: 'MANUAL_RETRY_BUDGET_EXHAUSTED', budget: 3 }),
    );
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/retry/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error?: { code?: string; details?: { budget?: number } };
    };
    expect(body.error?.code).toBe('broadcast_manual_retry_budget_exhausted');
    expect(body.error?.details?.budget).toBe(3);
  });

  it('error-kind mapping: ALREADY_RETRYING_IN_PROGRESS → 409', async () => {
    retryFailedBatchesMock.mockResolvedValueOnce(
      err({
        kind: 'ALREADY_RETRYING_IN_PROGRESS',
        broadcastId: 'b-1',
        lockKey: 'broadcasts-retry:test:b-1',
      }),
    );
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/retry/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('broadcast_already_retrying_in_progress');
  });

  it('use case throws → 500 internal_error (outer try/catch)', async () => {
    retryFailedBatchesMock.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/retry/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('internal_error');
  });
});
