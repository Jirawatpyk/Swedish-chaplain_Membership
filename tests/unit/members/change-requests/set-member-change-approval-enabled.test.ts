/**
 * F114 T095 — `setMemberChangeApprovalEnabled`, every branch (US6 AS4;
 * FR-031; contracts/admin-change-requests-api.md § settings;
 * contracts/notifications-and-audit.md `member_change_approval_setting_changed`).
 *
 * Pinned: the switch is upserted through `setApprovalEnabledInTx` INSIDE
 * `runInTenant`; a CHANGED value writes ONE audit row
 * `member_change_approval_setting_changed { previous, next, actor_role }`
 * with the staff actor — `actor_role` is whatever the caller passes (the
 * session role), `null` when absent, never a literal (audit-truth
 * invariant); an UNCHANGED value (the upsert reports the same previous
 * value) writes NO audit row and answers `changed: false`; a first write on
 * a tenant with no row (previous defaults to `false`) audits only when the
 * new value differs from that default; every fault → `server_error`,
 * logged.
 *
 * `runInTenant` is stubbed (unit level); the live-Neon half of the setting
 * rides in the US6 integration slice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runInTenantMock = vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true }));
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: (...args: unknown[]) => runInTenantMock(...(args as [unknown, (tx: unknown) => Promise<unknown>])),
}));
const loggerError = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { asTenantContext } from '@/modules/tenants';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import { setMemberChangeApprovalEnabled } from '@/modules/members/application/use-cases/change-requests/set-member-change-approval-enabled';
import { makeAuditPortFake, makeClockFake, makeTenantMemberChangeSettingsFake } from '../../../helpers/change-request-fakes';

const tenant = asTenantContext('test-tenant');
const ADMIN = 'a6c5b1a2-0000-4000-8000-00000000aaaa' as UserId;
const NOW = new Date('2026-09-15T10:00:00Z');

function makeDeps(initial: boolean | null) {
  const settings = makeTenantMemberChangeSettingsFake(initial);
  const audit = makeAuditPortFake();
  const deps = { tenant, tenantMemberChangeSettings: settings, audit, clock: makeClockFake(NOW) };
  return { deps, settings, audit };
}

const input = { enabled: true, actorUserId: ADMIN, actorRole: 'admin' as const, requestId: 'req-s1' };

beforeEach(() => vi.clearAllMocks());

describe('setMemberChangeApprovalEnabled', () => {
  it('off → on: upserts inside runInTenant and writes ONE audit row { previous: false, next: true, actor_role } with the staff actor', async () => {
    const { deps, settings, audit } = makeDeps(false);
    const r = await setMemberChangeApprovalEnabled(deps, input);
    expect(r).toEqual({ ok: true, value: { approvalEnabled: true, previous: false, changed: true, changedAt: NOW } });
    // the AUDIT branch IS the `changed: true` branch — B3: `changedAt` is
    // reachable only after narrowing on `changed`, so a caller cannot ask
    // for the instant of a transition that did not happen
    if (r.ok && r.value.changed) expect(r.value.changedAt).toEqual(NOW);
    else expect.unreachable('a real transition must report changed: true');
    expect(settings.state).toEqual({ enabled: true });
    expect(runInTenantMock).toHaveBeenCalledTimes(1);
    expect(runInTenantMock).toHaveBeenCalledWith(tenant, expect.any(Function));
    expect(settings.setApprovalEnabledInTx).toHaveBeenCalledWith({ __tx: true }, 'test-tenant', true);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      type: 'member_change_approval_setting_changed',
      actorUserId: ADMIN,
      requestId: 'req-s1',
      payload: { previous: false, next: true, actor_role: 'admin' },
    });
    // written INSIDE the tx (rollback-safe), never `record`; no member key
    // (a setting flip is not member activity — the 0009 trigger must not fire)
    expect(audit.recordInTx).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.events[0]!.payload).not.toHaveProperty('member_id');
    expect(audit.events[0]!.payload).not.toHaveProperty('related_member_id');
  });

  it('on → off: audits { previous: true, next: false }', async () => {
    const { deps, settings, audit } = makeDeps(true);
    const r = await setMemberChangeApprovalEnabled(deps, { ...input, enabled: false });
    expect(r).toEqual({ ok: true, value: { approvalEnabled: false, previous: true, changed: true, changedAt: NOW } });
    expect(settings.state).toEqual({ enabled: false });
    expect(audit.events[0]?.payload).toMatchObject({ previous: true, next: false });
  });

  it('records the role the caller passes — a super_admin flip carries super_admin, never a literal', async () => {
    const { deps, audit } = makeDeps(false);
    await setMemberChangeApprovalEnabled(deps, { ...input, actorRole: 'super_admin' });
    expect(audit.events[0]?.payload).toMatchObject({ actor_role: 'super_admin' });
  });

  it('an absent actor role is recorded as null (audit-truth: never `?? admin`)', async () => {
    const { deps, audit } = makeDeps(false);
    const { actorRole: _omitted, ...withoutRole } = input;
    void _omitted;
    await setMemberChangeApprovalEnabled(deps, withoutRole);
    expect(audit.events[0]?.payload).toMatchObject({ actor_role: null });
  });

  it('an UNCHANGED value → changed: false, NO audit row (the upsert reports the same previous value)', async () => {
    const { deps, settings, audit } = makeDeps(true);
    const r = await setMemberChangeApprovalEnabled(deps, input);
    expect(r).toEqual({ ok: true, value: { approvalEnabled: true, previous: true, changed: false } });
    // `changedAt` does not EXIST on the no-op arm (B3), rather than being
    // a null every consumer has to remember to check
    expect(r.ok && 'changedAt' in r.value).toBe(false);
    expect(settings.state).toEqual({ enabled: true });
    expect(audit.events).toHaveLength(0);
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });

  it('no row yet (new tenant, default off) + off → no audit; no row + on → audited from the default', async () => {
    const off = makeDeps(null);
    const r1 = await setMemberChangeApprovalEnabled(off.deps, { ...input, enabled: false });
    expect(r1).toEqual({ ok: true, value: { approvalEnabled: false, previous: false, changed: false } });
    expect(off.audit.events).toHaveLength(0);

    const on = makeDeps(null);
    const r2 = await setMemberChangeApprovalEnabled(on.deps, input);
    expect(r2.ok && r2.value.changed).toBe(true);
    expect(on.audit.events[0]?.payload).toMatchObject({ previous: false, next: true });
  });

  it('a fault on the upsert → server_error, logged, no audit', async () => {
    const { deps, settings, audit } = makeDeps(false);
    settings.setApprovalEnabledInTx.mockResolvedValueOnce({ ok: false, error: { code: 'repo.unexpected', cause: new Error('boom') } });
    const r = await setMemberChangeApprovalEnabled(deps, input);
    expect(r).toEqual({ ok: false, error: { type: 'server_error', message: 'set-approval: repo.unexpected' } });
    expect(audit.events).toHaveLength(0);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'test-tenant', requestId: 'req-s1', err: 'repo.unexpected' }),
      expect.stringMatching(/setting/),
    );
  });

  it('an audit write failure → server_error (the tx is aborted; atomicity is the live-Neon suite)', async () => {
    const { deps, audit } = makeDeps(false);
    audit.failNext();
    const r = await setMemberChangeApprovalEnabled(deps, input);
    expect(!r.ok && r.error.type).toBe('server_error');
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ err: 'repo.unexpected' }), expect.any(String));
  });

  it('a throw that is not a repo error (the tx itself) → server_error naming the error class', async () => {
    const { deps, settings } = makeDeps(false);
    settings.setApprovalEnabledInTx.mockImplementationOnce(async () => {
      throw new TypeError('connection reset');
    });
    const r = await setMemberChangeApprovalEnabled(deps, input);
    expect(r).toEqual({ ok: false, error: { type: 'server_error', message: 'set-approval: TypeError' } });
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ err: 'TypeError' }), expect.any(String));
  });
});


describe('setMemberChangeApprovalEnabled — a throw that is not an Error (T105 coverage)', () => {
  it('the driver rejecting with a string is logged in its string form', async () => {
    const { deps, settings } = makeDeps(false);
    settings.setApprovalEnabledInTx.mockImplementationOnce(async () => {
      throw 'connection reset';
    });
    const r = await setMemberChangeApprovalEnabled(deps, input);
    expect(r).toEqual({ ok: false, error: { type: 'server_error', message: 'set-approval: connection reset' } });
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ err: 'connection reset', cause: undefined }), expect.any(String));
  });
});
