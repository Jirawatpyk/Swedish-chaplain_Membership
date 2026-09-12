/**
 * F114 T024 — the gate resolver (FR-031 / FR-039, research R11).
 *
 *   flag OFF                          → 'immediate' regardless of the tenant row
 *   flag ON  + no tenant row          → 'immediate' (new-tenant default: off)
 *   flag ON  + row with approval=false→ 'immediate'
 *   flag ON  + row with approval=true → 'approval'
 *
 * The resolver reads the flag through a `FlagPort` and the row through a
 * `TenantMemberSettingsPort`, so this test needs no env and no DB. It also
 * pins the per-request cache: two calls on one resolver read the row once.
 */
import { describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import {
  makeMemberChangeGateResolver,
  type MemberChangeGateDeps,
} from '@/modules/members/application/use-cases/change-requests/resolve-member-change-gate';

const tenant = asTenantContext('test-tenant');

function deps(opts: { flag: boolean; row: boolean | null | 'error' }): MemberChangeGateDeps & {
  readSettings: ReturnType<typeof vi.fn>;
} {
  const readSettings = vi.fn(async (_ctx: TenantContext) => {
    if (opts.row === 'error') return err({ code: 'repo.unexpected' as const });
    return ok(opts.row === null ? null : { memberChangeApprovalEnabled: opts.row });
  });
  return {
    flags: { memberChangeApproval: () => opts.flag },
    tenantMemberSettings: { readInTenant: readSettings },
    readSettings,
  };
}

describe('resolveMemberChangeGate', () => {
  it('flag OFF → immediate without reading the tenant row', async () => {
    const d = deps({ flag: false, row: true });
    const gate = makeMemberChangeGateResolver(d);
    await expect(gate.resolve(tenant)).resolves.toBe('immediate');
    expect(d.readSettings).not.toHaveBeenCalled();
  });

  it('flag ON + row absent → immediate (new-tenant default is off)', async () => {
    const gate = makeMemberChangeGateResolver(deps({ flag: true, row: null }));
    await expect(gate.resolve(tenant)).resolves.toBe('immediate');
  });

  it('flag ON + approval=false → immediate', async () => {
    const gate = makeMemberChangeGateResolver(deps({ flag: true, row: false }));
    await expect(gate.resolve(tenant)).resolves.toBe('immediate');
  });

  it('flag ON + approval=true → approval', async () => {
    const gate = makeMemberChangeGateResolver(deps({ flag: true, row: true }));
    await expect(gate.resolve(tenant)).resolves.toBe('approval');
  });

  it('caches per resolver instance (one row read per request)', async () => {
    const d = deps({ flag: true, row: true });
    const gate = makeMemberChangeGateResolver(d);
    await gate.resolve(tenant);
    await gate.resolve(tenant);
    expect(d.readSettings).toHaveBeenCalledTimes(1);
  });

  it('a settings read failure fails CLOSED to the immediate path? No — it fails LOUD (the caller decides)', async () => {
    const gate = makeMemberChangeGateResolver(deps({ flag: true, row: 'error' }));
    await expect(gate.resolve(tenant)).rejects.toThrow(/tenant_member_settings/);
  });
});
