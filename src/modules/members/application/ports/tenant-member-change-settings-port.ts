/**
 * F114 FR-031 / research R11 — the per-tenant approval switch, one boolean
 * column on `tenant_member_settings` (`member_change_approval_enabled`,
 * migration 0300). Kept apart from `MemberSettingsReaderPort` (the 055
 * member-number prefix reader) so that port's many test doubles stay
 * untouched and the two concerns cannot be confused at a call site.
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { TenantId } from '../../domain/member';
import type { RepoError } from './member-repo';

export type TenantMemberChangeSettings = {
  readonly memberChangeApprovalEnabled: boolean;
};

export interface TenantMemberChangeSettingsPort {
  /** The tenant's row, or `null` when none exists yet (a new tenant: approval OFF). */
  readInTenant(ctx: TenantContext): Promise<Result<TenantMemberChangeSettings | null, RepoError>>;

  /**
   * Upsert the switch inside the caller's tx (US6 `setMemberChangeApprovalEnabled`).
   * Returns the PREVIOUS value so the caller can audit `{ previous, next }` and
   * no-op on an unchanged value.
   */
  setApprovalEnabledInTx(
    tx: TenantTx,
    tenantId: TenantId,
    enabled: boolean,
  ): Promise<Result<{ readonly previous: boolean }, RepoError>>;
}
