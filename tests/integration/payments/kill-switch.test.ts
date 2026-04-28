/**
 * T134 — Per-tenant `onlinePaymentEnabled` kill-switch (FR-016 + SC-013).
 *
 * Spec authority: spec.md FR-016 + plan.md § VII (kill-switch surfaces).
 * Distinct from the env-var `FEATURE_F5_ONLINE_PAYMENT` (proxy.ts) which is
 * the platform-wide dark-ship flag. THIS test exercises the per-tenant
 * `tenant_payment_settings.online_payment_enabled` column which a SweCham
 * admin can toggle without redeploy.
 *
 * Asserts (lean variant — full E2E coverage in `tests/e2e/payment-*.spec.ts`):
 *
 *   (a) Domain `assertSettingsComplete` returns
 *       `online_payment_disabled` when the flag is false.
 *
 *   (b) Repo round-trips the toggle: insert with true → flip to false → flip
 *       back to true; each read reflects the current value.
 *
 *   (c) The `online_payment_toggled` audit event type exists and carries
 *       5-year retention per F5_AUDIT_RETENTION_YEARS map (data-model § 7.1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import {
  tenantPaymentSettings,
  type NewTenantPaymentSettingsRow,
} from '@/modules/payments/infrastructure/schema';
import {
  assertSettingsComplete,
  type TenantPaymentSettings,
} from '@/modules/payments/domain/tenant-payment-settings';
import { F5_AUDIT_RETENTION_YEARS } from '@/modules/payments/application/ports/audit-port';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('T134 per-tenant online_payment_enabled kill-switch', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenant = pair.a;
    const settings: NewTenantPaymentSettingsRow = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: `acct_test_${tenant.ctx.slug.slice(-8)}`,
      processorPublishableKey: `pk_test_${tenant.ctx.slug.slice(-8)}`,
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantPaymentSettings).values(settings);
    });
  });

  afterAll(async () => {
    if (!tenant) return;
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .delete(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));
    });
  });

  it('(a) assertSettingsComplete rejects with online_payment_disabled when flag is false', () => {
    const off: TenantPaymentSettings = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: 'acct_test_x',
      processorPublishableKey: 'pk_test_x',
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: false,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };
    const result = assertSettingsComplete(off);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('online_payment_disabled');
    }
  });

  it('(a) assertSettingsComplete passes when flag is true and other config valid', () => {
    const on: TenantPaymentSettings = {
      tenantId: tenant.ctx.slug,
      processor: 'stripe',
      processorEnvironment: 'test',
      processorAccountId: 'acct_test_x',
      processorPublishableKey: 'pk_test_x',
      enabledMethods: ['card', 'promptpay'],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    };
    const result = assertSettingsComplete(on);
    expect(result.ok).toBe(true);
  });

  it('(b) repo round-trips toggle: true → false → true', async () => {
    await runInTenant(tenant.ctx, async (tx) => {
      // Initial seed sets true; verify
      const [initial] = await tx
        .select({ enabled: tenantPaymentSettings.onlinePaymentEnabled })
        .from(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));
      expect(initial?.enabled).toBe(true);

      // Toggle off
      await tx
        .update(tenantPaymentSettings)
        .set({ onlinePaymentEnabled: false })
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));

      const [afterOff] = await tx
        .select({ enabled: tenantPaymentSettings.onlinePaymentEnabled })
        .from(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));
      expect(afterOff?.enabled).toBe(false);

      // Toggle back on
      await tx
        .update(tenantPaymentSettings)
        .set({ onlinePaymentEnabled: true })
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));

      const [afterOn] = await tx
        .select({ enabled: tenantPaymentSettings.onlinePaymentEnabled })
        .from(tenantPaymentSettings)
        .where(eq(tenantPaymentSettings.tenantId, tenant.ctx.slug));
      expect(afterOn?.enabled).toBe(true);
    });
  });

  it('(c) online_payment_toggled event_type carries 5-year retention', () => {
    expect(F5_AUDIT_RETENTION_YEARS['online_payment_toggled']).toBe(5);
    // Sibling: tenant_payment_settings_updated also 5y per data-model § 7.1
    expect(F5_AUDIT_RETENTION_YEARS['tenant_payment_settings_updated']).toBe(5);
  });
});
