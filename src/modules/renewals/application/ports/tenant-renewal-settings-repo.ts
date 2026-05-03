/**
 * T045 (F8 Phase 2 Wave E) — `TenantRenewalSettingsRepo` Application port.
 *
 * Singleton-per-tenant config repository over `tenant_renewal_settings`
 * (Wave C migration 0089). Adapter caches read-side per-tenant state
 * since this row is mutated rarely (admin config screen only).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantRenewalSettings } from '../../domain/tenant-renewal-settings';

export interface UpdateTenantRenewalSettingsInput {
  readonly gracePeriodDays?: number;
  readonly autoUpgradeEnabled?: boolean;
  readonly minTenureDaysForAtRisk?: number;
  readonly dispatchCronEnabled?: boolean;
  readonly replyToEmail?: string | null;
  readonly replyToDisplayName?: string | null;
}

export interface TenantRenewalSettingsRepo {
  /**
   * Find the settings row for the tenant. Returns null when the
   * tenant has no settings row yet (pre-onboarding state). Use-case
   * layer can fall back to `defaultSettings()` from the Domain.
   */
  findByTenant(tenantId: string): Promise<TenantRenewalSettings | null>;

  /**
   * Upsert — insert when missing, update when present. Returns the
   * row post-mutation. Used by tenant onboarding + the admin config
   * screen.
   */
  upsert(
    tx: unknown,
    tenantId: string,
    input: UpdateTenantRenewalSettingsInput,
  ): Promise<TenantRenewalSettings>;
}
