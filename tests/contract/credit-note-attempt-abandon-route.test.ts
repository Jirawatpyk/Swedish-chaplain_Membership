/**
 * Task 68 — Contract test: POST /api/credit-notes/attempts/abandon.
 *
 * "Start over" on a locked admin credit-note attempt. Same gate and rate-limit
 * bucket as issuing a note (`credit_notes.write`); the body carries the
 * invoice and the attempt's idempotency key. The use case answers either
 * `abandoned` (the key is closed for good) or `issued` (the note the attempt
 * had already issued, serialised like the issue route's 201).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const abandonMock = vi.fn();
const rateLimitCheckMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-ab-1' }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
}));
vi.mock('@/modules/invoicing', async () => {
  const actual = await vi.importActual<typeof import('@/modules/invoicing')>('@/modules/invoicing');
  return {
    ...actual,
    abandonCreditNoteAttempt: (...args: unknown[]) => abandonMock(...args),
    makeAbandonCreditNoteAttemptDeps: () => ({}),
  };
});

const ADMIN_CONTEXT = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-ab-1',
};
const INVOICE_ID = '00000000-0000-4000-8000-000000000001';
const KEY = '11111111-2222-4333-8444-555555555555';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/credit-notes/attempts/abandon', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function loadHandler() {
  return (await import('@/app/api/credit-notes/attempts/abandon/route')).POST;
}
function noteFixture() {
  return {
    tenantId: 'test',
    creditNoteId: 'cn-1',
    originalInvoiceId: INVOICE_ID,
    originalInvoiceMemberId: 'member-1',
    fiscalYear: 2026,
    sequenceNumber: 1,
    documentNumber: { raw: 'CN-2026-000001' },
    issueDate: '2026-04-20',
    issuedByUserId: 'admin-1',
    reason: 'contract test',
    creditAmount: { satang: 50000n },
    vat: { satang: 3500n },
    total: { satang: 53500n },
    tenantIdentitySnapshot: {},
    memberIdentitySnapshot: {},
    pdf: { blobKey: 'k', sha256: 'a'.repeat(64), templateVersion: 1 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('POST /api/credit-notes/attempts/abandon — contract (task 68)', () => {
  beforeAll(async () => {
    await loadHandler();
  }, 60_000);
  afterEach(() => vi.clearAllMocks());

  it('200 abandoned — passes tenant, actor, invoice and key to the use case', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    abandonMock.mockResolvedValueOnce(ok({ outcome: 'abandoned' }));
    const res = await (await loadHandler())(makeReq({ invoiceId: INVOICE_ID, idempotencyKey: KEY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'abandoned' });
    expect(requireApiPermissionMock.mock.calls[0]?.[1]).toBe('credit_notes.write');
    expect(abandonMock.mock.calls[0]?.[1]).toMatchObject({
      tenantId: 'test',
      actorUserId: 'admin-1',
      invoiceId: INVOICE_ID,
      idempotencyKey: KEY,
    });
  });

  it('200 issued — the note the attempt had issued, serialised as the issue route does', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    abandonMock.mockResolvedValueOnce(ok({ outcome: 'issued', creditNote: noteFixture() }));
    const res = await (await loadHandler())(makeReq({ invoiceId: INVOICE_ID, idempotencyKey: KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('issued');
    expect(body.credit_note_id).toBe('cn-1');
    expect(body.document_number).toBe('CN-2026-000001');
  });

  it('403 — the gate response is returned untouched and the use case never runs', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 }),
    });
    const res = await (await loadHandler())(makeReq({ invoiceId: INVOICE_ID, idempotencyKey: KEY }));
    expect(res.status).toBe(403);
    expect(abandonMock).not.toHaveBeenCalled();
  });

  it('429 — rate limited in the credit-note bucket', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: false, reset: Date.now() + 60_000 });
    const res = await (await loadHandler())(makeReq({ invoiceId: INVOICE_ID, idempotencyKey: KEY }));
    expect(res.status).toBe(429);
    expect(rateLimitCheckMock.mock.calls[0]?.[0]).toBe('f4:credit-note:test:admin-1');
    expect(abandonMock).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{', 'invalid_json'],
    ['a malformed key', { invoiceId: INVOICE_ID, idempotencyKey: 'nope' }, 'invalid_body'],
    ['a missing invoice', { idempotencyKey: KEY }, 'invalid_body'],
  ] as const)('400 on %s', async (_l, body, code) => {
    requireApiPermissionMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    const res = await (await loadHandler())(makeReq(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(code);
    expect(abandonMock).not.toHaveBeenCalled();
  });

  it.each([
    ['invoice_not_found', 404],
    ['concurrent_state_change', 409],
  ] as const)('%s → HTTP %i', async (code, status) => {
    requireApiPermissionMock.mockResolvedValueOnce(ADMIN_CONTEXT);
    rateLimitCheckMock.mockResolvedValueOnce({ success: true, reset: Date.now() + 1000 });
    abandonMock.mockResolvedValueOnce(err({ code }));
    const res = await (await loadHandler())(makeReq({ invoiceId: INVOICE_ID, idempotencyKey: KEY }));
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
  });
});
