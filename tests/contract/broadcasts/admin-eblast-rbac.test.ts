/**
 * F119 T046 — RBAC and session pins on the staff routes that exist after
 * PR-2 chunk 3a (spec § Roles, FR-013), plus the FR-005 audience pin:
 *
 *   POST  /api/admin/broadcasts/[id]/version   broadcasts.write
 *   PATCH /api/admin/broadcasts/[id]/version   broadcasts.write
 *   GET   /api/admin/broadcasts/[id]/version   broadcasts.read
 *   POST  /api/admin/broadcasts/test-copy      broadcasts.write (PR-1 route)
 *
 * Two halves, both real: the permission EVALUATOR decides who holds each key
 * (manager holds `broadcasts.read` only; member holds neither), and each
 * handler names exactly its key on the gate (read off the mock's call per
 * verb — a file-wide source regex cannot attribute a key to a verb in a
 * three-handler file) and returns the gate's refusal untouched with nothing
 * run. A member session never reaches a staff route: `requireApiPermission`
 * refuses it before any key is read — including for a person who also holds
 * a portal account of the owning member (the session decides, spec § Roles).
 * `pnpm check:api-route-guard` pins the same (verb, key) pairs against
 * `tests/helpers/rbac-observed-baseline.ts`.
 *
 * The send / schedule arms land with those routes (T062 / T060).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  deniedResponse,
  getVersionRequest,
  harness,
  importVersionRoute,
  patchVersionRequest,
  postVersionRequest,
  resetVersionHarness,
  routeParams,
  staffCtx,
} from '../../helpers/eblast-version-route-harness';

const sendTestCopyMock = vi.fn();

vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-version-route-harness')).rbacMock());
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/broadcast-approval-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).approvalDepsMock(),
);
vi.mock('@/modules/broadcasts', async () => ({
  ...(await (await import('../../helpers/eblast-version-route-harness')).broadcastsBarrelMock()),
  sendTestCopy: (...args: unknown[]) => sendTestCopyMock(...args),
  TEST_COPY_SUBJECT_MAX: 200,
  TEST_COPY_BODY_MAX_BYTES: 200 * 1024,
}));
vi.mock('@/lib/broadcast-test-copy-deps', () => ({
  makeSendTestCopyDeps: async () => ({ sanitizer: {}, brand: {}, renderer: {}, mailer: {}, audit: {}, tenantDisplayName: 'T' }),
}));

const SUBMITTED = makeApprovalBroadcast();
const ID = SUBMITTED.broadcastId as string;
const TOKEN = new Date('2026-09-24T08:30:00.000Z');
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const WORKING = makeApprovalVersion({ versionNo: 1, updatedAt: TOKEN });
const saveBody = (extra: Record<string, unknown> = {}) => ({
  subject: 'S',
  bodyHtml: '<p>b</p>',
  bodySource: '{}',
  noteToMember: null,
  expectedUpdatedAt: TOKEN.toISOString(),
  ...extra,
});
const testCopyRequest = () =>
  new NextRequest('http://localhost/api/admin/broadcasts/test-copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: 'S', bodyHtml: '<p>b</p>', locale: 'en' }),
  });

beforeEach(() => {
  resetVersionHarness({ broadcasts: [SUBMITTED] });
  sendTestCopyMock.mockReset();
  sendTestCopyMock.mockResolvedValue({ ok: true, value: { messageId: 'm' } });
});

describe('the evaluator decides who holds each key', () => {
  it('manager holds broadcasts.read only; marketing, admin and super_admin hold write; a member holds neither', () => {
    expect(hasPermission('manager', 'broadcasts.read')).toBe(true);
    expect(hasPermission('manager', 'broadcasts.write')).toBe(false);
    for (const role of ['marketing', 'admin', 'super_admin'] as const) {
      expect(hasPermission(role, 'broadcasts.read')).toBe(true);
      expect(hasPermission(role, 'broadcasts.write')).toBe(true);
    }
    expect(hasPermission('member', 'broadcasts.read')).toBe(false);
    expect(hasPermission('member', 'broadcasts.write')).toBe(false);
  });
});

describe('…/[id]/version — each verb names its key; the gate decides', () => {
  it('`marketing` → POST 201, PATCH 200 (the gate admits broadcasts.write), and GET names broadcasts.read', async () => {
    const { POST, PATCH, GET } = await importVersionRoute();
    expect((await POST(postVersionRequest(ID), routeParams(ID))).status).toBe(201);
    expect(harness.requireApiPermission.mock.calls[0]![1]).toBe('broadcasts.write');

    const working = harness.store.versionsRepo.rows()[1]!;
    const patched = await PATCH(
      patchVersionRequest(ID, saveBody({ expectedUpdatedAt: working.updatedAt.toISOString() })),
      routeParams(ID),
    );
    expect(patched.status).toBe(200);
    expect(harness.requireApiPermission.mock.calls[1]![1]).toBe('broadcasts.write');

    expect((await GET(getVersionRequest(ID), routeParams(ID))).status).toBe(200);
    expect(harness.requireApiPermission.mock.calls[2]![1]).toBe('broadcasts.read');
  });

  it('`manager` → 403 on POST and PATCH (refusal returned untouched, nothing written, no bucket consumed); 200 on GET', async () => {
    const { POST, PATCH, GET } = await importVersionRoute();
    harness.requireApiPermission.mockImplementation(async (_req: unknown, key: string) =>
      key === 'broadcasts.read' ? staffCtx('manager', '66666666-6666-4666-8666-666666666666') : deniedResponse(),
    );

    expect((await POST(postVersionRequest(ID), routeParams(ID))).status).toBe(403);
    expect((await PATCH(patchVersionRequest(ID, saveBody()), routeParams(ID))).status).toBe(403);
    expect((await GET(getVersionRequest(ID), routeParams(ID))).status).toBe(200);
    expect(harness.store.versionsRepo.rows()).toHaveLength(0);
    expect(harness.store.state.broadcasts.get(`test-tenant::${ID}`)!.status).toBe('submitted');
    expect(harness.checkLimit).not.toHaveBeenCalled();
  });

  it('a member session → 403 on all three verbs, even for a person who also holds a portal account of the owning member', async () => {
    harness.requireApiPermission.mockResolvedValue(deniedResponse());
    const { POST, PATCH, GET } = await importVersionRoute();
    expect((await POST(postVersionRequest(ID), routeParams(ID))).status).toBe(403);
    expect((await PATCH(patchVersionRequest(ID, saveBody()), routeParams(ID))).status).toBe(403);
    expect((await GET(getVersionRequest(ID), routeParams(ID))).status).toBe(403);
    expect(harness.store.broadcastsRepo.findByIdInTx).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/broadcasts/test-copy (PR-1 route) — manager is read-only', () => {
  it('names broadcasts.write; `manager` → 403 and no test copy is sent; `marketing` → 202', async () => {
    const { POST } = await import('@/app/api/admin/broadcasts/test-copy/route');
    harness.requireApiPermission.mockResolvedValueOnce(deniedResponse());
    expect((await POST(testCopyRequest())).status).toBe(403);
    expect(harness.requireApiPermission.mock.calls[0]![1]).toBe('broadcasts.write');
    expect(sendTestCopyMock).not.toHaveBeenCalled();

    expect((await POST(testCopyRequest())).status).toBe(202);
    expect(sendTestCopyMock).toHaveBeenCalledTimes(1);
  });
});

describe('FR-005 — the audience is not marketing\'s to change', () => {
  it('a PATCH carrying segmentType / segmentParams / customRecipientEmails saves the content and leaves the audience unchanged', async () => {
    resetVersionHarness({
      broadcasts: [{ ...SUBMITTED, status: 'in_design' }],
      versions: [V0, WORKING],
    });
    const { PATCH } = await importVersionRoute();
    const res = await PATCH(
      patchVersionRequest(
        ID,
        saveBody({
          subject: 'Edited subject',
          segmentType: 'all_members',
          segmentParams: { tierIds: ['x'] },
          customRecipientEmails: ['intruder@elsewhere.test'],
        }),
      ),
      routeParams(ID),
    );

    expect(res.status).toBe(200);
    expect(harness.store.versionsRepo.rows()[1]!.subject).toBe('Edited subject');
    const row = harness.store.state.broadcasts.get(`test-tenant::${ID}`)!;
    expect(row.segmentType).toBe(SUBMITTED.segmentType);
    expect(row.segmentParams).toBe(SUBMITTED.segmentParams);
    expect(row.customRecipientEmails).toEqual(SUBMITTED.customRecipientEmails);
    // The save path has no way to write the broadcast row at all.
    expect(harness.store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
    expect(harness.store.versionsRepo.updateWorkingCopy.mock.calls[0]![2]).not.toHaveProperty('segmentType');
  });
});
