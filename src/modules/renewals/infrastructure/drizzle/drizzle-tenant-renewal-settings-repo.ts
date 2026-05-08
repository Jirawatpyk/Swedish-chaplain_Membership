/**
 * F8 Phase 5 wave K24 · T115a — Drizzle adapter for
 * `TenantRenewalSettingsRepo`.
 *
 * Wires the read + upsert surface against the
 * `tenant_renewal_settings` table (data-model.md § 2.3, migration 0089).
 * Created at K24 to back the new `lapseCyclesOnGraceExpiry` cron
 * (T115a Phase-5-deferred branch wiring) which needs to read
 * `grace_period_days` to compute the lapse-eligibility cutoff.
 *
 * Tenant scope: every method runs inside `runInTenant` so
 * `app.current_tenant` GUC is set and RLS+FORCE applies. Cross-tenant
 * reads return null (RLS hides the row); cross-tenant upserts fail
 * the WITH CHECK clause and throw at the DB.
 */
import { eq } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import type {
  TenantRenewalSettingsRepo,
  UpdateTenantRenewalSettingsInput,
} from '../../application/ports/tenant-renewal-settings-repo';
import type { TenantRenewalSettings } from '../../domain/tenant-renewal-settings';
import {
  tenantRenewalSettings,
  type TenantRenewalSettingsRow,
} from '../schema-tenant-renewal-config';

function rowToDomain(row: TenantRenewalSettingsRow): TenantRenewalSettings {
  return {
    tenantId: row.tenantId,
    gracePeriodDays: row.gracePeriodDays,
    autoUpgradeEnabled: row.autoUpgradeEnabled,
    minTenureDaysForAtRisk: row.minTenureDaysForAtRisk,
    dispatchCronEnabled: row.dispatchCronEnabled,
    replyToEmail: row.replyToEmail,
    replyToDisplayName: row.replyToDisplayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function makeDrizzleTenantRenewalSettingsRepo(
  ctx: TenantContext,
): TenantRenewalSettingsRepo {
  return {
    async findByTenant(
      tenantId: string,
    ): Promise<TenantRenewalSettings | null> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(tenantRenewalSettings)
          .where(eq(tenantRenewalSettings.tenantId, tenantId))
          .limit(1);
        const row = rows[0];
        return row ? rowToDomain(row) : null;
      });
    },

    async upsert(
      tx: TenantTx,
      tenantId: string,
      input: UpdateTenantRenewalSettingsInput,
    ): Promise<TenantRenewalSettings> {
      const now = new Date();
      const insertValues = {
        tenantId,
        ...(input.gracePeriodDays !== undefined
          ? { gracePeriodDays: input.gracePeriodDays }
          : {}),
        ...(input.autoUpgradeEnabled !== undefined
          ? { autoUpgradeEnabled: input.autoUpgradeEnabled }
          : {}),
        ...(input.minTenureDaysForAtRisk !== undefined
          ? { minTenureDaysForAtRisk: input.minTenureDaysForAtRisk }
          : {}),
        ...(input.dispatchCronEnabled !== undefined
          ? { dispatchCronEnabled: input.dispatchCronEnabled }
          : {}),
        ...(input.replyToEmail !== undefined
          ? { replyToEmail: input.replyToEmail }
          : {}),
        ...(input.replyToDisplayName !== undefined
          ? { replyToDisplayName: input.replyToDisplayName }
          : {}),
        updatedAt: now,
      };
      const updateValues = {
        ...(input.gracePeriodDays !== undefined
          ? { gracePeriodDays: input.gracePeriodDays }
          : {}),
        ...(input.autoUpgradeEnabled !== undefined
          ? { autoUpgradeEnabled: input.autoUpgradeEnabled }
          : {}),
        ...(input.minTenureDaysForAtRisk !== undefined
          ? { minTenureDaysForAtRisk: input.minTenureDaysForAtRisk }
          : {}),
        ...(input.dispatchCronEnabled !== undefined
          ? { dispatchCronEnabled: input.dispatchCronEnabled }
          : {}),
        ...(input.replyToEmail !== undefined
          ? { replyToEmail: input.replyToEmail }
          : {}),
        ...(input.replyToDisplayName !== undefined
          ? { replyToDisplayName: input.replyToDisplayName }
          : {}),
        updatedAt: now,
      };
      const rows = await tx
        .insert(tenantRenewalSettings)
        .values(insertValues)
        .onConflictDoUpdate({
          target: tenantRenewalSettings.tenantId,
          set: updateValues,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error(
          `[drizzleTenantRenewalSettingsRepo] upsert returned no rows for tenant ${tenantId}`,
        );
      }
      return rowToDomain(row);
    },
  };
}
