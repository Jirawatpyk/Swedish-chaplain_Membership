/**
 * 088-invoice-tax-flow-redesign — T027 [US3] Contract: PATCH /api/members/[id]
 * §86/4 Head-Office / Branch admin edit (contracts/member-branch.md, FR-008).
 *
 * Two layers of the same contract:
 *
 *  1. The USE-CASE (`updateMember`, run real with a mocked repo + audit) — this
 *     owns the field-update arm's NEW behaviour: the head-office ⇔ branch-code
 *     pairing rule (zod superRefine) and the `member_updated` audit carrying the
 *     branch fields in `fields_changed` + `diff` (NO new audit event type).
 *
 *  2. The ROUTE RBAC (admin-only) — a manager / member is denied at the
 *     `requireAdminContext(request, { resource:'members', action:'write' })`
 *     guard before the use-case runs; NOT exposed on the member self-portal.
 *
 * The use-case tests import `updateMember` from its DEEP path (real), with
 * `@/lib/db`'s `runInTenant` stubbed to run the callback with a fake tx. The
 * route test dynamically imports the handler with its barrel + guard mocked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok } from '@/lib/result';

// --- Hoisted mocks -----------------------------------------------------------

// Use-case layer: run `updateMember`'s runInTenant callback with a fake tx (no
// live Neon). The repo/audit are hand-mocked per test.
vi.mock('@/lib/db', () => ({
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

// Route layer: admin guard + barrel + deps stubbed so the RBAC path is testable
// without loading the real members module.
const requireAdminContextMock = vi.fn();
const routeUpdateMemberMock = vi.fn();
vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members', () => ({
  updateMember: (...a: unknown[]) => routeUpdateMemberMock(...a),
  changePlan: vi.fn(),
  getMember: vi.fn(),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({})),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } })),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Deep imports (real) — NOT affected by the `@/modules/members` barrel mock.
import { updateMember } from '@/modules/members/application/use-cases/update-member';
import { asMemberId } from '@/modules/members/domain/member';

const validMemberId = '11111111-2222-3333-4444-555555555555';
const meta = { actorUserId: 'admin-1', requestId: 'req-branch' };

type AuditEvt = { payload: { fields_changed: string[]; diff: Record<string, { old: unknown; new: unknown }> } };

/** A minimal current Member row (only the fields the diff reads matter). */
function currentMember(over: Record<string, unknown> = {}) {
  return {
    tenantId: 'test',
    memberId: validMemberId,
    memberNumber: 1,
    companyName: 'Acme Co., Ltd.',
    legalEntityType: 'company',
    country: 'TH',
    taxId: null,
    // 059 / PR-A Task 5 — a branch implies a VAT registrant (ประกาศอธิบดีฯ 199:
    // the สำนักงานใหญ่/สาขา line is a §86/4 particular required only of a
    // registrant, so a non-registrant branch would render NO branch line at all).
    // This fixture predates the recorded flag: it carried only
    // `legalEntityType: 'company'`, and the old GUESS — "any entity type that is
    // not 'individual'" — read that as registrant, which is exactly the inference
    // this branch deleted. Without the flag the member is a non-registrant, and
    // promoting it to a branch is now correctly REFUSED. State the fact.
    isVatRegistered: true,
    isHeadOffice: true,
    branchCode: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'p',
    planYear: 2026,
    registrationDate: new Date('2026-01-01'),
    registrationFeePaid: false,
    lastActivityAt: null,
    notes: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    province: null,
    postalCode: null,
    status: 'active',
    archivedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...over,
  };
}

function makeDeps(current: ReturnType<typeof currentMember>) {
  const auditEvents: AuditEvt[] = [];
  const memberRepo = {
    findByIdInTx: vi.fn(async () => ok(current)),
    updateFieldsInTx: vi.fn(async (_tx: unknown, _id: unknown, patch: Record<string, unknown>) =>
      ok({ ...current, ...patch }),
    ),
  };
  const audit = {
    recordInTx: vi.fn(async (_tx: unknown, _tenant: unknown, evt: AuditEvt) => {
      auditEvents.push(evt);
      return ok(undefined);
    }),
  };
  const clock = { now: () => new Date('2026-07-02T00:00:00Z') };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps = { tenant: { slug: 'test' }, memberRepo, audit, clock } as any;
  return { deps, auditEvents, memberRepo };
}

