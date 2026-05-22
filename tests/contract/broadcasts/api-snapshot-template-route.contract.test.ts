/**
 * R8.3 M-4 — Contract test for the POST
 * `/api/member/broadcasts/draft/[id]/snapshot-template` route handler.
 *
 * Closes R7 senior-tester MED-1: the existing use-case contract test
 * (snapshot-template-to-draft.test.ts) verifies the use-case returns
 * `{ok: false, error: {kind: 'template_soft_deleted'}}` but does NOT
 * exercise the route layer that maps that kind → HTTP 410.
 *
 * This test drives the route handler directly + asserts:
 *   - use-case `template_soft_deleted` → HTTP 410 (R3-F11 contract)
 *   - use-case `template_not_found` → HTTP 404
 *   - use-case `draft_not_found` → HTTP 404
 *   - use-case `draft_status_drift` → HTTP 409
 *   - feature-flag off → HTTP 503
 *
 * Mocks the use-case to control the Result; verifies route mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const snapshotTemplateToDraftMock = vi.fn();
const isF71aUs7EnabledMock = vi.fn();
const f71aUs7DisabledReasonMock = vi.fn();

const memberCtx = {
  current: { user: { id: 'usr-1' } },
  member: { memberId: 'mem-1' },
};

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
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
  snapshotTemplateToDraft: (...args: unknown[]) =>
    snapshotTemplateToDraftMock(...args),
  makeSnapshotTemplateToDraftDeps: () => ({}),
  isF71aUs7Enabled: () => isF71aUs7EnabledMock(),
  f71aUs7DisabledReason: () => f71aUs7DisabledReasonMock(),
}));

const DRAFT_ID = '44444444-4444-4444-4444-444444444444';
const TEMPLATE_ID = '55555555-5555-5555-5555-555555555555';

function makeRequest(body: object = { templateId: TEMPLATE_ID }): NextRequest {
  return new NextRequest(
    `http://localhost/api/member/broadcasts/draft/${DRAFT_ID}/snapshot-template`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

function makeContext(): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: DRAFT_ID }) };
}

beforeEach(() => {
  isF71aUs7EnabledMock.mockReturnValue(true);
  f71aUs7DisabledReasonMock.mockReturnValue(null);
  requireMemberContextMock.mockResolvedValue(memberCtx);
  snapshotTemplateToDraftMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/member/broadcasts/draft/[id]/snapshot-template — R8.3 M-4 HTTP-status contract', () => {
  it('use-case template_soft_deleted → HTTP 410 (R3-F11 + R6.4 M-1)', async () => {
    snapshotTemplateToDraftMock.mockResolvedValue(
      err({ kind: 'template_soft_deleted' }),
    );
    const { POST } = await import(
      '@/app/api/member/broadcasts/draft/[id]/snapshot-template/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('template_soft_deleted');
    expect(res.headers.get('X-Correlation-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('use-case template_not_found → HTTP 404', async () => {
    snapshotTemplateToDraftMock.mockResolvedValue(
      err({ kind: 'template_not_found' }),
    );
    const { POST } = await import(
      '@/app/api/member/broadcasts/draft/[id]/snapshot-template/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('template_not_found');
  });

  it('use-case draft_not_found → HTTP 404 (mapped to broadcast_not_found code)', async () => {
    snapshotTemplateToDraftMock.mockResolvedValue(err({ kind: 'draft_not_found' }));
    const { POST } = await import(
      '@/app/api/member/broadcasts/draft/[id]/snapshot-template/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('broadcast_not_found');
  });

  it('use-case draft_status_drift → HTTP 409 + currentStatus in body', async () => {
    snapshotTemplateToDraftMock.mockResolvedValue(
      err({
        kind: 'draft_status_drift',
        currentStatus: 'submitted' as const,
      }),
    );
    const { POST } = await import(
      '@/app/api/member/broadcasts/draft/[id]/snapshot-template/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      currentStatus: string;
    };
    expect(body.error).toBe('broadcast_immutable_after_submit');
    expect(body.currentStatus).toBe('submitted');
  });

  it('feature-flag OFF → HTTP 503 feature_disabled', async () => {
    isF71aUs7EnabledMock.mockReturnValue(false);
    f71aUs7DisabledReasonMock.mockReturnValue('FEATURE_F71A_BROADCAST_ADVANCED');
    const { POST } = await import(
      '@/app/api/member/broadcasts/draft/[id]/snapshot-template/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(503);
    expect(snapshotTemplateToDraftMock).not.toHaveBeenCalled();
  });

  it('happy path → HTTP 200 with draftId + subject + bodyHtml + templateNameSnapshot', async () => {
    snapshotTemplateToDraftMock.mockResolvedValue(
      ok({
        draftId: DRAFT_ID,
        subject: 'Welcome to SweCham',
        bodyHtml: '<p>Welcome!</p>',
        templateNameSnapshot: 'Welcome Template',
      }),
    );
    const { POST } = await import(
      '@/app/api/member/broadcasts/draft/[id]/snapshot-template/route'
    );
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draftId: string;
      subject: string;
      bodyHtml: string;
      templateNameSnapshot: string;
    };
    expect(body).toEqual({
      draftId: DRAFT_ID,
      subject: 'Welcome to SweCham',
      bodyHtml: '<p>Welcome!</p>',
      templateNameSnapshot: 'Welcome Template',
    });
  });
});
