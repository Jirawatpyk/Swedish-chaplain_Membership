/**
 * Contract — GET /api/portal/credit-notes/[creditNoteId]/pdf, failure arms.
 *
 * The portal credit-note PDF route was the one F4 PDF proxy without a
 * try/catch around its use case, so a throw (a Blob outage, an audit-emit
 * failure) escaped the handler instead of answering the structured
 * 500 `internal_error` every sibling answers. A missing blob (`blob_missing`,
 * 502) also has to carry the stored `blobKey` on the warn log — the field the
 * operator runbook (`docs/runbooks/receipt-pdf-permanently-failed.md`
 * § Missing PDF blob) tells on-call to read.
 *
 * The use case is mocked (its Result branches are unit-tested in
 * get-credit-note-pdf-signed-url.test.ts); this pins the route's own code.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const getCreditNotePdfSignedUrlMock = vi.fn();
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/logger', () => ({ logger: loggerMock }));
vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    getCreditNotePdfSignedUrl: (...args: unknown[]) => getCreditNotePdfSignedUrlMock(...args),
    makeGetCreditNotePdfSignedUrlDeps: () => ({}),
  };
});

const CN_ID = '660e8400-e29b-41d4-a716-446655440077';
const BLOB_KEY = 'invoicing/test-swecham/credit-notes/cn-1/abc.pdf';

const memberContext = {
  current: {
    user: { id: 'member-user-1', email: 'member@swecham.test', role: 'member' as const },
    session: { id: 'sess-member-1' },
  },
  tenant: { slug: 'test-swecham' },
  memberId: 'member-1',
  sourceIp: '203.0.113.5',
  requestId: 'req-portal-cn-1',
};

type RouteGet = (
  req: NextRequest,
  ctx: { params: Promise<{ creditNoteId: string }> },
) => Promise<Response>;

async function importRoute() {
  return (await import('@/app/api/portal/credit-notes/[creditNoteId]/pdf/route')) as {
    GET: RouteGet;
  };
}

function call() {
  return importRoute().then(({ GET }) =>
    GET(
      new NextRequest(`http://localhost:3100/api/portal/credit-notes/${CN_ID}/pdf`, {
        method: 'GET',
      }),
      { params: Promise.resolve({ creditNoteId: CN_ID }) },
    ),
  );
}

describe('contract: GET /api/portal/credit-notes/[id]/pdf — failure arms', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('use case THROWS → 500 internal_error with a structured error log (never an escaped throw)', async () => {
    requireMemberContextMock.mockResolvedValue(memberContext);
    getCreditNotePdfSignedUrlMock.mockRejectedValueOnce(new Error('Neon transient'));

    const res = await call();

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body).toEqual({ error: { code: 'internal_error' } });
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-portal-cn-1',
        tenantId: 'test-swecham',
        creditNoteId: CN_ID,
      }),
      expect.stringContaining('getCreditNotePdfSignedUrl threw'),
    );
  });

  it('blob_missing → 502 and the warn log carries the stored blobKey for triage', async () => {
    requireMemberContextMock.mockResolvedValue(memberContext);
    getCreditNotePdfSignedUrlMock.mockResolvedValueOnce(
      err({ code: 'blob_missing', key: BLOB_KEY }),
    );

    const res = await call();

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body).toEqual({ error: { code: 'blob_missing' } });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'blob_missing', blobKey: BLOB_KEY }),
      'GET /api/portal/credit-notes/[id]/pdf failed',
    );
  });
});
