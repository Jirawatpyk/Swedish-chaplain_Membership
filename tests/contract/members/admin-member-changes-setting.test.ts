/**
 * F114 T093 — contract: `GET` + `PATCH /api/admin/settings/member-changes`
 * (contracts/admin-change-requests-api.md § settings; US6 AS2, AS4; FR-031,
 * FR-032, FR-036, FR-039).
 *
 * The REAL `setMemberChangeApprovalEnabled` / `countPendingChangeRequests`
 * run over the in-memory fakes (the composition root is mocked;
 * `runInTenant` passes through): flag OFF → 404 BEFORE the gate; the gate
 * key is the literal `members.write` on both verbs (a manager's / marketing
 * user's refusal passes through as the gate's 403 — the `permission_denied`
 * audit with the real role is the gate's own contract,
 * tests/contract/rbac/permission-denied-audit.test.ts); admin + super_admin
 * 200; `GET` → `{ approvalEnabled, pendingCount }` (no row → `false`);
 * `PATCH { approvalEnabled }` → 200 `{ approvalEnabled, changedAt }` + exactly
 * ONE audit row `{ previous, next, actor_role }` with the actor's TRUE role;
 * the unchanged value → 200 and NO audit row; a malformed body → 400 problem;
 * READ_ONLY_MODE → 503 `read_only_mode` on PATCH after the gate (T116, the
 * US6 half) while `GET` still answers; every fault → 500 named
 * `M114.admin.setting.<arm>`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import {
  makeAuditPortFake,
  makeClockFake,
  makeInMemoryChangeRequestRepo,
  makeTenantMemberChangeSettingsFake,
  type AuditPortFake,
  type InMemoryChangeRequestRepo,
  type TenantMemberChangeSettingsFake,
} from '../../helpers/change-request-fakes';

const requireApiPermissionMock = vi.fn();
const loggerError = vi.fn();
let flagOn = true;
let readOnly = false;
let repo: InMemoryChangeRequestRepo;
let settings: TenantMemberChangeSettingsFake;
let audit: AuditPortFake;

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      features: new Proxy(actual.env.features, {
        get: (target, prop) => (prop === 'memberChangeApproval' ? flagOn : Reflect.get(target, prop)),
      }),
      flags: new Proxy(actual.env.flags, {
        get: (target, prop) => (prop === 'readOnlyMode' ? readOnly : Reflect.get(target, prop)),
      }),
    },
  };
});
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
vi.mock('@/lib/rbac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rbac')>('@/lib/rbac');
  return { ...actual, requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args) };
});
vi.mock('@/lib/members-change-request-deps', () => ({
  asMembersUserId: (id: string) => id,
  buildChangeRequestDeps: vi.fn(() => ({
    tenant: { slug: 'test-swecham', __brand: true },
    changeRequestRepo: repo,
    tenantMemberChangeSettings: settings,
    audit,
    clock: makeClockFake(NOW),
  })),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), debug: vi.fn() },
}));

import { GET, PATCH } from '@/app/api/admin/settings/member-changes/route';

const NOW = new Date('2026-09-15T08:00:00Z');
const DAY = 86_400_000;
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const ADMIN = 'a6c5b1a2-0000-4000-8000-00000000aaaa';
const R = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const staffContext = (role: string) => ({
  current: { user: { id: ADMIN, email: 'staff@swecham.example', role, status: 'active' }, session: { id: 's-1' } },
  sourceIp: '127.0.0.1',
  requestId: 'req-set-1',
});

function pending(id: string, ageDays: number): ChangeRequest {
  const at = new Date(NOW.getTime() - ageDays * DAY);
  return {
    id: id as ChangeRequestId,
    tenantId: 'test-swecham' as ChangeRequest['tenantId'],
    memberId: MEMBER as ChangeRequest['memberId'],
    submittedByUserId: SUBMITTER as UserId,
    submittedByContactId: CONTACT as ChangeRequest['submittedByContactId'],
    submitterRoleAtSubmission: 'primary',
    scope: 'own_contact',
    state: 'pending',
    outcome: null,
    withdrawnReason: null,
    replacedByRequestId: null,
    submittedAt: at,
    staffNotifiedAt: at,
    decidedAt: null,
    decidedByUserId: null,
    decisionReason: null,
    decisionNote: null,
    withdrawnAt: null,
    outcomeAcknowledgedAt: null,
    fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: null, appliedAt: null }],
  };
}

function get(): Promise<Response> {
  return GET(new NextRequest('http://localhost/api/admin/settings/member-changes', { method: 'GET' }));
}
function patch(body: unknown): Promise<Response> {
  return PATCH(
    new NextRequest('http://localhost/api/admin/settings/member-changes', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  flagOn = true;
  readOnly = false;
  repo = makeInMemoryChangeRequestRepo([pending(R(1), 4), pending(R(2), 1)]);
  settings = makeTenantMemberChangeSettingsFake(false);
  audit = makeAuditPortFake();
  requireApiPermissionMock.mockResolvedValue(staffContext('admin'));
});
afterEach(() => vi.clearAllMocks());

describe('/api/admin/settings/member-changes — gates', () => {
  it('404 while the platform flag is off — BEFORE the gate, on both verbs (FR-039)', async () => {
    flagOn = false;
    expect((await get()).status).toBe(404);
    expect((await patch({ approvalEnabled: true })).status).toBe(404);
    expect(requireApiPermissionMock).not.toHaveBeenCalled();
    expect(settings.state).toEqual({ enabled: false });
  });

  it("hands the gate the literal key 'members.write' on both verbs; a refused session (manager / marketing) is a pass-through 403", async () => {
    requireApiPermissionMock.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    expect((await get()).status).toBe(403);
    expect((await patch({ approvalEnabled: true })).status).toBe(403);
    expect(requireApiPermissionMock).toHaveBeenCalledTimes(2);
    expect(requireApiPermissionMock).toHaveBeenNthCalledWith(1, expect.anything(), 'members.write');
    expect(requireApiPermissionMock).toHaveBeenNthCalledWith(2, expect.anything(), 'members.write');
    expect(settings.state).toEqual({ enabled: false });
    expect(audit.events).toHaveLength(0);
  });

  it('admin and super_admin both pass (the gate answers by permission, not by role literal)', async () => {
    requireApiPermissionMock.mockResolvedValue(staffContext('super_admin'));
    expect((await get()).status).toBe(200);
    expect((await patch({ approvalEnabled: true })).status).toBe(200);
    requireApiPermissionMock.mockResolvedValue(staffContext('admin'));
    expect((await get()).status).toBe(200);
  });

  it('READ_ONLY_MODE → 503 read_only_mode on PATCH after the gate, nothing written; GET still answers (FR-036 / T116)', async () => {
    readOnly = true;
    const res = await patch({ approvalEnabled: true });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toMatchObject({ error: { code: 'read_only_mode' } });
    expect(requireApiPermissionMock).toHaveBeenCalledWith(expect.anything(), 'members.write');
    expect(settings.state).toEqual({ enabled: false });
    expect(audit.events).toHaveLength(0);
    const read = await get();
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ approvalEnabled: false, pendingCount: 2 });
  });
});

describe('GET /api/admin/settings/member-changes', () => {
  it('→ { approvalEnabled, pendingCount } — the tenant row + the live pending count (the switch-off warning, FR-032)', async () => {
    settings.state = { enabled: true };
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvalEnabled: true, pendingCount: 2 });
  });

  it('no tenant row yet → approvalEnabled false (the new-tenant default is off, FR-031)', async () => {
    settings.state = null;
    expect(await (await get()).json()).toEqual({ approvalEnabled: false, pendingCount: 2 });
  });

  it('a settings read fault → 500 problem named M114.admin.setting.settings_read_failed', async () => {
    settings.readInTenant.mockResolvedValueOnce({ ok: false, error: { code: 'repo.unexpected' } });
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ status: 500, type: expect.stringMatching(/server_error$/) });
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.admin.setting.settings_read_failed' }), expect.any(String));
  });

  it('a pending-count fault → 500 problem named M114.admin.setting.pending_count_failed', async () => {
    repo.failNext('pendingStats');
    const res = await get();
    expect(res.status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.admin.setting.pending_count_failed' }), expect.any(String));
  });
});

describe('PATCH /api/admin/settings/member-changes', () => {
  it('{ approvalEnabled: true } → 200 { approvalEnabled, changedAt } + exactly ONE audit row { previous, next } with the actor’s true role', async () => {
    const res = await patch({ approvalEnabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvalEnabled: true, changedAt: NOW.toISOString() });
    expect(settings.state).toEqual({ enabled: true });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      type: 'member_change_approval_setting_changed',
      actorUserId: ADMIN,
      requestId: 'req-set-1',
      payload: { previous: false, next: true, actor_role: 'admin' },
    });
    expect(audit.events[0]!.payload).not.toHaveProperty('member_id');
  });

  it('a super_admin flip records super_admin — the role the session carries, never a literal', async () => {
    requireApiPermissionMock.mockResolvedValue(staffContext('super_admin'));
    await patch({ approvalEnabled: true });
    expect(audit.events[0]?.payload).toMatchObject({ actor_role: 'super_admin' });
  });

  it('switching OFF with requests pending → 200; the pending rows stay untouched (they remain decidable — FR-032, US6 AS2)', async () => {
    settings.state = { enabled: true };
    const res = await patch({ approvalEnabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvalEnabled: false, changedAt: NOW.toISOString() });
    expect(audit.events[0]?.payload).toMatchObject({ previous: true, next: false });
    expect(repo.rows.get(R(1))?.state).toBe('pending');
    expect(repo.rows.get(R(2))?.state).toBe('pending');
  });

  it('the unchanged value → 200 with changedAt null and NO audit row', async () => {
    const res = await patch({ approvalEnabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approvalEnabled: false, changedAt: null });
    expect(audit.events).toHaveLength(0);
    // and a real change right after is audited once
    await patch({ approvalEnabled: true });
    expect(audit.events).toHaveLength(1);
  });

  it('a malformed body → 400 problem invalid_body, nothing written', async () => {
    for (const bad of ['{nope', { approvalEnabled: 'yes' }, { enabled: true }, { approvalEnabled: true, extra: 1 }, []]) {
      const res = await patch(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.json()).toMatchObject({ status: 400, type: expect.stringMatching(/invalid_body$/) });
    }
    expect(settings.state).toEqual({ enabled: false });
    expect(audit.events).toHaveLength(0);
  });

  it('a use-case fault → 500 problem named M114.admin.setting.use_case_failed', async () => {
    settings.setApprovalEnabledInTx.mockResolvedValueOnce({ ok: false, error: { code: 'repo.unexpected' } });
    const res = await patch({ approvalEnabled: true });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ status: 500, type: expect.stringMatching(/server_error$/) });
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.admin.setting.use_case_failed' }), expect.any(String));
    expect(audit.events).toHaveLength(0);
  });
});
