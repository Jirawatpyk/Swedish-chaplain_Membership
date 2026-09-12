/**
 * F114 — the gate resolver (FR-031 / FR-039, research R11).
 *
 *   platform flag `FEATURE_MEMBER_CHANGE_APPROVAL` ∧ tenant setting
 *   `member_change_approval_enabled`  →  'approval'
 *   anything else                      →  'immediate' (the F3 path, byte-identical)
 *
 * Flag first, then setting: with the flag OFF the tenant row is never read,
 * so the dark-ship path costs no query. The flag reaches the Application
 * layer through a `FlagPort` (no `env` import here — Principle III); the row
 * through `TenantMemberChangeSettingsPort`.
 *
 * One resolver per request: the first `resolve(tenant)` reads the row and the
 * answer is cached for that resolver, so the edit page, the gate route and the
 * narrowed profile PATCH each pay one read.
 *
 * A settings read failure THROWS rather than guessing a mode. Guessing
 * 'immediate' would let a Group B edit bypass the gate on a transient DB
 * error; guessing 'approval' would refuse a legitimate immediate save under a
 * tenant that never switched it on. The caller (a route) maps the throw to a
 * 500 with its own `errorId`.
 */
import type { TenantContext } from '@/modules/tenants';
import type { TenantMemberChangeSettingsPort } from '../../ports/tenant-member-change-settings-port';

export type MemberChangeGate = 'immediate' | 'approval';

export interface MemberChangeFlagPort {
  /** `FEATURE_MEMBER_CHANGE_APPROVAL` (default false). */
  memberChangeApproval(): boolean;
}

export type MemberChangeGateDeps = {
  readonly flags: MemberChangeFlagPort;
  readonly tenantMemberSettings: Pick<TenantMemberChangeSettingsPort, 'readInTenant'>;
};

export interface MemberChangeGateResolver {
  resolve(tenant: TenantContext): Promise<MemberChangeGate>;
}

export function makeMemberChangeGateResolver(deps: MemberChangeGateDeps): MemberChangeGateResolver {
  const cache = new Map<string, Promise<MemberChangeGate>>();
  return {
    resolve(tenant) {
      if (!deps.flags.memberChangeApproval()) return Promise.resolve('immediate');
      const cached = cache.get(tenant.slug);
      if (cached) return cached;
      const pending = (async (): Promise<MemberChangeGate> => {
        const row = await deps.tenantMemberSettings.readInTenant(tenant);
        if (!row.ok) {
          throw new Error(`resolveMemberChangeGate: tenant_member_settings read failed (${row.error.code})`);
        }
        return row.value?.memberChangeApprovalEnabled === true ? 'approval' : 'immediate';
      })();
      cache.set(tenant.slug, pending);
      return pending;
    },
  };
}

/** One-shot convenience for callers that resolve exactly once. */
export async function resolveMemberChangeGate(
  deps: MemberChangeGateDeps,
  tenant: TenantContext,
): Promise<MemberChangeGate> {
  return makeMemberChangeGateResolver(deps).resolve(tenant);
}
