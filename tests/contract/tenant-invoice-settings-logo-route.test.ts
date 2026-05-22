/**
 * F-09 (R13 follow-up) — Contract test: POST /api/tenant-invoice-settings/logo.
 *
 * Covers the route-level idempotency-replay wiring added in T092b:
 *   - first-time (classification=first) → proceeds to use-case
 *   - replay (classification=replay) → returns cached response verbatim
 *   - conflict (classification=conflict) → 409 idempotency_conflict
 *   - optional Idempotency-Key (omitted header) → proceeds without the
 *     classify/remember dance
 *   - error path persists under the key (F-01 fix) so replay returns
 *     the same 4xx instead of a 409 conflict
 *
 * Mocks `@/lib/admin-context`, `@/lib/tenant-context`, `@/lib/auth-deps`
 * (rate limiter), `@/lib/idempotency`, and `@/modules/invoicing` barrel
 * so the handler runs without hitting Redis, Vercel Blob, or Postgres.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const uploadTenantLogoMock = vi.fn();
const classifyIdempotencyRequestMock = vi.fn();
 
const reserveIdempotencyRecordMock = vi.fn(
  async (..._args: unknown[]) =>
    ({ ok: true, value: { kind: 'reserved' as const } }) as const,
);
 
const rememberIdempotentResponseMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-logo-1',
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async () => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));
vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug, __brand: true }),
}));
vi.mock('@/modules/invoicing', () => ({
  uploadTenantLogo: (...args: unknown[]) => uploadTenantLogoMock(...args),
  makeUploadTenantLogoDeps: () => ({ blob: {}, audit: {} }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false as const, reason: 'missing' as const };
    return { ok: true as const, key };
  },
  classifyIdempotencyRequest: (...args: unknown[]) =>
    classifyIdempotencyRequestMock(...args),
  reserveIdempotencyRecord: (...args: unknown[]) =>
    reserveIdempotencyRecordMock(...args),
  rememberIdempotentResponse: (...args: unknown[]) =>
    rememberIdempotentResponseMock(...args),
  // Stable hash — identical body across calls maps to the same digest so
  // replay/conflict classifications are driven by the mock, not a real
  // sha256. Tests assert classifier arguments directly where needed.
  hashRequestBody: (body: unknown) =>
    `hash:${JSON.stringify(body).length}:${String((body as { size?: number })?.size ?? 0)}`,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-logo-1',
};

/**
 * The route reads `file` as `File instanceof File`, then calls
 * `file.type`, `file.size`, `file.arrayBuffer()`. In the vitest-node
 * runtime the real `File` + multipart codec path hangs; construct a
 * minimal File-like that satisfies the `instanceof File` check via
 * prototype + carries the 3 properties/method the route uses.
 */
function makeFileStub(bytes: Uint8Array, contentType: string): File {
  const buffer = bytes.slice().buffer;
  const stub = {
    type: contentType,
    size: bytes.byteLength,
    name: 'logo.png',
    async arrayBuffer(): Promise<ArrayBuffer> {
      return buffer;
    },
  };
  Object.setPrototypeOf(stub, File.prototype);
  return stub as unknown as File;
}

function makeMultipartRequest(
  bytes: Uint8Array,
  contentType = 'image/png',
  headers: Record<string, string> = {},
): NextRequest {
  // FormData.append requires a real Blob/File in the vitest-node
  // runtime — stub the whole FormData-like shape the route reads
  // (`form.get('file')`) with a minimal object. The route only calls
  // `formData.get(...)`, so a Map proxy is enough.
  const file = makeFileStub(bytes, contentType);
  const formStub = {
    get: (name: string) => (name === 'file' ? file : null),
  } as unknown as FormData;
  const req = new NextRequest('http://localhost/api/tenant-invoice-settings/logo', {
    method: 'POST',
    headers,
  });
  Object.defineProperty(req, 'formData', {
    value: async () => formStub,
    configurable: true,
  });
  return req;
}

