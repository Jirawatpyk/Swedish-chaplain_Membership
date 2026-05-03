/**
 * T039 spec — TenantRenewalSettings invariants + defaults.
 */
import { describe, expect, it } from 'vitest';
import {
  GRACE_PERIOD_DAYS_MIN,
  GRACE_PERIOD_DAYS_MAX,
  MIN_TENURE_DAYS_MIN,
  MIN_TENURE_DAYS_MAX,
  assertSettingsInvariants,
  defaultSettings,
  type TenantRenewalSettings,
} from '@/modules/renewals/domain/tenant-renewal-settings';

const NOW = new Date('2026-05-01T00:00:00Z');

function build(
  overrides: Partial<TenantRenewalSettings> = {},
): TenantRenewalSettings {
  return { ...defaultSettings('t', NOW), ...overrides };
}

describe('constants', () => {
  it('grace + min-tenure bounds', () => {
    expect(GRACE_PERIOD_DAYS_MIN).toBe(0);
    expect(GRACE_PERIOD_DAYS_MAX).toBe(90);
    expect(MIN_TENURE_DAYS_MIN).toBe(0);
    expect(MIN_TENURE_DAYS_MAX).toBe(365);
  });
});

describe('defaultSettings', () => {
  it('matches migration 0089 column defaults', () => {
    const s = defaultSettings('swecham', NOW);
    expect(s.tenantId).toBe('swecham');
    expect(s.gracePeriodDays).toBe(14);
    expect(s.autoUpgradeEnabled).toBe(true);
    expect(s.minTenureDaysForAtRisk).toBe(30);
    expect(s.dispatchCronEnabled).toBe(true);
    expect(s.replyToEmail).toBeNull();
    expect(s.replyToDisplayName).toBeNull();
    expect(s.createdAt).toBe(NOW.toISOString());
    expect(s.updatedAt).toBe(NOW.toISOString());
  });
});

describe('assertSettingsInvariants', () => {
  it('happy path', () => {
    expect(assertSettingsInvariants(build()).ok).toBe(true);
  });

  it('rejects grace_period_days <0 or >90', () => {
    expect(assertSettingsInvariants(build({ gracePeriodDays: -1 })).ok).toBe(
      false,
    );
    expect(assertSettingsInvariants(build({ gracePeriodDays: 91 })).ok).toBe(
      false,
    );
  });

  it('accepts grace_period_days at boundaries', () => {
    expect(assertSettingsInvariants(build({ gracePeriodDays: 0 })).ok).toBe(true);
    expect(assertSettingsInvariants(build({ gracePeriodDays: 90 })).ok).toBe(
      true,
    );
  });

  it('rejects min_tenure_days <0 or >365', () => {
    expect(
      assertSettingsInvariants(build({ minTenureDaysForAtRisk: -1 })).ok,
    ).toBe(false);
    expect(
      assertSettingsInvariants(build({ minTenureDaysForAtRisk: 366 })).ok,
    ).toBe(false);
  });

  it('accepts min_tenure_days at boundaries', () => {
    expect(
      assertSettingsInvariants(build({ minTenureDaysForAtRisk: 0 })).ok,
    ).toBe(true);
    expect(
      assertSettingsInvariants(build({ minTenureDaysForAtRisk: 365 })).ok,
    ).toBe(true);
  });
});