afterEach(() => vi.clearAllMocks());

describe('T027 updateMember — §86/4 branch pairing + audit (contract)', () => {
  it('valid head-office (is_head_office=true, branch_code=null): updates a branch → head office; audit diff carries both fields', async () => {
    const { deps, auditEvents } = makeDeps(
      currentMember({ isHeadOffice: false, branchCode: '00001' }),
    );
    const result = await updateMember(
      asMemberId(validMemberId),
      { is_head_office: true, branch_code: null },
      meta,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(auditEvents).toHaveLength(1);
    const { fields_changed, diff } = auditEvents[0]!.payload;
    expect(fields_changed).toContain('isHeadOffice');
    expect(fields_changed).toContain('branchCode');
    expect(diff.isHeadOffice).toEqual({ old: false, new: true });
    expect(diff.branchCode).toEqual({ old: '00001', new: null });
  });

  it('valid branch (is_head_office=false, branch_code="00042"): updates a head office → branch; audit diff carries both fields', async () => {
    const { deps, auditEvents } = makeDeps(currentMember());
    const result = await updateMember(
      asMemberId(validMemberId),
      { is_head_office: false, branch_code: '00042' },
      meta,
      deps,
    );
    expect(result.ok).toBe(true);
    const { fields_changed, diff } = auditEvents[0]!.payload;
    expect(fields_changed).toContain('isHeadOffice');
    expect(fields_changed).toContain('branchCode');
    expect(diff.branchCode).toEqual({ old: null, new: '00042' });
  });

  it('invalid pairing (head office + a branch code) → invalid_body, no repo/audit write', async () => {
    const { deps, memberRepo, auditEvents } = makeDeps(currentMember());
    const result = await updateMember(
      asMemberId(validMemberId),
      { is_head_office: true, branch_code: '00042' },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');
    expect(memberRepo.findByIdInTx).not.toHaveBeenCalled();
    expect(auditEvents).toHaveLength(0);
  });

  it('invalid pairing (branch + no code) → invalid_body', async () => {
    const { deps } = makeDeps(currentMember());
    const result = await updateMember(
      asMemberId(validMemberId),
      { is_head_office: false, branch_code: null },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');
  });

  it('a non-5-digit branch code → invalid_body (zod regex)', async () => {
    const { deps } = makeDeps(currentMember());
    const result = await updateMember(
      asMemberId(validMemberId),
      { is_head_office: false, branch_code: '4X' },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');
  });
});

describe('T027 PATCH /api/members/[memberId] — admin-only RBAC (contract)', () => {
  const routeParams = async () => ({ memberId: validMemberId });
  function makeRequest(body: unknown): NextRequest {
    return new NextRequest(`http://localhost/api/members/${validMemberId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-b' },
      body: JSON.stringify(body),
    });
  }

  it('a non-admin (manager) is denied at the write guard → the guard response, use-case NOT called', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json(
        { error: { code: 'forbidden', message: 'Forbidden.' } },
        { status: 403 },
      ),
    });
    const { PATCH } = await import('@/app/api/members/[memberId]/route');
    const res = await PATCH(makeRequest({ is_head_office: false, branch_code: '00042' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(403);
    expect(routeUpdateMemberMock).not.toHaveBeenCalled();
    // Asserts the write action is what gates the branch edit (tax-critical).
    expect(requireAdminContextMock).toHaveBeenCalledWith(expect.anything(), {
      resource: 'members',
      action: 'write',
    });
  });

  it('an admin branch edit dispatches to the field-update arm (not change-plan) → 200', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      current: { user: { id: 'admin-1', role: 'admin' } },
      requestId: 'req-branch',
    });
    routeUpdateMemberMock.mockResolvedValueOnce(
      ok({ ...currentMember({ isHeadOffice: false, branchCode: '00042' }) }),
    );
    const { PATCH } = await import('@/app/api/members/[memberId]/route');
    const res = await PATCH(makeRequest({ is_head_office: false, branch_code: '00042' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(200);
    expect(routeUpdateMemberMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.is_head_office).toBe(false);
    expect(body.branch_code).toBe('00042');
  });
});
