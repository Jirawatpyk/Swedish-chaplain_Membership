/**
 * Application port — per-tenant member-number SETTINGS reader
 * (055-member-number, §4.3).
 *
 * Read-only in MVP: the prefix is seed-only + immutable after the first
 * member (design §2) — there is NO update method by design (the guard is
 * the absence of an UPDATE use-case, not a DB check). The reader runs at
 * DISPLAY time, never at allocation time, so it touches ONLY
 * `tenant_member_settings` and never the sequence table — keeping the
 * lock graph acyclic (design §5 lock-order discipline).
 */
import type { TenantTx } from '@/lib/db';
import type { TenantId } from '../../domain/member';

export interface MemberSettingsReaderPort {
  /**
   * Read the per-tenant member-number prefix (e.g. `'SCCM'`). Returns the
   * column DEFAULT `'M'` when no `tenant_member_settings` row exists for
   * the tenant — so a tenant provisioned before the settings seed still
   * renders a valid formatted number.
   */
  getPrefix(tx: TenantTx, tenantId: TenantId): Promise<string>;
}