describe('contract: POST /api/tenant-invoice-settings/logo idempotency (F-09)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('first-time classification → proceeds to use-case and returns 201 with logo_blob_key', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    classifyIdempotencyRequestMock.mockResolvedValueOnce({ kind: 'first' });
    uploadTenantLogoMock.mockResolvedValueOnce(
      ok({ logoBlobKey: 'invoicing/test-swecham/logos/abc.png' }),
    );

    const { POST } = await import('@/app/api/tenant-invoice-settings/logo/route');
    const res = await POST(
      makeMultipartRequest(new Uint8Array([1, 2, 3]), 'image/png', {
        'idempotency-key': 'idem-logo-1',
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.logo_blob_key).toBe('invoicing/test-swecham/logos/abc.png');

    // Reservation happened before work; success path called remember.
    expect(reserveIdempotencyRecordMock).toHaveBeenCalledTimes(1);
    expect(rememberIdempotentResponseMock).toHaveBeenCalledTimes(1);
    const rememberArgs = rememberIdempotentResponseMock.mock.calls[0] as unknown[];
    expect(rememberArgs[3]).toMatchObject({
      status: 201,
      body: { logo_blob_key: 'invoicing/test-swecham/logos/abc.png' },
    });
  });

  it('replay classification → returns cached response without calling use-case', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    classifyIdempotencyRequestMock.mockResolvedValueOnce({
      kind: 'replay',
      previousResponse: {
        status: 201,
        body: { logo_blob_key: 'invoicing/test-swecham/logos/prev.png' },
      },
    });

    const { POST } = await import('@/app/api/tenant-invoice-settings/logo/route');
    const res = await POST(
      makeMultipartRequest(new Uint8Array([1, 2, 3]), 'image/png', {
        'idempotency-key': 'idem-logo-1',
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.logo_blob_key).toBe('invoicing/test-swecham/logos/prev.png');

    // Use-case not invoked; no new reservation/remember calls.
    expect(uploadTenantLogoMock).not.toHaveBeenCalled();
    expect(reserveIdempotencyRecordMock).not.toHaveBeenCalled();
    expect(rememberIdempotentResponseMock).not.toHaveBeenCalled();
  });

  it('conflict classification → 409 idempotency_conflict, use-case NOT called', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    classifyIdempotencyRequestMock.mockResolvedValueOnce({
      kind: 'conflict',
      storedBodyHash: 'hash:old',
      incomingBodyHash: 'hash:new',
    });

    const { POST } = await import('@/app/api/tenant-invoice-settings/logo/route');
    const res = await POST(
      makeMultipartRequest(new Uint8Array([9, 9, 9]), 'image/png', {
        'idempotency-key': 'idem-logo-1',
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('idempotency_conflict');
    expect(uploadTenantLogoMock).not.toHaveBeenCalled();
    expect(reserveIdempotencyRecordMock).not.toHaveBeenCalled();
    expect(rememberIdempotentResponseMock).not.toHaveBeenCalled();
  });

  it('optional Idempotency-Key omitted → proceeds without classify/remember', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    uploadTenantLogoMock.mockResolvedValueOnce(
      ok({ logoBlobKey: 'invoicing/test-swecham/logos/nokey.png' }),
    );

    const { POST } = await import('@/app/api/tenant-invoice-settings/logo/route');
    const res = await POST(makeMultipartRequest(new Uint8Array([1, 2, 3])));
    expect(res.status).toBe(201);
    expect(classifyIdempotencyRequestMock).not.toHaveBeenCalled();
    expect(reserveIdempotencyRecordMock).not.toHaveBeenCalled();
    expect(rememberIdempotentResponseMock).not.toHaveBeenCalled();
  });

  it('F-01 — validation error under idempotency key is cached so replay returns same 4xx', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    classifyIdempotencyRequestMock.mockResolvedValueOnce({ kind: 'first' });
    uploadTenantLogoMock.mockResolvedValueOnce(
      err({ code: 'too_large', size: 2_000_000, maxBytes: 1_048_576 }),
    );

    const { POST } = await import('@/app/api/tenant-invoice-settings/logo/route');
    const res = await POST(
      makeMultipartRequest(new Uint8Array(2_000_000), 'image/png', {
        'idempotency-key': 'idem-logo-err-1',
      }),
    );
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error?.code).toBe('too_large');

    // Route must store the 4xx response so a later replay of the same
    // key returns identical body/status instead of the shared infra's
    // null-response conflict branch.
    expect(rememberIdempotentResponseMock).toHaveBeenCalledTimes(1);
    const rememberArgs = rememberIdempotentResponseMock.mock.calls[0] as unknown[];
    expect(rememberArgs[3]).toMatchObject({
      status: 413,
      body: { error: { code: 'too_large' } },
    });
  });

  it('logo_history_cap_reached → 409 with error code (distinct from idempotency_conflict)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    classifyIdempotencyRequestMock.mockResolvedValueOnce({ kind: 'first' });
    uploadTenantLogoMock.mockResolvedValueOnce(
      err({ code: 'logo_history_cap_reached', current: 50, cap: 50 }),
    );

    const { POST } = await import('@/app/api/tenant-invoice-settings/logo/route');
    const res = await POST(
      makeMultipartRequest(new Uint8Array([1, 2, 3]), 'image/png', {
        'idempotency-key': 'idem-logo-cap-1',
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('logo_history_cap_reached');
    expect(body.error?.code).not.toBe('idempotency_conflict');
  });
});
