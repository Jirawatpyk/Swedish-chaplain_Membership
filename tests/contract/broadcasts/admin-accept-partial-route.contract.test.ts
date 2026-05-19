/**
 * Phase 3F.11.5 (Round 2 Finding 8b closure) — Contract test for the
 * POST /api/admin/broadcasts/[id]/accept-partial route handler. Locks
 * the wire contract: auth gating, kill-switch, broadcast id parsing,
 * body schema validation (reason length), and error-kind → HTTP-status
 * mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const acceptPartialDeliveryMock = vi.fn();
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
  acceptPartialDelivery: (...args: unknown[]) =>
    acceptPartialDeliveryMock(...args),
  makeAcceptPartialDeliveryDeps: () => ({}),
  parseBroadcastId: (raw: string) => parseBroadcastIdMock(raw),
  MAX_REASON_LENGTH: 500,
  isF71aUs1Enabled: () => isF71aUs1EnabledMock(),
  f71aUs1DisabledReason: () => f71aUs1DisabledReasonMock(),
}));

function makeRequest(opts: { body?: string } = {}): NextRequest {
  return new NextRequest(
    'http://localhost/api/admin/broadcasts/22222222-2222-2222-2222-222222222222/accept-partial',
    {
      method: 'POST',
      body: opts.body ?? '',
      headers: { 'content-type': 'application/json' },
    },
  );
}

function makeContext(): { params: Promise<{ id: string }> } {
  return {
    params: Promise.resolve({
      id: '22222222-2222-2222-2222-222222222222',
    }),
  };
}

beforeEach(() => {
  requireAdminContextMock.mockResolvedValue(adminCtx);
  acceptPartialDeliveryMock.mockReset();
  isF71aUs1EnabledMock.mockReturnValue(true);
  f71aUs1DisabledReasonMock.mockReturnValue(null);
  parseBroadcastIdMock.mockImplementation((raw: string) =>
    ok(raw as unknown as never),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('admin accept-partial route — wire contract (Phase 3F.11.5 / Finding 8b)', () => {
  it('admin auth rejection → returns the auth response (401/403)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/accept-partial/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(403);
    expect(acceptPartialDeliveryMock).not.toHaveBeenCalled();
  });

  it('kill-switch off → 503 feature_disabled', async () => {
    isF71aUs1EnabledMock.mockReturnValueOnce(false);
    f71aUs1DisabledReasonMock.mockReturnValueOnce('us1');
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/accept-partial/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('feature_disabled');
    expect(acceptPartialDeliveryMock).not.toHaveBeenCalled();
  });

  it('invalid broadcastId → 404 broadcast_not_found', async () => {
    parseBroadcastIdMock.mockImplementationOnce(() =>
      err({ kind: 'invalid_format' as const }),
    );
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/accept-partial/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(404);
    expect(acceptPartialDeliveryMock).not.toHaveBeenCalled();
  });

  it('malformed JSON body → 400 invalid_body', async () => {
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/accept-partial/route'
    );
    const res = await POST(
      makeRequest({ body: '{not valid json' }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('invalid_body');
    expect(acceptPartialDeliveryMock).not.toHaveBeenCalled();
  });

  it('reason > 500 chars → 400 broadcast_partial_delivery_reason_too_long', async () => {
    const longReason = 'x'.repeat(501);
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/accept-partial/route'
    );
    const res = await POST(
      makeRequest({ body: JSON.stringify({ reason: longReason }) }),
      makeContext(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe(
      'broadcast_partial_delivery_reason_too_long',
    );
    expect(acceptPartialDeliveryMock).not.toHaveBeenCalled();
  });

  it('happy path empty body → 200 with acceptedAt ISO timestamp', async () => {
    const acceptedAt = new Date('2026-06-15T05:00:00Z');
    acceptPartialDeliveryMock.mockResolvedValueOnce(ok({ acceptedAt }));
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/accept-partial/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acceptedAt?: string };
    expect(body.acceptedAt).toBe(acceptedAt.toISOString());
  });

  it('error-kind mapping: INVALID_STATE_TRANSITION → 409 with currentStatus detail', async () => {
    acceptPartialDeliveryMock.mockResolvedValueOnce(
      err({
        kind: 'INVALID_STATE_TRANSITION',
        currentStatus: 'sent',
        expected: 'partially_sent',
      }),
    );
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/accept-partial/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error?: { code?: string; details?: { observedStatus?: string } };
    };
    expect(body.error?.code).toBe('broadcast_invalid_state_transition');
    expect(body.error?.details?.observedStatus).toBe('sent');
  });

  it('use case throws → 500 internal_error', async () => {
    acceptPartialDeliveryMock.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import(
      '@/app/api/admin/broadcasts/[id]/accept-partial/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('internal_error');
  });
});
