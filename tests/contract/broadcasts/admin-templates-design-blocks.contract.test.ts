/**
 * F119 security-round residual (T155 hand-off) — the TEMPLATE save path
 * refuses the design-block content rules too.
 *
 * Security review F1-2 wired `validateBlocks` into `submit`, both draft saves
 * and the test copy, and `broadcasts-route-helpers.ts:99` states the codes are
 * "refused 422 at every save, at send-to-member and on the test copy". The
 * template create / update use cases sanitised and ran the image-source
 * allowlist — and never called `validateBlocks`. `snapshotTemplateToDraft`
 * copies a template body STRAIGHT into a draft, so a template authored with
 * four CTA buttons or an undescribed banner was a stored bypass of FR-041: it
 * entered the compose flow already violating the rules the compose surface
 * refuses to save.
 *
 * One case per route, on the ONE shared mapping (`designBlockErrorResponse` —
 * first violation's code as the error code, the whole list in
 * `details.violations`), so six surfaces cannot drift a field at a time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const createBroadcastTemplateMock = vi.fn();
const updateBroadcastTemplateMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
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
  isF71aUs7Enabled: () => true,
  f71aUs7DisabledReason: () => null,
  createBroadcastTemplate: (...args: unknown[]) => createBroadcastTemplateMock(...args),
  updateBroadcastTemplate: (...args: unknown[]) => updateBroadcastTemplateMock(...args),
  makeCreateBroadcastTemplateDeps: () => ({}),
  makeUpdateBroadcastTemplateDeps: () => ({}),
  listBroadcastTemplates: vi.fn(),
  makeListBroadcastTemplatesDeps: () => ({}),
  deleteBroadcastTemplate: vi.fn(),
  makeDeleteBroadcastTemplateDeps: () => ({}),
  TEMPLATE_MAX_BODY_BYTES: 200_000,
  TEMPLATE_MAX_NAME_LENGTH: 100,
  TEMPLATE_MAX_SUBJECT_LENGTH: 200,
}));

const CTX = {
  current: {
    user: {
      id: 'user-admin',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin',
    },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.10',
  requestId: 'req-tpl-1',
};

/** Two violations, so `details.violations` carrying the WHOLE list is visible. */
const VIOLATIONS = [
  { code: 'too_many_cta' as const, max: 3 },
  { code: 'banner_alt_required' as const, index: 4, min: 1, max: 125 },
];

beforeEach(() => {
  requireApiPermissionMock.mockReset().mockResolvedValue(CTX);
  createBroadcastTemplateMock.mockReset();
  updateBroadcastTemplateMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Envelope = {
  error: { code: string; message: string; messageThai: string; details?: { violations?: unknown[] } };
  correlationId: string;
};

describe('POST /api/admin/broadcasts/templates — design-block content rules', () => {
  it('content_rules → 422 naming the FIRST violation, with the whole list in details', async () => {
    createBroadcastTemplateMock.mockResolvedValue(
      err({ kind: 'content_rules', violations: VIOLATIONS }),
    );
    const { POST } = await import('@/app/api/admin/broadcasts/templates/route');
    const res = await POST(
      new NextRequest('http://localhost/api/admin/broadcasts/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Four buttons',
          subject: 'Hello',
          bodyHtml: '<p>x</p>',
          locale: 'en',
        }),
      }),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe('too_many_cta');
    // The bilingual envelope, not the flat `{ error: 'code' }` — the same
    // mapping the five other surfaces answer with.
    expect(body.error.messageThai.length).toBeGreaterThan(0);
    expect(body.error.details?.violations).toEqual(VIOLATIONS);
  });
});

describe('PATCH /api/admin/broadcasts/templates/[id] — design-block content rules', () => {
  it('content_rules → 422 with the same envelope as create', async () => {
    updateBroadcastTemplateMock.mockResolvedValue(
      err({ kind: 'content_rules', violations: VIOLATIONS }),
    );
    const { PATCH } = await import('@/app/api/admin/broadcasts/templates/[id]/route');
    const res = await PATCH(
      new NextRequest('http://localhost/api/admin/broadcasts/templates/t-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bodyHtml: '<p>x</p>' }),
      }),
      { params: Promise.resolve({ id: '22222222-2222-2222-2222-222222222222' }) },
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as Envelope;
    expect(body.error.code).toBe('too_many_cta');
    expect(body.error.details?.violations).toEqual(VIOLATIONS);
  });
});

/** A route that never answers 422 for a rule the use case refuses is a lie. */
describe('the claim in broadcasts-route-helpers is literally true', () => {
  it('both template routes are wired to designBlockErrorResponse', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    for (const p of [
      'src/app/api/admin/broadcasts/templates/route.ts',
      'src/app/api/admin/broadcasts/templates/[id]/route.ts',
    ]) {
      expect(readFileSync(resolve(process.cwd(), p), 'utf8')).toContain(
        'designBlockErrorResponse',
      );
    }
  });
});
