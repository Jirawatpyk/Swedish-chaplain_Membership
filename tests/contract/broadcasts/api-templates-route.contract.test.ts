/**
 * R6.3 H-4 — Contract test for the GET /api/broadcasts/templates route
 * handler. Locks the bilingual envelope shape for two error paths that
 * R5 Final 2 senior-tester flagged as having zero coverage:
 *
 *   - 401 `no_session` (unauthenticated)  — R3.6 L-1 typed-code path
 *   - 400 `invalid_locale`                 — R4.2 H-1 typed-code path
 *
 * The R4.2 H-1/H-2 refactor swapped `jsonError(...)` for
 * `errorResponse(...)` so the canonical `{error: {code, message,
 * messageThai}, correlationId}` envelope reaches the client. This test
 * locks the envelope shape against future drift (e.g., reverting to
 * jsonError would silently strip messageThai).
 *
 * Also asserts the standard F7 response headers:
 *   - `Cache-Control: no-store, private`
 *   - `X-Correlation-Id: <uuid>`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getCurrentSessionMock = vi.fn();
const isF71aUs7EnabledMock = vi.fn();
const f71aUs7DisabledReasonMock = vi.fn();
const listBroadcastTemplatesMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: () => getCurrentSessionMock(),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: () => Promise<T>) => fn(),
}));
vi.mock('@/modules/broadcasts', () => ({
  isF71aUs7Enabled: () => isF71aUs7EnabledMock(),
  f71aUs7DisabledReason: () => f71aUs7DisabledReasonMock(),
  listBroadcastTemplates: (...args: unknown[]) =>
    listBroadcastTemplatesMock(...args),
  makeListBroadcastTemplatesDeps: () => ({}),
}));

function makeRequest(url = 'http://localhost/api/broadcasts/templates'): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

beforeEach(() => {
  isF71aUs7EnabledMock.mockReturnValue(true);
  f71aUs7DisabledReasonMock.mockReturnValue(null);
  getCurrentSessionMock.mockReset();
  listBroadcastTemplatesMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/broadcasts/templates — R6.3 H-4 bilingual envelope contract', () => {
  it('unauthenticated → 401 with bilingual no_session envelope + standard headers', async () => {
    getCurrentSessionMock.mockResolvedValue(null);
    const { GET } = await import('@/app/api/broadcasts/templates/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);

    // R4.2 H-2 — `errorResponse` envelope: {error: {code, message,
    // messageThai}, correlationId}. Pre-R4.2 `jsonError` emitted only
    // `{error: 'no_session'}` which lost the messageThai key.
    const body = (await res.json()) as {
      error: { code: string; message: string; messageThai: string };
      correlationId: string;
    };
    expect(body.error.code).toBe('no_session');
    expect(body.error.message).toBe(
      'You must be signed in to access this resource.',
    );
    expect(body.error.messageThai).toBe(
      'คุณต้องเข้าสู่ระบบเพื่อเข้าถึงทรัพยากรนี้',
    );
    expect(body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Standard F7 headers
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(res.headers.get('X-Correlation-Id')).toBe(body.correlationId);
  });

  it('?locale=invalid → 400 with bilingual invalid_locale envelope', async () => {
    getCurrentSessionMock.mockResolvedValue({
      user: { id: 'usr-1' },
    });
    const { GET } = await import('@/app/api/broadcasts/templates/route');
    const res = await GET(
      makeRequest('http://localhost/api/broadcasts/templates?locale=invalid'),
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as {
      error: { code: string; message: string; messageThai: string };
      correlationId: string;
    };
    expect(body.error.code).toBe('invalid_locale');
    expect(body.error.message).toBe(
      'The locale parameter is invalid (must be one of: en, th, sv).',
    );
    expect(body.error.messageThai).toBe(
      'พารามิเตอร์ภาษาไม่ถูกต้อง (ต้องเป็น en, th, หรือ sv)',
    );

    // Use-case MUST NOT be invoked when the locale is invalid.
    expect(listBroadcastTemplatesMock).not.toHaveBeenCalled();
  });

  it('valid request → 200 with templates list + correlation headers (regression baseline)', async () => {
    getCurrentSessionMock.mockResolvedValue({
      user: { id: 'usr-1' },
    });
    listBroadcastTemplatesMock.mockResolvedValue([
      {
        id: 'tpl-1',
        name: 'Test Template',
        subject: 'Subject',
        locale: 'en' as const,
        startedFromCount: 0,
        isSeeded: false,
        updatedAt: new Date('2026-05-01T00:00:00Z'),
      },
    ]);
    const { GET } = await import('@/app/api/broadcasts/templates/route');
    const res = await GET(
      makeRequest('http://localhost/api/broadcasts/templates?locale=en'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      templates: ReadonlyArray<{ id: string; name: string }>;
    };
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0]?.id).toBe('tpl-1');
    expect(res.headers.get('X-Correlation-Id')).toMatch(
      /^[0-9a-f]{8}-/i,
    );
  });
});
