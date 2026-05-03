/**
 * T039 (F8 Phase 2 Wave D) — `TenantRenewalSettings` Domain entity.
 *
 * Domain shape of `tenant_renewal_settings` (data-model.md § 2.3;
 * migration 0089). Per-tenant config singleton.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

export const GRACE_PERIOD_DAYS_MIN = 0;
export const GRACE_PERIOD_DAYS_MAX = 90;
export const MIN_TENURE_DAYS_MIN = 0;
export const MIN_TENURE_DAYS_MAX = 365;

export interface TenantRenewalSettings {
  readonly tenantId: string;
  /** Days a member can pay after expires_at before lapsing. 0–90. */
  readonly gracePeriodDays: number;
  /** Master toggle for tier-upgrade evaluation cron. */
  readonly autoUpgradeEnabled: boolean;
  /** Min-tenure gate for at-risk scoring (FR-029). 0–365. */
  readonly minTenureDaysForAtRisk: number;
  /** Master toggle for the dispatcher cron itself. */
  readonly dispatchCronEnabled: boolean;
  readonly replyToEmail: string | null;
  readonly replyToDisplayName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SettingsInvariantError =
  | { readonly kind: 'grace_period_out_of_range'; readonly days: number }
  | { readonly kind: 'min_tenure_out_of_range'; readonly days: number };

export function assertSettingsInvariants(
  s: TenantRenewalSettings,
): Result<void, SettingsInvariantError> {
  if (
    s.gracePeriodDays < GRACE_PERIOD_DAYS_MIN ||
    s.gracePeriodDays > GRACE_PERIOD_DAYS_MAX
  ) {
    return err({
      kind: 'grace_period_out_of_range',
      days: s.gracePeriodDays,
    });
  }
  if (
    s.minTenureDaysForAtRisk < MIN_TENURE_DAYS_MIN ||
    s.minTenureDaysForAtRisk > MIN_TENURE_DAYS_MAX
  ) {
    return err({
      kind: 'min_tenure_out_of_range',
      days: s.minTenureDaysForAtRisk,
    });
  }
  return ok(undefined);
}

/** Per-tenant default factory (matches migration 0089 column defaults). */
export function defaultSettings(tenantId: string, now: Date): TenantRenewalSettings {
  const ts = now.toISOString();
  return {
    tenantId,
    gracePeriodDays: 14,
    autoUpgradeEnabled: true,
    minTenureDaysForAtRisk: 30,
    dispatchCronEnabled: true,
    replyToEmail: null,
    replyToDisplayName: null,
    createdAt: ts,
    updatedAt: ts,
  };
}
