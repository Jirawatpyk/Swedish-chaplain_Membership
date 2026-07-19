/**
 * Contract: POST /api/invoices — the deliberate-duplicate wire surface.
 *
 * Two things this pins that no other layer can:
 *
 *   1. The 409 body. A duplicate refusal is the ONE error code the route
 *      answers with detail rather than a bare `{ code }`, because the admin
 *      has to see which document already exists before deciding whether a
 *      second one is deliberate. `total_satang` crosses the wire as a STRING
 *      (bigint is not JSON-serialisable) — a regression here would throw at
 *      serialisation, or silently drop the amount.
 *
 *   2. The acknowledgement cannot be set by accident. `z.literal(true)` means
 *      the string `"true"` — the exact shape a form encoding or query string
 *      would produce — is a 400, not an override. This is the difference
 *      between "a human decided" and "a coercion decided".
 *
 * Strategy mirrors create-draft-membership-coverage-threading.contract.test.ts:
 * mock the infrastructure seams, keep the REAL schema so the route's own zod
 * parse runs unmodified, override just the use-case + deps factory.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const createInvoiceDraftMock = vi.fn();
const loadMemberRenewalContextMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-dup-1',
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/app/(staff)/admin/invoices/_lib/member-renewal-context', () => ({
  loadMemberRenewalContext: (...args: unknown[]) => loadMemberRenewalContextMock(...args),
}));
vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    createInvoiceDraft: (...args: unknown[]) => createInvoiceDraftMock(...args),
    makeCreateInvoiceDraftDeps: () => ({}),
  };
});

const MEMBER_ID = '550e8400-e29b-41d4-a716-446655440000';
const EXISTING_ID = '11111111-1111-1111-1111-111111111111';

const adminContext = {
  current: {
    user: {
      id: 'admin-user-1',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin User',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-dup-1',
};

const STUB_INVOICE = {
  tenantId: 'test-swecham',
  invoiceId: 'inv_01TESTDUPDRAFT01',
  memberId: MEMBER_ID,
  planId: 'regular',
  planYear: 2026,
  invoiceSubject: 'membership',
  status: 'draft',
  currency: 'THB',
  creditedTotal: { satang: BigInt(0) },
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  lines: [],
};

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3100/api/invoices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  member_id: MEMBER_ID,
  plan_id: 'regular',
  plan_year: 2026,
  auto_email_on_issue: null,
};

describe('POST /api/invoices — deliberate-duplicate acknowledgement', () => {
  // Warm the route module ONCE before any test, mirroring the sibling
  // create-draft-membership-coverage-threading contract test. Without this the
  // first `await import(...)` happens inside a test body, and when this file
  // shares a worker with suites that already evaluated `@/modules/invoicing`
  // unmocked, the route binds the real use-case and every assertion here
  // fails — but only in a multi-file run, never in isolation.
  beforeAll(async () => {
    await import('@/app/api/invoices/route');
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
    loadMemberRenewalContextMock.mockResolvedValue({
      classification: { kind: 'not_applicable' },
      periodTo: null,
      termMonths: null,
      currentPeriodFrom: null,
      currentPeriodTo: null,
    });
    createInvoiceDraftMock.mockResolvedValue(ok(STUB_INVOICE));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('409s with the existing document`s details so the admin can decide', async () => {
    createInvoiceDraftMock.mockResolvedValue(
      err({
        code: 'duplicate_membership_invoice',
        existingInvoiceId: EXISTING_ID,
        existingStatus: 'issued',
        existingDocumentNumber: 'SC-2026-0042',
        existingTotalSatang: 2140000n,
      }),
    );
    const { POST } = await import('@/app/api/invoices/route');

    const res = await POST(post(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: 'duplicate_membership_invoice',
        existing: {
          invoice_id: EXISTING_ID,
          status: 'issued',
          document_number: 'SC-2026-0042',
          // bigint is not JSON-serialisable — satang crosses as a string.
          total_satang: '2140000',
        },
      },
    });
  });

  it('reports a DRAFT duplicate`s null number/total as null, not as absent', async () => {
    createInvoiceDraftMock.mockResolvedValue(
      err({
        code: 'duplicate_membership_invoice',
        existingInvoiceId: EXISTING_ID,
        existingStatus: 'draft',
        existingDocumentNumber: null,
        existingTotalSatang: null,
      }),
    );
    const { POST } = await import('@/app/api/invoices/route');

    const body = await (await POST(post(validBody))).json();
    expect(body.error.existing.document_number).toBeNull();
    expect(body.error.existing.total_satang).toBeNull();
  });

  it('forwards a literal-true acknowledgement to the use case', async () => {
    const { POST } = await import('@/app/api/invoices/route');

    const res = await POST(post({ ...validBody, acknowledge_duplicate: true }));
    expect(res.status).toBe(201);
    const input = createInvoiceDraftMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.duplicatePolicy).toBe('acknowledged');
  });

  it('opts into the check on an ordinary submit — this is the interactive surface', async () => {
    const { POST } = await import('@/app/api/invoices/route');

    await POST(post(validBody));
    const input = createInvoiceDraftMock.mock.calls[0]![1] as Record<string, unknown>;
    // Always 'refuse', never absent: `createInvoiceDraft` skips the check
    // when no policy is given (so void-on-reissue can draft a replacement
    // bill), which means this route must opt in explicitly on EVERY submit or
    // the guard silently does nothing here.
    expect(input.duplicatePolicy).toBe('refuse');
  });

  it.each([
    ['the string "true"', 'true'],
    ['the string "1"', '1'],
    ['the number 1', 1],
    ['the boolean false', false],
  ])(
    'rejects %s with 400 — the override cannot be set by coercion',
    async (_label, value) => {
      const { POST } = await import('@/app/api/invoices/route');

      const res = await POST(post({ ...validBody, acknowledge_duplicate: value }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_body');
      // And nothing was attempted.
      expect(createInvoiceDraftMock).not.toHaveBeenCalled();
    },
  );
});
